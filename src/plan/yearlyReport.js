// Monthly and yearly performance reports — fetch fills from HL, send to Telegram.
// generateMonthlyReport: called by cron on 1st of each month + /monthly command.
// generateYearlyReport: called by /yearly command.

export async function generateMonthlyReport(year, month) {
  // Default: previous calendar month
  const now = new Date();
  if (year == null || month == null) {
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1; // 1-based
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  async function sendTelegram(text) {
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4096),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  }

  const monthStr = String(month).padStart(2, '0');
  const label = `${year}-${monthStr}`;
  const monthStart = `${label}-01`;
  // Last day of month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${label}-${String(lastDay).padStart(2, '0')}`;

  console.log(`[monthly] generating report for ${label}`);

  const { getHLAllFills, getHLBalance } = await import('../broker/hyperliquid.js');

  const [fills, balance] = await Promise.all([
    getHLAllFills(process.env.HL_COIN || 'PAXG').catch(() => []),
    getHLBalance().catch(() => ({ balance: 0 })),
  ]);

  // Filter to target month only
  const monthFills = fills.filter(f => {
    const day = f.time.slice(0, 10);
    return day >= monthStart && day <= monthEnd;
  });

  const openFills = monthFills.filter(f => f.isOpen);
  const closeFills = monthFills.filter(f => f.isClose);

  const totalGross = closeFills.reduce((s, f) => s + f.closedPnl, 0);
  const totalFees = monthFills.reduce((s, f) => s + f.fee, 0);
  const netPnl = totalGross - totalFees;
  const wins = closeFills.filter(f => f.closedPnl > 0).length;
  const losses = closeFills.filter(f => f.closedPnl <= 0).length;
  const winRate = closeFills.length > 0
    ? ((wins / closeFills.length) * 100).toFixed(1)
    : '0.0';
  const avgWin = wins > 0
    ? (closeFills.filter(f => f.closedPnl > 0).reduce((s, f) => s + f.closedPnl, 0) / wins).toFixed(2)
    : '0.00';
  const avgLoss = losses > 0
    ? (closeFills.filter(f => f.closedPnl <= 0).reduce((s, f) => s + f.closedPnl, 0) / losses).toFixed(2)
    : '0.00';
  const bestTrade = closeFills.length > 0
    ? Math.max(...closeFills.map(f => f.closedPnl)).toFixed(2)
    : '0.00';
  const worstTrade = closeFills.length > 0
    ? Math.min(...closeFills.map(f => f.closedPnl)).toFixed(2)
    : '0.00';

  // Breakdown by Monday-Sunday UTC week
  const byWeek = {};
  for (const fill of monthFills) {
    const d = new Date(fill.time);
    const day = d.getUTCDay();
    const daysFromMon = day === 0 ? 6 : day - 1;
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - daysFromMon);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekKey = weekStart.toISOString().slice(0, 10);
    if (!byWeek[weekKey]) byWeek[weekKey] = { fills: [], pnl: 0, fees: 0, wins: 0, closes: 0 };
    byWeek[weekKey].fills.push(fill);
    byWeek[weekKey].fees += fill.fee;
    if (fill.isClose) {
      byWeek[weekKey].pnl += fill.closedPnl;
      byWeek[weekKey].closes++;
      if (fill.closedPnl > 0) byWeek[weekKey].wins++;
    }
  }

  const pnlEmoji = netPnl >= 0 ? '✅' : '❌';
  const monthName = new Date(Date.UTC(year, month - 1, 1))
    .toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

  const lines = [
    `📊 <b>Monthly Report — ${monthName} ${year}</b>`,
    '',
    `Balance: $${balance.balance.toFixed(2)} USDC`,
    '',
    `<b>📈 Trade Summary</b>`,
    `Trades opened: ${openFills.length}`,
    `Trades closed: ${closeFills.length}`,
    `Wins: ${wins} | Losses: ${losses}`,
    `Win rate: ${winRate}%`,
    '',
    `<b>${pnlEmoji} P&amp;L</b>`,
    `Gross: ${totalGross >= 0 ? '+' : ''}$${totalGross.toFixed(2)}`,
    `Fees paid: -$${totalFees.toFixed(3)}`,
    `Net: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`,
    '',
    `<b>📐 Trade Stats</b>`,
    `Avg win: +$${avgWin}`,
    `Avg loss: $${avgLoss}`,
    `Best trade: +$${bestTrade}`,
    `Worst trade: $${worstTrade}`,
  ];

  if (Object.keys(byWeek).length > 0) {
    lines.push('', '<b>By week:</b>');
    let weekNum = 1;
    for (const [weekStartKey, data] of Object.entries(byWeek).sort()) {
      const net = data.pnl - data.fees;
      const wr = data.closes > 0
        ? ((data.wins / data.closes) * 100).toFixed(0) : 0;
      const pnlEmoji = net >= 0 ? '✅' : '❌';
      lines.push(
        `${pnlEmoji} W${weekNum} (${weekStartKey.slice(5)}): ` +
        `${net >= 0 ? '+' : ''}$${net.toFixed(2)} | ${data.closes} closes | ${wr}% WR`
      );
      weekNum++;
    }
  }

  if (closeFills.length === 0) {
    lines.push('', '📭 No closed trades this month.');
  }

  lines.push('', `<i>Generated ${now.toISOString().slice(0, 16)} UTC</i>`);

  const msg = lines.join('\n');
  await sendTelegram(msg);
  console.log(`[monthly] report sent for ${label}: ${closeFills.length} closes, net=${netPnl.toFixed(2)}`);
  return { label, closeFills: closeFills.length, netPnl };
}

export async function generateYearlyReport(year) {
  const now = new Date();
  if (year == null) year = now.getUTCFullYear();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  async function sendTelegram(text) {
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4096),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  }

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  console.log(`[yearly] generating report for ${year}`);

  const { getHLAllFills, getHLBalance } = await import('../broker/hyperliquid.js');

  const [fills, balance] = await Promise.all([
    getHLAllFills(process.env.HL_COIN || 'PAXG').catch(() => []),
    getHLBalance().catch(() => ({ balance: 0 })),
  ]);

  // Filter to target year only
  const yearFills = fills.filter(f => {
    const day = f.time.slice(0, 10);
    return day >= yearStart && day <= yearEnd;
  });

  const openFills = yearFills.filter(f => f.isOpen);
  const closeFills = yearFills.filter(f => f.isClose);

  const totalGross = closeFills.reduce((s, f) => s + f.closedPnl, 0);
  const totalFees = yearFills.reduce((s, f) => s + f.fee, 0);
  const netPnl = totalGross - totalFees;
  const wins = closeFills.filter(f => f.closedPnl > 0).length;
  const losses = closeFills.filter(f => f.closedPnl <= 0).length;
  const winRate = closeFills.length > 0
    ? ((wins / closeFills.length) * 100).toFixed(1)
    : '0.0';

  // Monthly breakdown — include fees from all fills, not just close fills
  const byMonth = {};
  for (const fill of yearFills) {
    const d = new Date(fill.time);
    const key = d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0');
    if (!byMonth[key]) {
      byMonth[key] = { pnl: 0, fees: 0, closes: 0, wins: 0, losses: 0 };
    }
    byMonth[key].fees += fill.fee;
    if (fill.isClose) {
      byMonth[key].pnl += fill.closedPnl;
      byMonth[key].closes++;
      if (fill.closedPnl > 0) byMonth[key].wins++;
      else byMonth[key].losses++;
    }
  }

  const monthlyNet = Object.entries(byMonth).map(([month, d]) => ({
    month,
    net: d.pnl - d.fees,
    gross: d.pnl,
    fees: d.fees,
    wins: d.wins,
    losses: d.losses,
    closes: d.closes,
  })).sort((a, b) => a.month.localeCompare(b.month));

  const bestMonth = monthlyNet.length > 0
    ? monthlyNet.reduce((best, m) => m.net > best.net ? m : best, monthlyNet[0])
    : null;
  const worstMonth = monthlyNet.length > 0
    ? monthlyNet.reduce((worst, m) => m.net < worst.net ? m : worst, monthlyNet[0])
    : null;

  const ytdPct = balance.balance > 0
    ? ((netPnl / (balance.balance - netPnl)) * 100).toFixed(2)
    : '0.00';

  const pnlEmoji = netPnl >= 0 ? '✅' : '❌';

  const lines = [
    `📅 <b>Yearly Report — ${year}</b>`,
    '',
    `Balance: $${balance.balance.toFixed(2)} USDC`,
    '',
    `<b>📈 YTD Summary</b>`,
    `Trades opened: ${openFills.length}`,
    `Trades closed: ${closeFills.length}`,
    `Wins: ${wins} | Losses: ${losses}`,
    `Win rate: ${winRate}%`,
    '',
    `<b>${pnlEmoji} P&amp;L</b>`,
    `Gross P&amp;L: ${totalGross >= 0 ? '+' : ''}$${totalGross.toFixed(2)}`,
    `Fees paid: -$${totalFees.toFixed(2)}`,
    `Net P&amp;L: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} (${ytdPct >= 0 ? '+' : ''}${ytdPct}% YTD)`,
  ];

  if (bestMonth) {
    lines.push('');
    lines.push(`Best month: ${bestMonth.month} (${bestMonth.net >= 0 ? '+' : ''}$${bestMonth.net.toFixed(2)} net)`);
    lines.push(`Worst month: ${worstMonth.month} (${worstMonth.net >= 0 ? '+' : ''}$${worstMonth.net.toFixed(2)} net)`);
  }

  if (monthlyNet.length > 0) {
    lines.push('', '<b>By month:</b>');
    for (const m of monthlyNet) {
      const emoji = m.net >= 0 ? '✅' : '❌';
      const wr = m.closes > 0
        ? ((m.wins / m.closes) * 100).toFixed(0) : 0;
      lines.push(
        `${emoji} ${m.month}: ${m.net >= 0 ? '+' : ''}$${m.net.toFixed(2)} net` +
        ` | gross: ${m.gross >= 0 ? '+' : ''}$${m.gross.toFixed(2)}` +
        ` | fees: -$${m.fees.toFixed(2)}` +
        ` | ${m.wins}W/${m.losses}L (${wr}%)`
      );
    }
  }

  if (closeFills.length === 0) {
    lines.push('', '📭 No closed trades this year.');
  }

  lines.push('', `<i>Generated ${now.toISOString().slice(0, 16)} UTC</i>`);

  const msg = lines.join('\n');
  await sendTelegram(msg);
  console.log(`[yearly] report sent for ${year}: ${closeFills.length} closes, net=${netPnl.toFixed(2)}`);
  return { year, closeFills: closeFills.length, netPnl };
}
