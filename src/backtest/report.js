import { sendTelegramMessage } from '../telegram/notify.js';

function pad(s, n) { return String(s).padEnd(n); }
function rj(s, n) { return String(s).padStart(n); }
function fmtR(v) { return (v >= 0 ? '+' : '') + v + 'R'; }

function bestSession(bySession) {
  const tradeable = bySession.filter(s => s.trades > 0);
  if (!tradeable.length) return null;
  return tradeable.slice().sort((a, b) => b.netRR - a.netRR)[0];
}

function worstDay(byDay) {
  const tradeable = byDay.filter(d => d.trades > 0);
  if (!tradeable.length) return null;
  return tradeable.slice().sort((a, b) => parseFloat(a.winRate) - parseFloat(b.winRate))[0];
}

function buildInsights(stats) {
  const insights = [];
  const best = bestSession(stats.bySession);
  if (best && best.trades >= 5) {
    insights.push(`${best.session.charAt(0).toUpperCase() + best.session.slice(1)} session is your edge: ${best.winRate} WR, ${best.avgRR}R avg`);
  }
  const aPlus = stats.byQuality.find(q => q.quality === 'A+');
  const b = stats.byQuality.find(q => q.quality === 'B');
  if (aPlus && b && aPlus.trades >= 3 && b.trades >= 3) {
    insights.push(`A+ setups: ${aPlus.winRate} WR vs B at ${b.winRate} — quality filter matters`);
  }
  const worst = worstDay(stats.byDay);
  if (worst && worst.trades >= 5 && parseFloat(worst.winRate) < 50) {
    insights.push(`${worst.day} trades underperform (${worst.winRate}) — consider skipping`);
  }
  if (stats.overall.expectancy > 0) {
    insights.push(`Expectancy ${fmtR(stats.overall.expectancy)} means every trade is +EV`);
  } else if (stats.overall.totalTrades > 0) {
    insights.push(`Expectancy ${fmtR(stats.overall.expectancy)} — strategy is losing on average`);
  }
  return insights;
}

export function buildConsoleReport(stats) {
  const o = stats.overall;
  const period = stats.period;
  const insights = buildInsights(stats);

  const fmtPeriod = (s) => s ? s.slice(0, 10) : 'n/a';

  const lines = [];
  lines.push('════════════════════════════════════════════════');
  lines.push(' XAU/AUD BACKTEST REPORT');
  lines.push(` ${fmtPeriod(period.from)} → ${fmtPeriod(period.to)}`);
  lines.push('════════════════════════════════════════════════');
  lines.push(` Total candles scanned: ${period.totalCandlesScanned}`);
  lines.push(` Signals generated:     ${o.totalTrades + o.expired}`);
  lines.push(` Trades taken:          ${o.totalTrades} (B+ quality)`);
  lines.push(` Skipped (no-trade):    ${o.skipped}`);
  lines.push(` Expired (no SL/TP hit): ${o.expired}`);
  lines.push('');
  lines.push(' 📊 OVERALL PERFORMANCE');
  lines.push(` Win rate:      ${o.winRate}  (${o.wins}W / ${o.losses}L)`);
  lines.push(` Net RR:        ${fmtR(o.totalNetRR)}`);
  lines.push(` Avg win:       +${o.avgWinRR}R`);
  lines.push(` Avg loss:      ${o.avgLossRR}R`);
  lines.push(` Expectancy:    ${fmtR(o.expectancy)} per trade`);
  lines.push(` Profit factor: ${o.profitFactor}x`);
  lines.push(` Max win streak:    ${o.maxWinStreak}`);
  lines.push(` Max loss streak:   ${o.maxLossStreak}`);
  lines.push('');
  lines.push(' 🏆 BY SETUP QUALITY');
  for (const q of stats.byQuality) {
    lines.push(` ${pad(q.quality, 3)} ${rj(q.trades, 4)} trades  ${rj(q.winRate, 6)} WR  ${rj(q.avgRR, 6)}R avg  ${rj(fmtR(q.netRR), 8)} net`);
  }
  lines.push('');
  lines.push(' 🕐 BY SESSION');
  const bestSess = bestSession(stats.bySession);
  for (const s of stats.bySession) {
    const tag = s === bestSess ? ' ⭐ BEST' : '';
    lines.push(` ${pad(s.session, 7)} ${rj(s.trades, 4)} trades  ${rj(s.winRate, 6)} WR  ${rj(s.avgRR, 6)}R avg  ${rj(fmtR(s.netRR), 8)} net${tag}`);
  }
  lines.push('');
  lines.push(' 📅 BY DAY');
  const worstD = worstDay(stats.byDay);
  for (const d of stats.byDay) {
    const tag = d === worstD ? ' ⚠ weakest' : '';
    lines.push(` ${pad(d.day, 10)} ${rj(d.winRate, 6)} WR  ${rj(d.trades, 4)} trades  ${rj(fmtR(d.netRR), 8)} net${tag}`);
  }
  lines.push('');
  lines.push(' 🎯 TP DISTRIBUTION');
  const totalWins = o.wins;
  const tpPct = (n) => totalWins ? ` (${((n / totalWins) * 100).toFixed(0)}%)` : '';
  lines.push(` TP1 hits: ${o.tpDistribution.TP1}${tpPct(o.tpDistribution.TP1)}`);
  lines.push(` TP2 hits: ${o.tpDistribution.TP2}${tpPct(o.tpDistribution.TP2)}`);
  lines.push(` TP3 hits: ${o.tpDistribution.TP3}${tpPct(o.tpDistribution.TP3)}`);

  if (insights.length) {
    lines.push('');
    lines.push(' 💡 INSIGHTS');
    for (const ins of insights) lines.push(` → ${ins}`);
  }
  lines.push('════════════════════════════════════════════════');
  return lines.join('\n');
}

export function buildTelegramReport(stats) {
  const o = stats.overall;
  const period = stats.period;
  const insights = buildInsights(stats);
  const fmtPeriod = (s) => s ? s.slice(0, 10) : 'n/a';

  const lines = [];
  lines.push('📊 <b>XAU/AUD Backtest Report</b>');
  lines.push(`<i>${fmtPeriod(period.from)} → ${fmtPeriod(period.to)}</i>`);
  lines.push('');
  lines.push(`${o.totalTrades} trades · ${o.winRate} WR · ${fmtR(o.totalNetRR)} net`);
  lines.push(`Expectancy: ${fmtR(o.expectancy)} · PF: ${o.profitFactor}x`);
  lines.push('');
  lines.push('<b>By Quality:</b>');
  for (const q of stats.byQuality) {
    if (q.trades > 0) lines.push(`${q.quality}: ${q.winRate} WR · ${q.avgRR}R avg (${q.trades})`);
  }
  lines.push('');
  const best = bestSession(stats.bySession);
  if (best) lines.push(`<b>Best Session:</b> ${best.session} ${best.winRate} WR ⭐`);
  const worst = worstDay(stats.byDay);
  if (worst && parseFloat(worst.winRate) < 60) {
    lines.push(`<b>Worst Day:</b> ${worst.day} ${worst.winRate} ⚠`);
  }
  if (insights.length) {
    lines.push('');
    lines.push(`💡 ${insights[0]}`);
  }
  return lines.join('\n');
}

export async function publishReport(stats, { sendTelegram = true } = {}) {
  const consoleText = buildConsoleReport(stats);
  console.log('\n' + consoleText + '\n');

  if (sendTelegram) {
    const tg = buildTelegramReport(stats);
    await sendTelegramMessage(tg);
  }
}
