// Telegram bot command handlers for Hyperliquid XAU/USDC perpetual agent.
import fs from 'node:fs/promises';
import path from 'node:path';

const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const PLANS_DIR = path.resolve('plans');

async function tgSend(text, parseMode = 'HTML') {
  const url = `${TG_BASE}/sendMessage`;
  console.log(`[bot] tgSend → chat_id=${process.env.TELEGRAM_CHAT_ID} len=${text.length}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: text.slice(0, 4096),
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    console.error(`[bot] tgSend FAILED HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    throw new Error(`Telegram ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  console.log(`[bot] tgSend OK message_id=${json.result?.message_id}`);
  return json;
}

async function loadMostRecentPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(PLANS_DIR, today);
  try {
    const files = (await fs.readdir(dir)).filter(f => /^\d{2}\.json$/.test(f)).sort();
    if (!files.length) return null;
    const raw = await fs.readFile(path.join(dir, files[files.length - 1]), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleHelp() {
  await tgSend(
    `<b>📖 XAUUSD Agent Commands</b>\n\n` +
    `<b>Market</b>\n` +
    `/price — Live XAU mark price &amp; funding\n` +
    `/funding — Funding rate detail &amp; sentiment signal\n` +
    `/news — Upcoming calendar events\n\n` +
    `<b>Plans</b>\n` +
    `/status — Current plan, M15 &amp; execution\n` +
    `/lastplan — Most recent trading plan\n` +
    `/confluence — Confluence factors\n` +
    `/analyze — Trigger a full pipeline run\n\n` +
    `<b>Account</b>\n` +
    `/balance — Hyperliquid account balance\n` +
    `/positions — Open positions\n` +
    `/today — Today's executed trades\n` +
    `/performance — Daily performance stats\n\n` +
    `<b>System</b>\n` +
    `/risk — Risk rules &amp; state\n` +
    `/settings — Agent configuration\n\n` +
    `<b>AI</b>\n` +
    `/ask &lt;question&gt; — Chat with Claude\n\n` +
    `<i>Or just type a question — I'll answer it.</i>`
  );
}

async function handlePrice() {
  try {
    const { fetchHLMarketData } = await import('../data/hyperliquid.js');
    const data = await fetchHLMarketData('XAU');
    const fundingPct = `${data.funding >= 0 ? '+' : ''}${(data.funding * 100).toFixed(4)}%/hr`;
    const fundingSignal = data.funding > 0.0001 ? '⚠ crowded long' : data.funding < -0.0001 ? '⚠ crowded short' : '✅ balanced';

    await tgSend(
      `<b>🥇 XAU/USDC (Hyperliquid)</b>\n\n` +
      `Mark: <b>$${data.markPrice.toFixed(2)}</b>\n` +
      `Oracle: $${data.oraclePrice.toFixed(2)}  Gap: ${data.spread.toFixed(2)}pts\n` +
      `Funding: ${fundingPct} ${fundingSignal}\n` +
      `Open Interest: ${data.openInterest.toFixed(1)} XAU\n` +
      `Status: <code>${data.marketStatus}</code>\n` +
      `<i>${new Date().toUTCString()}</i>`
    );
  } catch (err) {
    await tgSend(`⚠️ Price fetch failed: ${err.message}`);
  }
}

async function handleFunding() {
  try {
    const { fetchHLMarketData, getFundingSignal } = await import('../data/hyperliquid.js');
    const data = await fetchHLMarketData('XAU');
    const signal = getFundingSignal(data.funding);

    await tgSend(
      `💰 <b>XAU Funding Rate</b>\n\n` +
      `Rate: ${(data.funding * 100).toFixed(4)}%/hr\n` +
      `Annualized: ${data.fundingAnnualized.toFixed(1)}%/yr\n` +
      `Signal: ${signal.fundingNote}\n` +
      `Long/Short: ${signal.longPct}% / ${signal.shortPct}%\n\n` +
      `${data.funding > 0.0001 ? '⚠️ Longs paying — market overcrowded long' :
         data.funding < -0.0001 ? '⚠️ Shorts paying — contrarian bullish' :
         '✅ Balanced — no extreme positioning'}\n` +
      `<i>${new Date().toUTCString()}</i>`
    );
  } catch (err) {
    await tgSend(`⚠️ Funding fetch failed: ${err.message}`);
  }
}

async function handleStatus() {
  const plan = await loadMostRecentPlan();
  if (!plan) {
    await tgSend('📋 No plan found for today yet. Runs at :05 every hour.');
    return;
  }

  const biasEmoji = { bullish: '🟢', bearish: '🔴', neutral: '⚪' }[plan.bias] ?? '⚪';
  const m15 = plan.m15 ?? { status: 'N/A', reason: 'not evaluated' };
  const exec = plan.execution ?? {};

  const lines = [
    `<b>${biasEmoji} Status — ${plan.symbol}</b>`,
    `<i>${plan.timestamp}</i>`,
    '',
    `Bias: <b>${(plan.bias ?? 'UNKNOWN').toUpperCase()}</b> | Quality: <b>${plan.setupQuality}</b>`,
    `Direction: <b>${plan.direction?.toUpperCase() ?? 'NO TRADE'}</b>`,
    `Confluence: ${plan.confluenceCount} factors`,
  ];

  if (plan.consensus) {
    const c = plan.consensus;
    lines.push(`Consensus: ${c.agreement} (${c.confidence})`);
  }

  lines.push('');
  const m15icon = m15.status === 'CONFIRMED' ? '✅' : m15.status === 'PENDING' ? '⏳' : '⏸';
  lines.push(`<b>${m15icon} M15:</b> ${m15.status} — ${m15.reason ?? ''}`);

  if (exec.autoTradeEnabled) {
    if (exec.executed) {
      lines.push(`<b>🚀 Executed:</b> ${exec.orderId ?? 'n/a'} | ${exec.size} XAU | $${exec.riskAmount} risk`);
    } else {
      lines.push(`<b>⏸ Not executed:</b> ${exec.reason}`);
    }
  } else {
    lines.push(`<b>Auto-trade:</b> disabled (signal only)`);
  }

  await tgSend(lines.join('\n'));
}

async function handleLastPlan() {
  const plan = await loadMostRecentPlan();
  if (!plan) {
    await tgSend('📋 No plan found for today.');
    return;
  }

  const esc = s => s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const biasEmoji = { bullish: '🟢', bearish: '🔴', neutral: '⚪' }[plan.bias] ?? '⚪';
  const lines = [
    `<b>${biasEmoji} Last Plan — ${plan.symbol}</b>`,
    `<i>${plan.timestamp}</i>`,
    '',
    `<b>Bias:</b> ${plan.bias} | <b>Quality:</b> ${plan.setupQuality}`,
    `<b>Macro:</b> ${(plan.macroContext ?? 'n/a').slice(0, 200)}`,
    '',
  ];

  if (plan.direction && plan.entry && plan.stopLoss) {
    lines.push(`<b>Direction:</b> ${plan.direction.toUpperCase()}`);
    lines.push(`<b>Entry:</b> $${plan.entry.price?.toFixed(2) ?? 'n/a'} (${plan.entry.trigger})`);
    lines.push(`<b>SL:</b> $${plan.stopLoss.price?.toFixed(2) ?? 'n/a'}`);
    if (plan.takeProfits?.length) {
      const tps = plan.takeProfits
        .map((tp, i) => `TP${i + 1} $${tp.price?.toFixed(2)} (${tp.rr?.toFixed(1)}R)`)
        .join(' | ');
      lines.push(`<b>TPs:</b> ${tps}`);
    }
  } else {
    lines.push('<b>⏸ No trade signal.</b>');
  }

  if (plan.consensus) {
    const c = plan.consensus;
    lines.push('');
    lines.push(`<b>Consensus:</b> ${c.agreement} (${c.confidence}) — Claude: ${esc(c.claudeDirection ?? 'n/a')} / DeepSeek: ${esc(c.deepseekDirection ?? 'n/a')}`);
  }

  await tgSend(lines.join('\n'));
}

async function handleConfluence() {
  const plan = await loadMostRecentPlan();
  if (!plan) {
    await tgSend('📋 No plan found for today.');
    return;
  }

  const lines = [
    `<b>🔍 Confluence — ${plan.symbol}</b>`,
    `Count: <b>${plan.confluenceCount}</b> factors`,
    '',
  ];

  if (plan.confluenceFactors?.length) {
    for (const f of plan.confluenceFactors) lines.push(`  ✅ ${f}`);
  } else {
    lines.push('No factors recorded.');
  }

  await tgSend(lines.join('\n'));
}

async function handleBalance() {
  try {
    const { getHLBalance } = await import('../broker/hyperliquid.js');
    const { balance, available, unrealizedPnl } = await getHLBalance();
    const equity = balance + unrealizedPnl;

    await tgSend(
      `<b>💰 Hyperliquid Balance</b>\n\n` +
      `Account Value: <b>$${balance.toFixed(2)}</b>\n` +
      `Equity: $${equity.toFixed(2)}\n` +
      `Available: $${available.toFixed(2)}\n` +
      `Unrealized P/L: ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}\n` +
      `Currency: USDC\n` +
      `<i>${new Date().toUTCString()}</i>`
    );
  } catch (err) {
    await tgSend(`⚠️ Balance fetch failed: ${err.message}`);
  }
}

async function handlePositions() {
  try {
    const { getHLPositions } = await import('../broker/hyperliquid.js');
    const positions = await getHLPositions();

    if (!positions.length) {
      await tgSend('📭 No open positions.');
      return;
    }

    const lines = [`<b>📊 Open Positions (${positions.length})</b>`, ''];
    for (const pos of positions) {
      const dirIcon = pos.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const pnl = pos.unrealizedPnl != null
        ? `${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)}`
        : 'n/a';
      lines.push(`${dirIcon} ${pos.coin}/USDC`);
      lines.push(`  Size: ${pos.size} XAU | Entry: $${pos.entryPrice?.toFixed(2) ?? 'n/a'}`);
      lines.push(`  Leverage: ${pos.leverage}x`);
      lines.push(`  P/L: <b>${pnl}</b>`);
      lines.push('');
    }
    await tgSend(lines.join('\n'));
  } catch (err) {
    await tgSend(`⚠️ Positions fetch failed: ${err.message}`);
  }
}

async function handleRisk() {
  const { RISK_RULES, readRiskState } = await import('../risk/manager.js');
  const state = await readRiskState();

  const mat = RISK_RULES.executionMatrix;
  const lines = [
    `<b>🛡 Risk Rules</b>`,
    '',
    `Max risk/trade: ${RISK_RULES.maxRiskPerTrade}%`,
    `Max daily loss: ${RISK_RULES.maxDailyLoss}%`,
    `Max weekly drawdown: ${RISK_RULES.maxWeeklyDrawdown}%`,
    `Max open positions: ${RISK_RULES.maxOpenPositions}`,
    `Max daily trades: ${RISK_RULES.maxDailyTrades}`,
    `Min RR: ${RISK_RULES.minRR}`,
    `Blocked sessions: off-hours (17:00-00:00 UTC)`,
    `Friday cutoff: ${RISK_RULES.fridayBlock}:00 UTC`,
    `News blackout: ${RISK_RULES.newsBlackout}m`,
    '',
    `<b>📊 Execution Matrix</b>`,
    `A+/A/B Tier 1: ${mat['A+'].tier1}% ✅`,
    `A+/A/B Tier 2: ${mat['A+'].tier2}% ✅`,
    `A+/A/B Tier 3: ${mat['A+'].tier3}% ✅`,
    `Any    Tier 4: ⛔ blocked`,
    '',
    `<b>📈 Current State</b>`,
    `Daily trades: ${state.dailyTrades}`,
    `Daily P/L: ${state.dailyPL >= 0 ? '+' : ''}${state.dailyPL}`,
    `Weekly P/L: ${state.weeklyPL >= 0 ? '+' : ''}${state.weeklyPL}`,
    state.cooldownUntil ? `⏸ Cooldown until: ${state.cooldownUntil}` : '✅ No active cooldown',
  ];

  await tgSend(lines.join('\n'));
}

async function handleToday() {
  const { getDailyTradeHistory } = await import('../risk/manager.js');
  const trades = await getDailyTradeHistory();

  if (!trades.length) {
    await tgSend('📭 No trades executed today.');
    return;
  }

  const lines = [`<b>📋 Today's Trades (${trades.length})</b>`, ''];
  for (const t of trades) {
    const dirIcon = t.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
    lines.push(`${dirIcon} @ $${(t.entry ?? 0).toFixed(2)}`);
    lines.push(`  Size: ${t.size} XAU | SL: $${(t.sl ?? 0).toFixed(2)} | TP1: $${(t.tp1 ?? 0).toFixed(2)}`);
    lines.push(`  Risk: $${t.riskAmount} (${t.riskPct}%)`);
    if (t.orderId) lines.push(`  Order: <code>${t.orderId}</code>`);
    if (t.timestamp) lines.push(`  <i>${t.timestamp}</i>`);
    lines.push('');
  }

  await tgSend(lines.join('\n'));
}

async function handlePerformance() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const summaryPath = path.join(PLANS_DIR, today, 'daily-summary.json');
    let summary = null;
    try {
      const raw = await fs.readFile(summaryPath, 'utf8');
      summary = JSON.parse(raw);
    } catch {}

    if (!summary) {
      await tgSend('📊 No performance summary available yet today.');
      return;
    }

    const { trades = 0, noTrades = 0, wins: w = {}, directions: dir = {}, dailyRR: rr = {} } = summary;
    const lines = [
      `<b>📊 Today's Performance</b>`,
      `<i>${today}</i>`,
      '',
      `Trades: ${trades} | No-trade: ${noTrades}`,
      `Wins: ${w.total ?? 0} | Losses: ${w.losses ?? 0} | Open: ${w.open ?? 0}`,
      `Win rate: ${w.winRate ?? 'n/a'}`,
      dir ? `Long: ${dir.long ?? 0} | Short: ${dir.short ?? 0}` : '',
      rr?.netRR != null ? `Net RR: ${rr.netRR >= 0 ? '+' : ''}${rr.netRR.toFixed(2)}R` : '',
    ].filter(Boolean);

    await tgSend(lines.join('\n'));
  } catch (err) {
    await tgSend(`⚠️ Performance data error: ${err.message}`);
  }
}

async function handleNews() {
  try {
    const { fetchCalendar } = await import('../data/calendar.js');
    const cal = await fetchCalendar();
    const events = (cal?.events || []).slice(0, 6);

    if (!events.length) {
      await tgSend('📅 No upcoming high-impact events in the next 24h.');
      return;
    }

    const lines = [`<b>📅 Upcoming Events</b>`, ''];
    for (const e of events) {
      const flag = e.goldRelevant ? '⚠️ ' : '';
      const mins = e.minutesAway != null ? `+${e.minutesAway}m` : 'soon';
      lines.push(`${flag}${mins} <b>${e.country}</b> ${e.title} (${e.impact})`);
    }

    if (cal?.warnings?.length) {
      lines.push('');
      for (const w of cal.warnings) lines.push(`⚠️ ${w}`);
    }

    await tgSend(lines.join('\n'));
  } catch (err) {
    await tgSend(`⚠️ Calendar unavailable: ${err.message}`);
  }
}

async function handleSettings() {
  await tgSend(
    `<b>⚙️ Agent Configuration</b>\n\n` +
    `Symbol: ${process.env.SYMBOL || 'XAU/USDC'}\n` +
    `Currency: ${process.env.CURRENCY || 'USDC'}\n` +
    `Execution TF: ${process.env.EXECUTION_TF || '15min'}\n` +
    `Bias TF: ${process.env.BIAS_TF || '4h'}\n` +
    `Candles lookback: ${process.env.CANDLES_LOOKBACK || '200'}\n` +
    `Default risk %: ${process.env.DEFAULT_RISK_PCT || '1'}\n` +
    `Default min RR: ${process.env.DEFAULT_RR_MIN || '2'}\n\n` +
    `Auto-trade: <b>${process.env.AUTO_TRADE === 'true' ? '✅ ENABLED' : '❌ DISABLED'}</b>\n` +
    `Dry-execute: <b>${process.env.DRY_EXECUTE !== 'false' ? 'YES (no real orders)' : '⚠️ LIVE ORDERS'}</b>\n` +
    `Broker: <b>Hyperliquid DEX</b>\n` +
    `Wallet: ${process.env.HL_WALLET_ADDRESS ? process.env.HL_WALLET_ADDRESS.slice(0, 10) + '...' : '❌ not set'}\n\n` +
    `LLM keys: ` +
    `Claude ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'} | ` +
    `DeepSeek ${process.env.DEEPSEEK_API_KEY ? '✅' : '❌'} | ` +
    `Perplexity ${process.env.PERPLEXITY_API_KEY ? '✅' : '❌'}\n\n` +
    `<b>Execution Matrix:</b>\n` +
    `A+/A/B Tier 1: 2.0% ✅\n` +
    `A+/A/B Tier 2: 1.5% ✅\n` +
    `A+/A/B Tier 3: 1.0% ✅\n` +
    `Any    Tier 4: ⛔ blocked`
  );
}

async function handleAsk(question) {
  if (!question?.trim()) {
    await tgSend('💬 Usage: /ask &lt;your question&gt;\nExample: /ask What is an order block?');
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await tgSend('⚠️ Claude not available (ANTHROPIC_API_KEY not configured).');
    return;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        temperature: 0.7,
        system:
          'You are a concise trading assistant for an XAU/USDC (Gold perpetual on Hyperliquid DEX) day trading agent. ' +
          'Answer questions about trading concepts, market structure, Smart Money Concepts, and Hyperliquid DEX briefly. ' +
          'Keep responses under 400 words. Use plain text — no markdown, no asterisks.',
        messages: [{ role: 'user', content: question }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Claude ${res.status}: ${text.slice(0, 100)}`);
    }

    const data = await res.json();
    const reply = data.content?.[0]?.text ?? 'No response.';
    await tgSend(`💬 <b>Claude:</b>\n\n${reply.slice(0, 3800)}`);
  } catch (err) {
    await tgSend(`⚠️ Ask failed: ${err.message}`);
  }
}

async function handleAnalyze() {
  await tgSend('⚠️ /analyze is coming soon.\n\nFor now, pipeline runs automatically at :05 every hour. Use /status to see the latest plan.');
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function routeCommand(command, args, _chatId) {
  const lower = command.toLowerCase();
  const fullText = args ? `${command} ${args}` : command;
  try {
    if (lower === '/help' || lower === '/start') return await handleHelp();
    if (lower === '/price') return await handlePrice();
    if (lower === '/funding') return await handleFunding();
    if (lower === '/status') return await handleStatus();
    if (lower === '/lastplan') return await handleLastPlan();
    if (lower === '/confluence') return await handleConfluence();
    if (lower === '/balance') return await handleBalance();
    if (lower === '/positions') return await handlePositions();
    if (lower === '/risk') return await handleRisk();
    if (lower === '/today') return await handleToday();
    if (lower === '/performance') return await handlePerformance();
    if (lower === '/news') return await handleNews();
    if (lower === '/settings') return await handleSettings();
    if (lower === '/analyze') return await handleAnalyze();
    if (lower === '/ask' && args) return await handleAsk(args);
    if (lower === '/ask') return await handleAsk('');
    if (!lower.startsWith('/')) return await handleAsk(fullText);
    await tgSend(`❓ Unknown command: <code>${command.slice(0, 50)}</code>\n\nType /help for available commands.`);
  } catch (err) {
    console.error(`[webhook] handler error for "${command}": ${err.message}`);
    await tgSend(`⚠️ Error: ${err.message.slice(0, 200)}`).catch(() => {});
  }
}

export async function processCommand(text, fromChatId) {
  const allowedChat = process.env.TELEGRAM_CHAT_ID;
  if (allowedChat && String(fromChatId) !== String(allowedChat)) {
    console.log(`[bot] ignored message from unauthorised chat ${fromChatId}`);
    return;
  }

  const trimmed = (text ?? '').trim();
  const lower = trimmed.toLowerCase();
  console.log(`[bot] received: ${trimmed.slice(0, 80)}`);

  try {
    if (lower === '/help' || lower === '/start') return await handleHelp();
    if (lower === '/price') return await handlePrice();
    if (lower === '/funding') return await handleFunding();
    if (lower === '/status') return await handleStatus();
    if (lower === '/lastplan') return await handleLastPlan();
    if (lower === '/confluence') return await handleConfluence();
    if (lower === '/balance') return await handleBalance();
    if (lower === '/positions') return await handlePositions();
    if (lower === '/risk') return await handleRisk();
    if (lower === '/today') return await handleToday();
    if (lower === '/performance') return await handlePerformance();
    if (lower === '/news') return await handleNews();
    if (lower === '/settings') return await handleSettings();
    if (lower === '/analyze') return await handleAnalyze();
    if (lower.startsWith('/ask ')) return await handleAsk(trimmed.slice(5));
    if (lower === '/ask') return await handleAsk('');

    if (trimmed && !trimmed.startsWith('/')) return await handleAsk(trimmed);

    await tgSend(`❓ Unknown command: <code>${trimmed.slice(0, 50)}</code>\n\nType /help for available commands.`);
  } catch (err) {
    console.error(`[bot] handler error for "${trimmed.slice(0, 40)}": ${err.message}`);
    await tgSend(`⚠️ Error: ${err.message.slice(0, 200)}`).catch(() => {});
  }
}
