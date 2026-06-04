// Telegram bot command handlers for Hyperliquid XAU/USDC perpetual agent.
import fs from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const PLANS_DIR = path.join(process.cwd(), 'plans');

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

// Accept any .json that isn't a known non-plan file — handles 03.json, 3.json, 05-04.json
function isPlanFilename(f) {
  return f.endsWith('.json') &&
    f !== 'daily-summary.json' &&
    f !== 'trades.json' &&
    f !== '.gitkeep';
}

// Load all plans for today — returns { plans: [{file, plan, date}], today }
// plans are sorted most-recent-first. Uses sync fs so existsSync guard works correctly.
function findTodayPlans() {
  const today = new Date().toISOString().slice(0, 10);
  const planDir = path.join(process.cwd(), 'plans', today);
  console.log('[commands] looking for plans in:', planDir);
  console.log('[commands] dir exists:', existsSync(planDir));

  if (!existsSync(planDir)) {
    return { plans: [], planDir, today };
  }

  const allFiles = readdirSync(planDir);
  console.log('[commands] all files:', allFiles.join(', '));

  const planFiles = allFiles.filter(isPlanFilename).sort().reverse();
  console.log('[commands] plan files:', planFiles.join(', ') || 'none');

  const plans = [];
  for (const file of planFiles) {
    try {
      const plan = JSON.parse(readFileSync(path.join(planDir, file), 'utf8'));
      plans.push({ file, plan, date: today });
    } catch (e) {
      console.warn(`[commands] failed to parse ${file}: ${e.message}`);
    }
  }
  console.log('[commands] loaded plans:', plans.length);
  return { plans, planDir, today };
}

// Find most recent plan across last N days — returns { plan, date, file } or null
function findRecentPlans(daysBack = 3) {
  for (let i = 0; i < daysBack; i++) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const planDir = path.join(process.cwd(), 'plans', date);
    if (!existsSync(planDir)) continue;
    const files = readdirSync(planDir).filter(isPlanFilename).sort().reverse();
    if (files.length > 0) {
      try {
        const plan = JSON.parse(readFileSync(path.join(planDir, files[0]), 'utf8'));
        console.log(`[commands] found recent plan: ${date}/${files[0]}`);
        return { plan, date, file: files[0] };
      } catch {}
    }
  }
  return null;
}

// Load executed plans from today + yesterday (for position/status RR lookup)
async function loadTodayExecutedPlans() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const results = [];
  for (const date of [today, yesterday]) {
    const planDir = path.join(PLANS_DIR, date);
    try {
      const files = (await fs.readdir(planDir)).filter(isPlanFilename).sort();
      for (const file of files) {
        try {
          const plan = JSON.parse(await fs.readFile(path.join(planDir, file), 'utf8'));
          if (plan.execution?.executed === true) results.push({ plan, date, file });
        } catch {}
      }
    } catch {}
  }
  return results;
}

// Returns lines[] describing current RR vs plan levels — empty if insufficient data
function getRRInfo(plan, currentPrice) {
  const entry = plan.execution?.entry ?? plan.entry?.price;
  const sl = plan.stopLoss?.price;
  if (!entry || !sl || !currentPrice) return [];
  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return [];
  const currentMove = plan.direction === 'long'
    ? currentPrice - entry
    : entry - currentPrice;
  const currentRR = (currentMove / slDist).toFixed(2);
  const distToSL = Math.abs(currentPrice - sl).toFixed(0);
  const targetRR = parseFloat(process.env.TARGET_RR || '2.0');
  const autoTP = plan.direction === 'long'
    ? parseFloat(entry) + slDist * targetRR
    : parseFloat(entry) - slDist * targetRR;
  const distToTP = Math.abs(autoTP - currentPrice).toFixed(0);
  return [
    `   📐 Entry: $${parseFloat(entry).toFixed(2)}`,
    `   🎯 Current: ${currentMove >= 0 ? '+' : ''}${currentRR}R`,
    `   🛑 SL: $${parseFloat(sl).toFixed(2)} (${distToSL}pts away)`,
    `   🎯 TP: $${autoTP.toFixed(0)} (${distToTP}pts away, ${targetRR}R)`,
  ];
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
    `/today — Today's executed trades (/trade alias)\n` +
    `/performance — Daily performance stats\n\n` +
    `<b>⚙️ System:</b>\n` +
    `/risk — Risk rules + current limits\n` +
    `/quality — Live market condition check (ATR, spread, funding)\n` +
    `/goal — Weekly profit goal progress\n` +
    `/settings — Agent configuration\n` +
    `/monthly — Previous month P&amp;L report\n` +
    `/yearly — Year-to-date P&amp;L + monthly breakdown\n` +
    `/memory — Trade history database stats (RAG)\n` +
    `/spotbalance — Spot + perp balances + auto-transfer status\n` +
    `/deposited — Confirm deposit received\n` +
    `/test — Full system diagnostic\n` +
    `/debug — Filesystem debug (Railway plans dir)\n\n` +
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
  try {
    const { plans } = findTodayPlans();
    const { getHLPositions, getHLBalance } = await import('../broker/hyperliquid.js');

    const [positions, balance] = await Promise.all([
      getHLPositions().catch(() => []),
      getHLBalance().catch(() => ({ balance: 0, available: 0, unrealizedPnl: 0 })),
    ]);

    const latest = plans[0]?.plan ?? null;
    const autoTrade = process.env.AUTO_TRADE === 'true';
    const dry = process.env.DRY_EXECUTE === 'true';

    let msg = `📊 <b>Agent Status</b>\n`;
    msg += `${new Date().toUTCString()}\n\n`;

    msg += `💰 Balance: $${balance.balance.toFixed(2)} USDC\n`;
    msg += `Auto-trade: ${autoTrade ? '✅ ON' : '❌ OFF'}`;
    msg += ` | ${dry ? '🧪 DRY' : '⚠️ LIVE'}\n\n`;

    if (positions.length > 0) {
      msg += `📈 <b>Open Positions (${positions.length}):</b>\n`;
      for (const p of positions) {
        const emoji = p.direction === 'long' ? '🟢' : '🔴';
        const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';
        msg += `${emoji} ${p.direction.toUpperCase()} ${p.size} PAXG\n`;
        msg += `   Entry: $${(p.entryPrice ?? 0).toFixed(2)}`;
        msg += ` | P&amp;L: ${pnlSign}$${p.unrealizedPnl.toFixed(2)}\n`;
        if (p.liquidationPrice) msg += `   Liq: $${p.liquidationPrice.toFixed(2)}\n`;
        if (latest && latest.direction === p.direction) {
          const { fetchHLMarketData } = await import('../data/hyperliquid.js');
          const market = await fetchHLMarketData(process.env.HL_COIN || 'PAXG').catch(() => null);
          if (market?.currentPrice) {
            const rrLines = getRRInfo(latest, market.currentPrice);
            if (rrLines.length) msg += rrLines.join('\n') + '\n';
          }
        }
      }
      msg += '\n';
    } else {
      msg += `📭 No open positions\n\n`;
    }

    if (latest) {
      const biasEmoji = latest.bias === 'bullish' ? '🟢' : latest.bias === 'bearish' ? '🔴' : '⚪';
      msg += `${biasEmoji} <b>Latest Signal:</b>\n`;
      msg += `Bias: ${(latest.bias ?? 'unknown').toUpperCase()}`;
      msg += ` | Grade: ${latest.setupQuality ?? '?'}\n`;
      msg += `Direction: ${latest.direction?.toUpperCase() ?? 'NO TRADE'}\n`;
      msg += `Confluence: ${latest.confluenceCount ?? 0}/12\n`;
      if (latest.consensus?.agreement) msg += `Consensus: ${latest.consensus.agreement}\n`;
      if (latest.threeLayer?.tier) msg += `Tier: ${latest.threeLayer.tier}\n`;

      if (latest.execution?.executed) {
        msg += `\n🚀 Executed: ${latest.direction?.toUpperCase()}`;
        msg += ` @ $${parseFloat(latest.execution.entry || 0).toFixed(2)}\n`;
        if (latest.execution.orderId) msg += `Order: ${latest.execution.orderId}\n`;
      } else if (latest.execution?.reason) {
        msg += `\n⏸ Blocked: ${latest.execution.reason}\n`;
      }

      msg += `\nLast run: ${(latest.timestamp ?? '').slice(11, 16)} UTC\n`;
    } else {
      msg += `⏳ No plan yet today\nNext run: within 15 minutes\n`;
    }

    await tgSend(msg);
  } catch (err) {
    console.error('[commands] /status error:', err.message);
    await tgSend(`❌ Status error: ${err.message}`);
  }
}

async function handleLastPlan() {
  const recent = findRecentPlans(3);
  if (!recent) {
    await tgSend('📋 No recent plans found.');
    return;
  }
  const { formatPlanForTelegram } = await import('../plan/formatter.js');
  const msg = formatPlanForTelegram(recent.plan, {});
  await tgSend(msg);
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

    function splitByType(arr) {
      return {
        bullish: (arr || []).filter(o => o.type === 'bullish'),
        bearish: (arr || []).filter(o => o.type === 'bearish'),
      };
    }

    const conf = computeConfluence({
      currentPrice,
      h4: {
        structure: smcH4.structure,
        indicators: h4Indicators,
        pd: smcH4.pd,
        bias: smcH4.structure?.bias,
        orderBlocks: splitByType(smcH4.orderBlocks),
        fvgs: splitByType(smcH4.fvgs),
      },
      h1: {
        structure: smcH1.structure,
        indicators: h1Indicators,
        pd: smcH1.pd,
        orderBlocks: splitByType(smcH1.orderBlocks),
        fvgs: splitByType(smcH1.fvgs),
        liquidity: smcH1.liquidity,
      },
      m15: smcM15 ? {
        structure: smcM15.structure,
        indicators: m15Indicators,
        orderBlocks: splitByType(smcM15.orderBlocks),
        fvgs: splitByType(smcM15.fvgs),
        liquidity: smcM15.liquidity,
        pd: smcM15.pd,
      } : null,
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
    const { getHLPositions, getHLBalance, getHLTradeHistory } = await import('../broker/hyperliquid.js');
    const { fetchHLMarketData } = await import('../data/hyperliquid.js');
    const [positions, balance, market, recentFills] = await Promise.all([
      getHLPositions(),
      getHLBalance(),
      fetchHLMarketData(process.env.HL_COIN || 'PAXG').catch(() => null),
      getHLTradeHistory(process.env.HL_COIN || 'PAXG').catch(() => []),
    ]);

    if (!positions.length) {
      await tgSend('📭 No open positions.');
      return;
    }

    const currentPrice = market?.currentPrice ?? 0;
    const executedPlans = await loadTodayExecutedPlans();

    const totalPnl = balance.unrealizedPnl ?? 0;
    const lines = [
      `📊 <b>Open Positions</b>`,
      `Balance: $${balance.balance.toFixed(2)} USDC`,
      `Total unrealized P&amp;L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`,
      '',
    ];

    for (const p of positions) {
      const emoji = p.direction === 'long' ? '🟢' : '🔴';
      const pnlEmoji = p.unrealizedPnl >= 0 ? '✅' : '❌';
      const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';

      const posValue = (p.size * (p.entryPrice || currentPrice)).toFixed(2);
      lines.push(`${emoji} <b>${p.direction.toUpperCase()} ${p.size} PAXG</b> ($${posValue} notional)`);
      lines.push(`   Entry: $${(p.entryPrice || 0).toFixed(2)}`);
      lines.push(`   ${pnlEmoji} P&amp;L: ${pnlSign}$${p.unrealizedPnl.toFixed(2)} USDC`);
      if (currentPrice) lines.push(`   💹 Mark: $${currentPrice.toFixed(2)}`);

      // RR info from the most recent matching executed plan
      const matchPlan = executedPlans.find(({ plan }) => plan.direction === p.direction);
      if (matchPlan && currentPrice) {
        lines.push(...getRRInfo(matchPlan.plan, currentPrice));
      }

      // Liquidation distance
      const liqPrice = p.liquidationPrice ?? 0;
      if (liqPrice) {
        const liqDist = Math.abs(currentPrice - liqPrice).toFixed(0);
        const liqWarn = Math.abs(currentPrice - liqPrice) < 50 ? ' ⚠️' : '';
        lines.push(`   ⚡ Liq: $${liqPrice.toFixed(2)} (${liqDist}pts away)${liqWarn}`);
      }

      lines.push('');
    }

    if (recentFills.length > 0) {
      lines.push('<b>📜 Recent fills today:</b>');
      for (const f of recentFills.slice(-5)) {
        const time = f.time.slice(11, 16);
        lines.push(`${f.description} ${f.size} @ $${f.price.toFixed(2)} (${time} UTC)`);
      }
    }

    await tgSend(lines.join('\n'));
  } catch (err) {
    await tgSend(`❌ Positions failed: ${err.message}`);
  }
}

async function handleRisk() {
  const { RISK_RULES, readRiskState } = await import('../risk/manager.js');
  const state = await readRiskState();

  let msg = '<b>🛡 Risk Rules</b>\n\n';

  msg += '<b>Position limits:</b>\n';
  msg += `Max risk/trade: ${RISK_RULES.maxRiskPerTrade}%\n`;
  msg += `Max daily loss: ${RISK_RULES.maxDailyLoss}%\n`;
  msg += `Max weekly DD: ${RISK_RULES.maxWeeklyDrawdown}%\n`;
  msg += `Max positions: ${RISK_RULES.maxOpenPositions}\n`;
  msg += `Max position size: 0.25 PAXG (incl. compounds)\n`;
  msg += `Max daily trades: ${RISK_RULES.maxDailyTrades}\n`;
  msg += `SL range: 3-${RISK_RULES.maxSLDistance}pts\n\n`;

  msg += '<b>Session rules:</b>\n';
  msg += `Dead zone (00:00-06:00): T1-3 allowed if ATR≥7, confluence≥5, no open position\n`;
  msg += `Min ATR: ${RISK_RULES.minATR}pts\n`;
  msg += `Max spread: ${RISK_RULES.maxSpread}pts\n\n`;

  msg += '<b>Strategy rules:</b>\n';
  msg += `Counter-H1 trades: blocked ⛔ (H1 = primary; H4 context only)\n`;
  msg += `Min confluence: ${RISK_RULES.requiredConfluence}/12\n`;
  msg += `Blocked tiers: ${RISK_RULES.blockedTiers?.join(', ') || 'none'}\n`;
  msg += `TF alignment: required\n`;
  msg += `Entry style: GTC limit (cancel on direction change)\n\n`;

  msg += '<b>Hard blocks:</b>\n';
  msg += `Friday after 15:00 UTC ⛔\n`;
  msg += `News within 30min ⛔\n`;
  msg += `Daily loss &gt;${RISK_RULES.maxDailyLoss}% ⛔\n`;
  msg += `Weekly DD &gt;${RISK_RULES.maxWeeklyDrawdown}% ⛔\n\n`;

  msg += '<b>Current state:</b>\n';
  msg += `Daily trades: ${state.dailyTrades}/${RISK_RULES.maxDailyTrades}\n`;
  msg += `Daily P&amp;L: ${(state.dailyPL ?? 0) >= 0 ? '+' : ''}$${(state.dailyPL || 0).toFixed(2)}\n`;
  msg += `Weekly P&amp;L: ${(state.weeklyPL ?? 0) >= 0 ? '+' : ''}$${(state.weeklyPL || 0).toFixed(2)}\n\n`;

  msg += '<b>Weekly goal:</b>\n';
  const goalUSD = parseFloat(process.env.WEEKLY_GOAL_USD || '5');
  const rewardUSD = parseFloat(process.env.WEEKLY_GOAL_REWARD || '100');
  msg += `Target: +$${goalUSD.toFixed(2)} net\n`;
  msg += `Reward: Deposit $${rewardUSD} if hit\n`;

  await tgSend(msg);
}

async function handleToday() {
  try {
    const { getHLTradeHistory, getHLBalance, getHLPositions } =
      await import('../broker/hyperliquid.js');

    const [fills, balance, positions] = await Promise.all([
      getHLTradeHistory(process.env.HL_COIN || 'PAXG'),
      getHLBalance().catch(() => ({ balance: 0, unrealizedPnl: 0 })),
      getHLPositions().catch(() => []),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    let msg = `📊 <b>Today — ${today}</b>\n`;
    msg += `Balance: $${balance.balance.toFixed(2)} USDC\n\n`;

    if (fills.length === 0 && positions.length === 0) {
      msg += '📭 No trades today.';
      await tgSend(msg);
      return;
    }

    const openFills = fills.filter(f => f.isOpen);
    const closeFills = fills.filter(f => f.isClose);

    if (openFills.length > 0) {
      msg += `<b>📈 Trades Opened Today (${openFills.length}):</b>\n\n`;

      for (const fill of openFills) {
        const emoji = fill.direction === 'long' ? '🟢' : '🔴';
        const time = fill.time.slice(11, 16);

        msg += `${emoji} <b>${fill.direction.toUpperCase()} ${fill.size} PAXG</b>\n`;
        msg += `   Entry: $${fill.price.toFixed(2)} @ ${time} UTC\n`;
        msg += `   Order: ${fill.orderId}\n`;
        msg += `   Fee: $${fill.fee.toFixed(3)}\n`;

        const matchingClose = closeFills.find(c =>
          Math.abs(c.size - fill.size) < 0.001 && c.time > fill.time
        );

        if (matchingClose) {
          const pnl = matchingClose.closedPnl;
          const exitTime = matchingClose.time.slice(11, 16);
          msg += `   ${pnl >= 0 ? '✅' : '❌'} Closed @ $${matchingClose.price.toFixed(2)} (${exitTime} UTC)\n`;
          msg += `   P&amp;L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`;
        } else {
          const openPos = positions.find(p => p.direction === fill.direction);
          if (openPos) {
            const pnl = openPos.unrealizedPnl;
            msg += `   ${pnl >= 0 ? '✅' : '❌'} Open: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} unrealized\n`;
          } else {
            msg += `   ⏳ Status unknown\n`;
          }
        }
        msg += '\n';
      }
    }

    if (closeFills.length > 0) {
      const totalPnl = closeFills.reduce((s, f) => s + f.closedPnl, 0);
      const totalFees = fills.reduce((s, f) => s + f.fee, 0);
      const netPnl = totalPnl - totalFees;

      msg += `<b>📊 Day Summary:</b>\n`;
      msg += `Opened: ${openFills.length} | Closed: ${closeFills.length}\n`;
      msg += `Gross P&amp;L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n`;
      msg += `Fees: -$${totalFees.toFixed(3)}\n`;
      msg += `Net P&amp;L: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}\n`;
    }

    if (positions.length > 0) {
      msg += `\n<b>📍 Open Positions (${positions.length}):</b>\n`;
      for (const p of positions) {
        const emoji = p.direction === 'long' ? '🟢' : '🔴';
        const pnl = p.unrealizedPnl;
        msg += `${emoji} ${p.direction.toUpperCase()} ${p.size} PAXG @ $${p.entryPrice.toFixed(2)}\n`;
        msg += `   ${pnl >= 0 ? '✅' : '❌'} P&amp;L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`;
        if (p.liquidationPrice) msg += `   Liq: $${p.liquidationPrice.toFixed(2)}\n`;
      }
    }

    await tgSend(msg);
  } catch (err) {
    console.error('[commands] /today error:', err.message);
    await tgSend(`❌ Today failed: ${err.message}`);
  }
}

async function handlePerformance(args) {
  try {
    const { getHLFillsHistory, getHLBalance, getHLPositions } = await import('../broker/hyperliquid.js');
    const period = (args ?? '').trim().toLowerCase();
    const days = (period === 'week' || period === 'weekly') ? 7 : 1;

    // AEST (UTC+10) date for display label
    const aestDate = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const label = days === 7 ? 'This Week' : aestDate;

    const [fills, balance, positions] = await Promise.all([
      getHLFillsHistory(process.env.HL_COIN || 'PAXG', days),
      getHLBalance().catch(() => ({ balance: 0 })),
      getHLPositions().catch(() => []),
    ]);

    const closes = fills.filter(f => f.isClose);

    const grossPnl = closes.reduce((s, f) => s + f.closedPnl, 0);
    const totalFees = fills.reduce((s, f) => s + f.fee, 0);
    const netPnl = grossPnl - totalFees;
    const wins = closes.filter(f => f.closedPnl > 0).length;
    const losses = closes.filter(f => f.closedPnl <= 0).length;
    const winRate = closes.length > 0
      ? ((wins / closes.length) * 100).toFixed(0)
      : '0';

    let msg = `📊 <b>Performance — ${label}</b>\n`;
    msg += `Balance: $${balance.balance.toFixed(2)} USDC\n\n`;
    msg += `Trades closed today: ${closes.length}\n`;
    msg += `Currently open: ${positions.length}\n`;

    if (closes.length > 0) {
      msg += `Wins: ${wins} | Losses: ${losses} | WR: ${winRate}%\n\n`;
      msg += `Gross P&amp;L: ${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)}\n`;
      msg += `Fees: -$${totalFees.toFixed(3)}\n`;
      msg += `Net P&amp;L: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}\n`;
    } else {
      msg += `No closed trades yet\n`;
      if (totalFees > 0) msg += `Fees: -$${totalFees.toFixed(3)}\n`;
    }

    if (days === 7 && closes.length > 0) {
      const byDay = {};
      for (const f of closes) {
        const day = new Date(f.time.includes('T') ? f.time : new Date(f.time).toISOString()).toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { wins: 0, losses: 0 };
        if (f.closedPnl > 0) byDay[day].wins++;
        else byDay[day].losses++;
      }
      msg += `\n<b>By day (closed):</b>\n`;
      for (const [day, counts] of Object.entries(byDay).sort()) {
        msg += `${day.slice(5)}: ${counts.wins}W ${counts.losses}L\n`;
      }
    }

    if (closes.length === 0 && positions.length === 0) {
      msg += '\n📭 No fills in this period.';
    }

    await tgSend(msg);
  } catch (err) {
    await tgSend(`❌ Performance failed: ${err.message}`);
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
    await tgSend('💬 Usage: /ask &lt;your question&gt;\nExample: /ask Why was the last trade blocked?');
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await tgSend('⚠️ Claude not available (ANTHROPIC_API_KEY not configured).');
    return;
  }

  // Load today's plans for context
  const today = new Date().toISOString().slice(0, 10);
  let planSummaries = 'No plans today yet.';
  let recentBlocks = [];
  try {
    const dir = path.join(PLANS_DIR, today);
    const files = (await fs.readdir(dir).catch(() => []))
      .filter(isPlanFilename)
      .sort();
    const todayPlans = [];
    for (const f of files.slice(-6)) {
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        todayPlans.push(JSON.parse(raw));
      } catch {}
    }
    if (todayPlans.length) {
      planSummaries = todayPlans.map(p =>
        `${(p.timestamp ?? '').slice(11, 16)} UTC | ${p.bias ?? '?'} | ${p.setupQuality ?? '?'} | ` +
        `dir=${p.direction ?? 'none'} | confluence=${p.confluenceCount ?? 0} | ` +
        `m15=${p.m15?.status ?? 'N/A'} | ` +
        `exec=${p.execution?.executed ? 'YES' : 'NO'} (${(p.execution?.reason ?? '').slice(0, 60)})`
      ).join('\n');
      recentBlocks = todayPlans
        .filter(p => p.execution?.reason && !p.execution.executed)
        .map(p => `${(p.timestamp ?? '').slice(11, 16)}: ${p.execution.reason}`)
        .slice(-5);
    }
  } catch {}

  const systemPrompt =
    `You are the trading agent assistant for this specific PAXG/USDC system on Hyperliquid DEX.\n` +
    `Answer questions about THIS agent's specific decisions — be direct and precise.\n\n` +
    `Current agent state:\n` +
    `- Symbol: PAXG/USDC on Hyperliquid (gold perpetual)\n` +
    `- Strategy: SMC (Smart Money Concepts) with 3-layer analysis\n` +
    `- Timeframes: H4 bias, H1 context, M15 execution\n` +
    `- Auto-trade: ${process.env.AUTO_TRADE === 'true' ? 'ENABLED' : 'DISABLED'}\n` +
    `- Dry-execute: ${process.env.DRY_EXECUTE === 'true' ? 'YES (no real orders)' : 'NO (live orders)'}\n\n` +
    `Today's plans (${today}):\n${planSummaries}\n\n` +
    (recentBlocks.length ? `Recent blocking reasons:\n${recentBlocks.join('\n')}\n\n` : '') +
    `Answer the user's specific question about this agent's decisions. Max 150 words. Plain text only.`;

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
        temperature: 0.3,
        system: systemPrompt,
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

async function handleTest() {
  await tgSend('🧪 Running system test...');
  const results = [];

  // 1. PAXG price
  try {
    const { fetchHLMarketData } = await import('../data/hyperliquid.js');
    const data = await fetchHLMarketData(process.env.HL_COIN || 'PAXG');
    results.push(`✅ PAXG price: $${data.currentPrice.toFixed(2)}`);
  } catch (e) {
    results.push(`❌ PAXG data: ${e.message.slice(0, 80)}`);
  }

  // 2. Balance
  try {
    const { getHLBalance } = await import('../broker/hyperliquid.js');
    const b = await getHLBalance();
    results.push(`✅ Balance: $${b.balance.toFixed(2)} (available: $${b.available.toFixed(2)})`);
  } catch (e) {
    results.push(`❌ Balance: ${e.message.slice(0, 80)}`);
  }

  // 3. API wallet
  try {
    const { ethers } = await import('ethers');
    let pk = process.env.HL_PRIVATE_KEY || '';
    if (!pk.startsWith('0x')) pk = '0x' + pk;
    const wallet = new ethers.Wallet(pk);
    results.push(`✅ API wallet: <code>${wallet.address}</code>`);

    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: wallet.address }),
    });
    const data = await res.json();
    if (data.marginSummary !== undefined) {
      results.push(`✅ API wallet recognized on Hyperliquid`);
    } else {
      results.push(`❌ API wallet NOT recognized — go to app.hyperliquid.xyz → Settings → API Wallets → Authorize`);
    }
  } catch (e) {
    results.push(`❌ API wallet: ${e.message.slice(0, 80)}`);
  }

  // 4. Env flags
  results.push(`${process.env.AUTO_TRADE === 'true' ? '✅' : '❌'} AUTO_TRADE=${process.env.AUTO_TRADE}`);
  results.push(`${process.env.DRY_EXECUTE === 'false' ? '✅' : '⚠️'} DRY_EXECUTE=${process.env.DRY_EXECUTE}`);

  // 5. Claude
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    results.push(res.ok ? '✅ Claude API working' : `❌ Claude API: HTTP ${res.status}`);
  } catch (e) {
    results.push(`❌ Claude: ${e.message.slice(0, 80)}`);
  }

  // 6. DeepSeek
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY || ''}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    results.push(res.ok ? '✅ DeepSeek API working' : `❌ DeepSeek API: HTTP ${res.status}`);
  } catch (e) {
    results.push(`❌ DeepSeek: ${e.message.slice(0, 80)}`);
  }

  await tgSend(`🧪 <b>System Test Results</b>\n\n${results.join('\n')}`);
}

async function handleMonthly(args) {
  try {
    const parts = (args ?? '').trim().split(/\s+/);
    let year, month;
    if (parts[0] && /^\d{4}$/.test(parts[0]) && parts[1] && /^\d{1,2}$/.test(parts[1])) {
      year = parseInt(parts[0], 10);
      month = parseInt(parts[1], 10);
    } else if (parts[0] && /^\d{4}-\d{2}$/.test(parts[0])) {
      [year, month] = parts[0].split('-').map(Number);
    } else {
      // Default: current month (1-indexed)
      const now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
    }
    await tgSend('📊 Generating monthly report...');
    const { generateMonthlyReport } = await import('../plan/yearlyReport.js');
    await generateMonthlyReport(year, month);
  } catch (err) {
    await tgSend(`❌ Monthly report failed: ${err.message}`);
  }
}

async function handleGoal() {
  try {
    const { sendWeeklyGoalUpdate } = await import('../plan/weeklyGoal.js');
    await sendWeeklyGoalUpdate();
    // sendWeeklyGoalUpdate already pushes the message via sendTelegramMessage
  } catch (err) {
    await tgSend(`❌ Goal check failed: ${err.message}`);
  }
}

async function handleQuality() {
  try {
    const { fetchAllHLData } = await import('../data/hyperliquid.js');
    const { computeClassicalIndicators } = await import('../indicators/classical.js');
    const { RISK_RULES } = await import('../risk/manager.js');

    const hlData = await fetchAllHLData();
    const m15Indicators = hlData.m15Candles.length >= 14
      ? computeClassicalIndicators(hlData.m15Candles)
      : null;
    const atr = m15Indicators?.atr ?? null;
    const spread = hlData.spread ?? 0;
    const funding = hlData.funding ?? 0;
    const fundingAnn = Math.abs(funding * 24 * 365 * 100);
    const hour = new Date().getUTCHours();

    // Informational session label only — does not gate execution
    const session =
      hour >= 7 && hour < 12 ? 'London' :
      hour >= 12 && hour < 21 ? 'NY' :
      hour >= 21 ? 'Late NY' : 'Asia/Quiet';
    const inKillZone = (hour >= 7 && hour < 10) || (hour >= 12 && hour < 15);

    const atrOK = atr != null && atr >= RISK_RULES.minATR;
    const spreadOK = spread <= RISK_RULES.maxSpread;
    const fundingOK = fundingAnn <= RISK_RULES.maxFundingAnnualizedPct;

    const score = [atrOK, spreadOK, fundingOK].filter(Boolean).length;
    const overallEmoji = score === 3 ? '✅' : score === 2 ? '⚠️' : '❌';

    let msg = `📊 <b>Market Quality</b>\n\n`;
    msg += `${overallEmoji} Overall: ${score}/3 conditions met\n\n`;

    msg += `<b>Session:</b> ${session} (informational only)\n`;
    msg += `Kill zone: ${inKillZone ? '🔥 ACTIVE' : '⏳ inactive'}\n\n`;

    msg += `<b>Conditions:</b>\n`;
    const atrLabel = atr == null ? 'unknown' :
      atr < 3 ? 'too low' : atr < 6 ? 'moderate' : atr < 15 ? 'good' : 'elevated';
    msg += `${atrOK ? '✅' : '❌'} ATR(M15): ${atr != null ? atr.toFixed(2) : '?'}pts (${atrLabel})\n`;

    const spreadLabel = spread <= 1 ? 'tight' : spread <= 2 ? 'normal' : spread <= 3 ? 'wide' : 'too wide';
    msg += `${spreadOK ? '✅' : '❌'} Spread: ${spread.toFixed(2)}pts (${spreadLabel})\n`;

    msg += `${fundingOK ? '✅' : '❌'} Funding: ${(funding * 100).toFixed(4)}%/hr (${fundingAnn.toFixed(0)}% annualized)\n\n`;

    if (score === 3) {
      msg += `🟢 Trading conditions: GOOD\nAgent will trade when signal appears`;
    } else if (score === 2) {
      msg += `🟡 Trading conditions: MARGINAL\n`;
      if (!atrOK) msg += `⚠️ Market too quiet — wait for ATR ≥ ${RISK_RULES.minATR}\n`;
      if (!spreadOK) msg += `⚠️ Spread too wide — wait for liquidity\n`;
      if (!fundingOK) msg += `⚠️ Funding extreme — crowded trade\n`;
    } else {
      msg += `🔴 Trading conditions: POOR\nAgent will block trades until conditions improve`;
    }

    await tgSend(msg);
  } catch (err) {
    await tgSend(`❌ Quality check failed: ${err.message}`);
  }
}

async function handleYearly(args) {
  try {
    const yearArg = (args ?? '').trim();
    const year = /^\d{4}$/.test(yearArg) ? parseInt(yearArg, 10) : undefined;
    await tgSend('📅 Generating yearly report...');
    const { generateYearlyReport } = await import('../plan/yearlyReport.js');
    await generateYearlyReport(year);
  } catch (err) {
    await tgSend(`❌ Yearly report failed: ${err.message}`);
  }
}

async function handleDebug() {
  try {
    const cwd = process.cwd();
    const today = new Date().toISOString().slice(0, 10);
    const planDir = path.join(cwd, 'plans', today);
    const plansBase = path.join(cwd, 'plans');

    let msg = `<b>🔍 Debug Info</b>\n\n`;
    msg += `cwd: <code>${cwd}</code>\n`;
    msg += `today: ${today}\n`;
    msg += `planDir: <code>${planDir}</code>\n`;
    msg += `exists: ${existsSync(planDir)}\n\n`;

    if (existsSync(planDir)) {
      const files = readdirSync(planDir);
      msg += `<b>Files (${files.length}):</b>\n`;
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const p = JSON.parse(readFileSync(path.join(planDir, f), 'utf8'));
          msg += `• ${f}: dir=${p.direction ?? 'null'} exec=${p.execution?.executed ?? 'missing'} order=${p.execution?.orderId ?? 'none'}\n`;
        } catch {
          msg += `• ${f}: parse error\n`;
        }
      }
    } else {
      msg += `⚠️ Plan directory does not exist on this instance\n\n`;
      if (existsSync(plansBase)) {
        const dirs = readdirSync(plansBase);
        msg += `<b>plans/ contains:</b> ${dirs.join(', ') || '(empty)'}\n`;
      } else {
        msg += `❌ plans/ directory does not exist at all\n`;
      }
    }

    msg += `\nAUTO_TRADE=${process.env.AUTO_TRADE} DRY_EXECUTE=${process.env.DRY_EXECUTE}`;
    await tgSend(msg);
  } catch (err) {
    await tgSend(`❌ Debug error: ${err.message}`);
  }
}

async function handleSpotBalance() {
  try {
    const { getSpotBalance, getHLBalance } = await import('../broker/hyperliquid.js');
    const [spot, perp] = await Promise.all([getSpotBalance(), getHLBalance()]);

    const goalReward = parseFloat(process.env.WEEKLY_GOAL_REWARD || '100');
    const canAutoTransfer = spot >= goalReward;

    let msg = `💰 <b>Hyperliquid Balances</b>\n\n`;
    msg += `Perp (trading): $${perp.balance.toFixed(2)} USDC\n`;
    msg += `Spot (reserve): $${spot.toFixed(2)} USDC\n`;
    msg += `Total: $${(perp.balance + spot).toFixed(2)} USDC\n\n`;
    msg += `<b>Weekly Goal Auto-Transfer:</b>\n`;

    if (canAutoTransfer) {
      msg += `✅ Ready — $${spot.toFixed(2)} spot available\n`;
      msg += `When goal hits: $${goalReward} auto-transfers to perp\n`;
    } else {
      msg += `⚠️ Not ready — need $${goalReward} in spot\n`;
      msg += `Currently: $${spot.toFixed(2)} spot\n`;
      msg += `Missing: $${(goalReward - spot).toFixed(2)}\n\n`;
      msg += `Add USDC to spot at app.hyperliquid.xyz\n`;
      msg += `to enable automatic goal rewards`;
    }

    await tgSend(msg);
  } catch (err) {
    await tgSend(`❌ Spot balance failed: ${err.message}`);
  }
}

async function handleMemory() {
  try {
    const { getStats, getDB } = await import('../memory/tradeDB.js');

    const overall = getStats();
    const london = getStats({ session: 'london' });
    const ny = getStats({ session: 'ny' });
    const lateNy = getStats({ session: 'late_ny' });
    const dead = getStats({ session: 'dead' });
    const longs = getStats({ direction: 'long' });
    const shorts = getStats({ direction: 'short' });

    const db = getDB();
    const blocked = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN wouldHaveOutcome='WIN' THEN 1 ELSE 0 END) as wouldWin,
        SUM(CASE WHEN wouldHaveOutcome='LOSS' THEN 1 ELSE 0 END) as wouldLoss
      FROM trades WHERE isExecuted=0 AND blockReason IS NOT NULL
    `).get();
    const reasons = db.prepare(`
      SELECT blockReason, COUNT(*) as c
      FROM trades
      WHERE isExecuted=0 AND blockReason IS NOT NULL
      GROUP BY blockReason
      ORDER BY c DESC
      LIMIT 5
    `).all();

    const wr = (t) => t.total > 0
      ? `${(t.wins / t.total * 100).toFixed(0)}%`
      : 'N/A';
    const ev = (t) => t.total > 0
      ? `${((t.wins / t.total * (t.avgWinRR || 2)) - (t.losses / t.total * 1)).toFixed(2)}R`
      : 'N/A';
    const resolvedBlocked = (blocked.wouldWin || 0) + (blocked.wouldLoss || 0);
    const wouldWR = resolvedBlocked > 0
      ? `${((blocked.wouldWin || 0) / resolvedBlocked * 100).toFixed(0)}%`
      : 'N/A';

    let msg = `🧠 <b>Trade Memory (RAG Database)</b>\n\n`;
    msg += `Total records: ${(overall.total || 0) + (blocked.total || 0)} `;
    msg += `(${overall.total || 0} executed / ${blocked.total || 0} blocked)\n\n`;

    msg += `<b>Executed Trades:</b>\n`;
    msg += `WR: ${wr(overall)} | EV: ${ev(overall)}\n`;
    msg += `Net P&amp;L: $${(overall.totalNetPnl || 0).toFixed(2)}\n\n`;

    msg += `<b>By Session:</b>\n`;
    msg += `London:  ${wr(london)} WR (${london.total || 0} trades)\n`;
    msg += `NY:      ${wr(ny)} WR (${ny.total || 0} trades)\n`;
    msg += `Late NY: ${wr(lateNy)} WR (${lateNy.total || 0} trades)\n`;
    msg += `Dead:    ${wr(dead)} WR (${dead.total || 0} trades)\n\n`;

    msg += `<b>By Direction:</b>\n`;
    msg += `Long:  ${wr(longs)} WR (${longs.total || 0} trades)\n`;
    msg += `Short: ${wr(shorts)} WR (${shorts.total || 0} trades)\n\n`;

    msg += `<b>Blocked Signals (${blocked.total || 0} total):</b>\n`;
    msg += `Resolved: ${resolvedBlocked} | Would-win: ${blocked.wouldWin || 0} (${wouldWR} WR)\n`;
    if (resolvedBlocked > 0) {
      if ((blocked.wouldWin || 0) > (blocked.wouldLoss || 0)) {
        msg += `✅ Blocks are PROTECTING you (more wins blocked than losses)\n`;
      } else if (resolvedBlocked > 5) {
        msg += `⚠️ Blocks are MISSING good trades (more losses blocked than wins)\n`;
      }
    }
    if (reasons.length > 0) {
      msg += `\n<b>Top block reasons:</b>\n`;
      reasons.forEach(r => { msg += `• ${r.blockReason}: ${r.c}x\n`; });
    }

    msg += `\n<i>RAG uses this data to improve every analysis</i>`;

    await tgSend(msg);
  } catch (err) {
    await tgSend(`❌ Memory failed: ${err.message}`);
  }
}

async function handleDeposited() {
  try {
    const { getHLBalance } = await import('../broker/hyperliquid.js');
    const { balance, available } = await getHLBalance();

    let msg = `✅ <b>Deposit Confirmed</b>\n\n`;
    msg += `Current perp balance: $${balance.toFixed(2)} USDC\n`;
    msg += `Available: $${available.toFixed(2)} USDC\n`;
    msg += `New 1% risk: $${(balance * 0.01).toFixed(2)}/trade\n\n`;
    msg += `Agent is ready — next signal will use updated position sizing.`;

    await tgSend(msg);
  } catch (err) {
    await tgSend(`❌ Deposited check failed: ${err.message}`);
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
    if (lower === '/today' || lower === '/trade') return await handleToday();
    if (lower === '/performance' || lower.startsWith('/performance ')) return await handlePerformance(args);
    if (lower === '/news') return await handleNews();
    if (lower === '/settings') return await handleSettings();
    if (lower === '/analyze') return await handleAnalyze();
    if (lower === '/test') return await handleTest();
    if (lower === '/debug') return await handleDebug();
    if (lower === '/quality') return await handleQuality();
    if (lower === '/goal') return await handleGoal();
    if (lower === '/monthly' || lower.startsWith('/monthly ')) return await handleMonthly(args);
    if (lower === '/yearly' || lower.startsWith('/yearly ')) return await handleYearly(args);
    if (lower === '/memory') return await handleMemory();
    if (lower === '/spotbalance') return await handleSpotBalance();
    if (lower === '/deposited') return await handleDeposited();
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
    if (lower === '/today' || lower === '/trade') return await handleToday();
    if (lower === '/performance' || lower.startsWith('/performance ')) {
      return await handlePerformance(trimmed.slice('/performance'.length).trim());
    }
    if (lower === '/news') return await handleNews();
    if (lower === '/settings') return await handleSettings();
    if (lower === '/analyze') return await handleAnalyze();
    if (lower === '/test') return await handleTest();
    if (lower === '/debug') return await handleDebug();
    if (lower === '/quality') return await handleQuality();
    if (lower === '/goal') return await handleGoal();
    if (lower === '/monthly' || lower.startsWith('/monthly ')) {
      return await handleMonthly(trimmed.slice('/monthly'.length).trim());
    }
    if (lower === '/yearly' || lower.startsWith('/yearly ')) {
      return await handleYearly(trimmed.slice('/yearly'.length).trim());
    }
    if (lower === '/memory') return await handleMemory();
    if (lower === '/spotbalance') return await handleSpotBalance();
    if (lower === '/deposited') return await handleDeposited();
    if (lower.startsWith('/ask ')) return await handleAsk(trimmed.slice(5));
    if (lower === '/ask') return await handleAsk('');

    if (trimmed && !trimmed.startsWith('/')) return await handleAsk(trimmed);

    await tgSend(`❓ Unknown command: <code>${trimmed.slice(0, 50)}</code>\n\nType /help for available commands.`);
  } catch (err) {
    console.error(`[bot] handler error for "${trimmed.slice(0, 40)}": ${err.message}`);
    await tgSend(`⚠️ Error: ${err.message.slice(0, 200)}`).catch(() => {});
  }
}
