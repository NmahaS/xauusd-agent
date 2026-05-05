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
    `📖 <b>XAUUSD Agent Commands</b>\n\n` +
    `<b>📊 Market:</b>\n` +
    `/price — Live PAXG mark price + funding\n` +
    `/funding — Funding rate detail + sentiment\n` +
    `/news — Upcoming economic events\n\n` +
    `<b>📈 Analysis:</b>\n` +
    `/status — Current plan + M15 + execution status\n` +
    `/lastplan — Most recent trading plan\n` +
    `/confluence — Live M15 confluence score\n` +
    `/analyze — Trigger full pipeline run NOW\n\n` +
    `<b>💰 Account:</b>\n` +
    `/balance — Hyperliquid account balance\n` +
    `/positions — Open positions + PnL\n` +
    `/today — Today's executed trades\n` +
    `/performance — Daily performance stats\n\n` +
    `<b>⚙️ System:</b>\n` +
    `/risk — Risk rules + current limits\n` +
    `/settings — Agent configuration\n\n` +
    `<b>💬 AI:</b>\n` +
    `/ask [question] — Chat with Claude\n` +
    `<i>Or just type any question directly</i>`
  );
}

async function handlePrice() {
  try {
    const coin = process.env.HL_COIN || 'PAXG';
    const { fetchAllHLData, getFundingSignal } = await import('../data/hyperliquid.js');
    const data = await fetchAllHLData();
    const sentiment = getFundingSignal(data.funding);
    await tgSend(
      `💰 <b>${coin}/USDC Live</b>\n\n` +
      `Price: <b>$${data.currentPrice.toFixed(2)}</b>\n` +
      `Oracle: $${data.oraclePrice.toFixed(2)}\n` +
      `24h High: $${data.dailyHigh?.toFixed(2) || 'N/A'}\n` +
      `24h Low: $${data.dailyLow?.toFixed(2) || 'N/A'}\n\n` +
      `Funding: ${(data.funding * 100).toFixed(4)}%/hr\n` +
      `Signal: ${sentiment.fundingNote}\n` +
      `Open Interest: ${data.openInterest?.toFixed(2)} ${coin}\n` +
      `<i>${new Date().toUTCString()}</i>`
    );
  } catch (err) {
    await tgSend(`⚠️ Price fetch failed: ${err.message}`);
  }
}

async function handleFunding() {
  try {
    const coin = process.env.HL_COIN || 'PAXG';
    const { fetchHLMarketData, getFundingSignal } = await import('../data/hyperliquid.js');
    const data = await fetchHLMarketData(coin);
    const signal = getFundingSignal(data.funding);
    const annualized = (data.funding * 24 * 365 * 100).toFixed(2);
    await tgSend(
      `💸 <b>${coin} Funding Rate</b>\n\n` +
      `Current: ${(data.funding * 100).toFixed(4)}%/hr\n` +
      `Annualized: ${annualized}%/yr\n\n` +
      `${signal.fundingNote}\n\n` +
      `${data.funding > 0.0001 ? '🔴 Longs paying — overcrowded long\nContrarian: bearish signal' :
         data.funding < -0.0001 ? '🟢 Shorts paying — overcrowded short\nContrarian: bullish signal' :
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
  await tgSend('🔍 Computing live confluence...');
  try {
    const { fetchAllHLData } = await import('../data/hyperliquid.js');
    const { computeClassicalIndicators } = await import('../indicators/classical.js');
    const { detectSession } = await import('../indicators/session.js');
    const { analyzeStructure } = await import('../smc/structure.js');
    const { detectOrderBlocks } = await import('../smc/orderBlocks.js');
    const { detectFVGs } = await import('../smc/fvg.js');
    const { computePremiumDiscount } = await import('../smc/premiumDiscount.js');
    const { detectLiquidity } = await import('../smc/liquidity.js');
    const { computeConfluence } = await import('../plan/confluence.js');
    const { fetchFredMacro } = await import('../data/fred.js');
    const { fetchSentiment } = await import('../data/sentiment.js');
    const { fetchCalendar } = await import('../data/calendar.js');

    const [hlData, fred, sentiment, calendar] = await Promise.all([
      fetchAllHLData(),
      fetchFredMacro().catch(() => null),
      fetchSentiment().catch(() => null),
      fetchCalendar().catch(() => null),
    ]);

    const { h1Candles, h4Candles, m15Candles, currentPrice, dxy, igSentiment } = hlData;

    function smcFor(candles, n) {
      return {
        structure: analyzeStructure(candles, n),
        fvgs: detectFVGs(candles),
        orderBlocks: detectOrderBlocks(candles, n),
        liquidity: detectLiquidity(candles, n),
        pd: computePremiumDiscount(candles, n),
      };
    }

    const h1Indicators = computeClassicalIndicators(h1Candles);
    const h4Indicators = computeClassicalIndicators(h4Candles);
    const m15Indicators = m15Candles.length >= 14 ? computeClassicalIndicators(m15Candles) : null;
    const smcH1 = smcFor(h1Candles, 5);
    const smcH4 = smcFor(h4Candles, 3);
    const smcM15 = m15Candles.length >= 10 ? smcFor(m15Candles, 3) : null;
    const session = detectSession();

    const conf = computeConfluence({
      currentPrice,
      h1Indicators, h4Indicators, m15Indicators,
      smcH1, smcH4, smcM15,
      session, dxy, fred, sentiment, calendar, igSentiment,
    });

    let msg = `🎯 <b>Live Confluence</b>\n\n`;
    msg += `Score: <b>${conf.count}/12</b> — Grade: <b>${conf.grade}</b>\n`;
    msg += `H4 bias: ${smcH4.structure.bias}\n`;
    msg += `M15 bias: ${smcM15?.structure?.bias ?? 'n/a'}\n`;
    msg += `Price: $${currentPrice?.toFixed(2)} | ${smcM15?.pd?.zone ?? smcH1?.pd?.zone ?? 'n/a'}\n\n`;

    if (conf.factors?.length > 0) {
      msg += `✅ <b>Active factors:</b>\n`;
      for (const f of conf.factors) msg += `  • ${f}\n`;
    } else {
      msg += `❌ No confluence factors active\n`;
    }
    msg += `\n${session.inKillZone ? '🔥 Kill zone active!' : '⏳ Outside kill zone'}`;
    await tgSend(msg);
  } catch (err) {
    await tgSend(`❌ Confluence failed: ${err.message.slice(0, 200)}`);
  }
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
    `All grades Tier 1: ${mat['A+'].tier1}% ✅`,
    `All grades Tier 2: ${mat['A+'].tier2}% ✅`,
    `All grades Tier 3: ${mat['A+'].tier3}% ✅`,
    `All grades Tier 4: ${mat['A+'].tier4}% ✅ (conflicted — caution)`,
    '',
    `<b>Hard blocks (safety only):</b>`,
    `Off session (17-00 UTC): ⛔`,
    `Friday after 15:00 UTC: ⛔`,
    `News within 30 min: ⛔`,
    `Daily loss &gt;6%: ⛔`,
    `Weekly DD &gt;15%: ⛔`,
    `Positions full (2/2): ⛔`,
    `Trades full (6/day): ⛔`,
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
    `All grades Tier 1: 2.0% ✅\n` +
    `All grades Tier 2: 1.5% ✅\n` +
    `All grades Tier 3: 1.0% ✅\n` +
    `All grades Tier 4: 0.5% ✅ (conflicted — caution)`
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
  await tgSend('🔍 Running full analysis... (30-60 seconds)');
  try {
    const { runPipeline } = await import('../pipeline.js');
    await runPipeline();
    await tgSend('✅ Analysis complete — check the plan above.');
  } catch (err) {
    await tgSend(`❌ Analysis failed: ${err.message.slice(0, 200)}`);
  }
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
