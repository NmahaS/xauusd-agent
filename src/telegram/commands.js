// Telegram bot command handlers. Only TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are
// required. IG / LLM keys are optional — each handler degrades gracefully if missing.
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

// Opens a fresh IG session using process.env directly (not config.js) so the bot
// can work when only TELEGRAM keys are in the full schema.
async function openIGSession() {
  const key = process.env.IG_API_KEY;
  const username = process.env.IG_USERNAME;
  const password = process.env.IG_PASSWORD;
  if (!key || !username || !password) return null;

  const isDemo = process.env.IG_DEMO !== 'false';
  const base = isDemo
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  try {
    const res = await fetch(`${base}/session`, {
      method: 'POST',
      headers: {
        'X-IG-API-KEY': key,
        'Content-Type': 'application/json',
        Accept: 'application/json; charset=UTF-8',
        Version: '2',
      },
      body: JSON.stringify({ identifier: username, password }),
    });
    if (!res.ok) return null;
    const cst = res.headers.get('CST');
    const xst = res.headers.get('X-SECURITY-TOKEN');
    if (!cst || !xst) return null;
    return { cst, xst, base };
  } catch {
    return null;
  }
}

async function igGet(sess, p, version = 1) {
  const res = await fetch(`${sess.base}${p}`, {
    headers: {
      'X-IG-API-KEY': process.env.IG_API_KEY,
      CST: sess.cst,
      'X-SECURITY-TOKEN': sess.xst,
      Accept: 'application/json; charset=UTF-8',
      Version: String(version),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IG GET ${p} HTTP ${res.status}: ${body.slice(0, 150)}`);
  }
  return res.json();
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleHelp() {
  await tgSend(
    `<b>📖 XAUUSD Agent Commands</b>\n\n` +
    `/price — Live gold price &amp; spread\n` +
    `/status — Current plan, M15 &amp; execution\n` +
    `/lastplan — Most recent trading plan\n` +
    `/confluence — Confluence factors\n` +
    `/balance — IG account balance\n` +
    `/positions — Open positions\n` +
    `/risk — Risk rules &amp; state\n` +
    `/today — Today's executed trades\n` +
    `/performance — Daily performance stats\n` +
    `/news — Upcoming calendar events\n` +
    `/settings — Agent configuration\n` +
    `/ask &lt;question&gt; — Chat with Claude\n\n` +
    `<i>Or just type a question — I'll answer it.</i>`
  );
}

async function handlePrice() {
  const sess = await openIGSession();
  if (!sess) {
    await tgSend('⚠️ IG session unavailable — IG credentials not configured.');
    return;
  }
  try {
    const epic = 'MT.D.GC.FWS2.IP';
    const data = await igGet(sess, `/markets/${epic}`, 3);
    const snap = data.snapshot ?? {};
    const bid = Number(snap.bid ?? 0);
    const offer = Number(snap.offer ?? 0);
    const midVal = bid && offer ? ((bid + offer) / 2).toFixed(2) : 'n/a';
    const spread = bid && offer ? (offer - bid).toFixed(2) : 'n/a';
    const high = snap.high != null ? Number(snap.high).toFixed(2) : 'n/a';
    const low = snap.low != null ? Number(snap.low).toFixed(2) : 'n/a';

    await tgSend(
      `<b>🥇 Gold Price (${epic})</b>\n\n` +
      `Mid: <b>A$${midVal}</b>\n` +
      `Bid: A$${snap.bid ?? 'n/a'} | Ask: A$${snap.offer ?? 'n/a'}\n` +
      `Spread: ${spread} pts\n` +
      `High: A$${high} | Low: A$${low}\n` +
      `Status: <code>${snap.marketStatus ?? 'UNKNOWN'}</code>\n` +
      `<i>${new Date().toUTCString()}</i>`
    );
  } catch (err) {
    await tgSend(`⚠️ Price fetch failed: ${err.message}`);
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
      lines.push(`<b>🚀 Executed:</b> ${exec.dealId ?? 'n/a'} | ${exec.size} lots | A$${exec.riskAmount} risk`);
    } else {
      lines.push(`<b>⏸ Not executed:</b> ${exec.reason}`);
    }
  } else {
    lines.push(`<b>Auto-trade:</b> disabled (signal only)`);
  }

  // Cache health
  try {
    const { getCacheStats } = await import('../data/candleCache.js');
    const stats = getCacheStats();
    const goldH1 = stats.find(s => s.resolution === 'HOUR' && s.key.includes('GC'));
    const goldH4 = stats.find(s => s.resolution === 'HOUR_4');
    const m15Stat = stats.find(s => s.resolution === 'MINUTE_15');
    lines.push('');
    lines.push(`<b>📦 Cache</b>`);
    lines.push(`H1: ${goldH1 ? `${goldH1.count} candles (${goldH1.ageMinutes}m ago)` : '❌ empty — cold start on next run'}`);
    lines.push(`H4: ${goldH4 ? `${goldH4.count} candles (${goldH4.ageMinutes}m ago)` : '❌ empty'}`);
    lines.push(`M15: ${m15Stat ? `${m15Stat.count} candles (${m15Stat.ageMinutes}m ago)` : '❌ empty'}`);
  } catch {}

  await tgSend(lines.join('\n'));
}

async function handleLastPlan() {
  const plan = await loadMostRecentPlan();
  if (!plan) {
    await tgSend('📋 No plan found for today.');
    return;
  }

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
    lines.push(`<b>Entry:</b> A$${plan.entry.price?.toFixed(2) ?? 'n/a'} (${plan.entry.trigger})`);
    lines.push(`<b>SL:</b> A$${plan.stopLoss.price?.toFixed(2) ?? 'n/a'}`);
    if (plan.takeProfits?.length) {
      const tps = plan.takeProfits
        .map((tp, i) => `TP${i + 1} A$${tp.price?.toFixed(2)} (${tp.rr?.toFixed(1)}R)`)
        .join(' | ');
      lines.push(`<b>TPs:</b> ${tps}`);
    }
  } else {
    lines.push('<b>⏸ No trade signal.</b>');
  }

  if (plan.consensus) {
    const c = plan.consensus;
    lines.push('');
    lines.push(`<b>Consensus:</b> ${c.agreement} (${c.confidence}) — Claude: ${c.claudeDirection ?? 'n/a'} / DeepSeek: ${c.deepseekDirection ?? 'n/a'}`);
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
  const sess = await openIGSession();
  if (!sess) {
    await tgSend('⚠️ IG session unavailable.');
    return;
  }
  try {
    const accounts = await igGet(sess, '/accounts', 1);
    const wantId = process.env.IG_ACCOUNT_ID;
    const acct = wantId
      ? (accounts.accounts || []).find(a => a.accountId === wantId) || (accounts.accounts || [])[0]
      : (accounts.accounts || [])[0];
    if (!acct) { await tgSend('No IG account found.'); return; }

    const b = acct.balance ?? {};
    const balance = b.balance ?? 0;
    const pl = b.profitLoss ?? 0;
    const equity = balance + pl;

    await tgSend(
      `<b>💰 Account: ${acct.accountId}</b>\n\n` +
      `Balance: <b>A$${balance.toFixed(2)}</b>\n` +
      `Equity: A$${equity.toFixed(2)}\n` +
      `Available: A$${(b.available ?? 0).toFixed(2)}\n` +
      `Open P/L: ${pl >= 0 ? '+' : ''}A$${pl.toFixed(2)}\n` +
      `Type: ${acct.accountType ?? 'n/a'} | ${acct.currency ?? 'AUD'}\n` +
      `<i>${process.env.IG_DEMO === 'false' ? '🔴 LIVE account' : '🟡 DEMO account'}</i>`
    );
  } catch (err) {
    await tgSend(`⚠️ Balance fetch failed: ${err.message}`);
  }
}

async function handlePositions() {
  const sess = await openIGSession();
  if (!sess) {
    await tgSend('⚠️ IG session unavailable.');
    return;
  }
  try {
    const data = await igGet(sess, '/positions', 2);
    const positions = data.positions || [];
    if (!positions.length) { await tgSend('📭 No open positions.'); return; }

    const lines = [`<b>📊 Open Positions (${positions.length})</b>`, ''];
    for (const pos of positions) {
      const p = pos.position ?? {};
      const m = pos.market ?? {};
      const dirIcon = p.direction === 'BUY' ? '🟢 LONG' : '🔴 SHORT';
      const pl = p.profitLoss != null
        ? `${p.profitLoss >= 0 ? '+' : ''}A$${p.profitLoss.toFixed(2)}`
        : 'n/a';
      lines.push(`${dirIcon} ${m.instrumentName ?? m.epic ?? 'n/a'}`);
      lines.push(`  Size: ${p.size ?? p.contractSize ?? 'n/a'} | Level: ${p.level?.toFixed(2) ?? 'n/a'}`);
      lines.push(`  SL: ${p.stopLevel?.toFixed(2) ?? 'n/a'} | TP: ${p.limitLevel?.toFixed(2) ?? 'n/a'}`);
      lines.push(`  P/L: <b>${pl}</b>`);
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

  const lines = [
    `<b>🛡 Risk Rules</b>`,
    '',
    `Max risk/trade: ${RISK_RULES.maxRiskPerTrade}%`,
    `Max daily loss: ${RISK_RULES.maxDailyLoss}%`,
    `Max weekly drawdown: ${RISK_RULES.maxWeeklyDrawdown}%`,
    `Max open positions: ${RISK_RULES.maxOpenPositions}`,
    `Max daily trades: ${RISK_RULES.maxDailyTrades}`,
    `Min / Max lot: ${RISK_RULES.minLotSize} / ${RISK_RULES.maxLotSize}`,
    `Min RR: ${RISK_RULES.minRR}`,
    `Required quality: ${RISK_RULES.requiredQuality.join(', ')}`,
    `Required consensus: ${RISK_RULES.requiredConsensus.join(', ')}`,
    `Blocked sessions: ${RISK_RULES.blockedSessions.join(', ')}`,
    `Friday cutoff: ${RISK_RULES.fridayBlock}:00 UTC`,
    `News blackout: ${RISK_RULES.newsBlackout}m`,
    '',
    `<b>📊 Current State</b>`,
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
    lines.push(`${dirIcon} @ A$${(t.entry ?? 0).toFixed(2)}`);
    lines.push(`  Size: ${t.size} lots | SL: A$${(t.sl ?? 0).toFixed(2)} | TP1: A$${(t.tp1 ?? 0).toFixed(2)}`);
    lines.push(`  Risk: A$${t.riskAmount} (${t.riskPct}%)`);
    if (t.dealId) lines.push(`  Deal: <code>${t.dealId}</code>`);
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
    `Symbol: ${process.env.SYMBOL || 'XAU/AUD'}\n` +
    `Currency: ${process.env.CURRENCY || 'AUD'}\n` +
    `Execution TF: ${process.env.EXECUTION_TF || '1h'}\n` +
    `Bias TF: ${process.env.BIAS_TF || '4h'}\n` +
    `Candles lookback: ${process.env.CANDLES_LOOKBACK || '200'}\n` +
    `Default risk %: ${process.env.DEFAULT_RISK_PCT || '1'}\n` +
    `Default min RR: ${process.env.DEFAULT_RR_MIN || '2'}\n\n` +
    `Auto-trade: <b>${process.env.AUTO_TRADE === 'true' ? '✅ ENABLED' : '❌ DISABLED'}</b>\n` +
    `Dry-execute: <b>${process.env.DRY_EXECUTE !== 'false' ? 'YES (no real orders)' : '⚠️ LIVE ORDERS'}</b>\n` +
    `IG env: ${process.env.IG_DEMO === 'false' ? '🔴 LIVE' : '🟡 DEMO'}\n\n` +
    `LLM keys: ` +
    `Claude ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'} | ` +
    `DeepSeek ${process.env.DEEPSEEK_API_KEY ? '✅' : '❌'} | ` +
    `Perplexity ${process.env.PERPLEXITY_API_KEY ? '✅' : '❌'}`
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
          'You are a concise trading assistant for an XAUUSD (Gold/AUD futures) day trading agent. ' +
          'Answer questions about trading concepts, market structure, and Smart Money Concepts briefly. ' +
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

// ─── Router ───────────────────────────────────────────────────────────────────

// routeCommand: pure routing, no security check. Called by webhook.js (which
// already verified chatId) and internally by processCommand.
export async function routeCommand(command, args, _chatId) {
  const lower = command.toLowerCase();
  const fullText = args ? `${command} ${args}` : command;
  try {
    if (lower === '/help' || lower === '/start') return await handleHelp();
    if (lower === '/price') return await handlePrice();
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
    if (lower.startsWith('/ask ')) return await handleAsk(trimmed.slice(5));
    if (lower === '/ask') return await handleAsk('');

    // Free-form text → treat as /ask
    if (trimmed && !trimmed.startsWith('/')) return await handleAsk(trimmed);

    // Unknown slash command
    await tgSend(`❓ Unknown command: <code>${trimmed.slice(0, 50)}</code>\n\nType /help for available commands.`);
  } catch (err) {
    console.error(`[bot] handler error for "${trimmed.slice(0, 40)}": ${err.message}`);
    await tgSend(`⚠️ Error: ${err.message.slice(0, 200)}`).catch(() => {});
  }
}
