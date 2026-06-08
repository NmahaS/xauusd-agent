// Risk rules for the Hyperliquid XAU/USDC perpetual account.
// getAccountState uses Hyperliquid — no IG session required.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveStaleH4Bias } from '../smc/structure.js';

export const RISK_RULES = {
  maxRiskPerTrade: 2.0,         // % of equity
  maxDailyLoss: 6.0,            // stop trading after -6% daily P&L
  maxWeeklyDrawdown: 15.0,      // pause until next week at -15%
  maxOpenPositions: 6,          // up to 6 concurrent positions
  maxDailyTrades: 10,           // max trades per calendar day
  maxSLDistance: 50,             // reject if SL > 50pts from entry
  blockedTiers: [4],             // tier 4 = conflicting layers — no edge
  requiredConfluence: 5,
  requiredQuality: ['A+', 'A', 'B'],
  requiredConsensus: ['full', 'split'],
  fridayBlock: 15,              // no new trades after 15:00 UTC Friday
  newsBlackout: 30,             // minutes

  // Dynamic market quality thresholds (replaces time-based session blocks)
  minATR: 3,                    // M15 ATR floor (pts) — block ranging/dead markets
  maxSpread: 3,                 // max mid-oracle spread (pts) — liquidity check
  maxFundingAnnualizedPct: 50,  // |funding| annualized cap — crowded-trade filter

  autoExecuteQualities: ['A+', 'A', 'B'],
  autoExecuteConsensus: ['full', 'split'],

  // Flat 1% risk on every trade, regardless of quality or tier.
  executionMatrix: {
    'A+': { tier1: 1.0, tier2: 1.0, tier3: 1.0, tier4: 1.0 },
    'A':  { tier1: 1.0, tier2: 1.0, tier3: 1.0, tier4: 1.0 },
    'B':  { tier1: 1.0, tier2: 1.0, tier3: 1.0, tier4: 1.0 },
  },
};

const PLANS_DIR = path.resolve('plans');
const STATE_FILE = path.resolve('src/risk/state.json');

export async function getAccountState() {
  const { getHLBalance, getHLPositions } = await import('../broker/hyperliquid.js');

  let balance, available, unrealizedPnl, openPositions;
  try {
    [{ balance, available, unrealizedPnl }, openPositions] = await Promise.all([
      getHLBalance(),
      getHLPositions(),
    ]);
  } catch (err) {
    return {
      ok: false, error: err.message,
      balance: 0, equity: 0, available: 0, openPositions: [], dailyPL: 0,
    };
  }

  return {
    ok: true,
    balance,
    equity: balance + unrealizedPnl,
    available,
    deposit: balance,
    openPositions,
    dailyPL: unrealizedPnl,
    currency: 'USDC',
  };
}

// Position sizing in XAU units: riskAmount / SL distance = size in XAU.
// Min 0.001 XAU. Rejects if even minimum lot overruns budget by >50%.
export function calculatePositionSize(balance, riskPct, entryPrice, slPrice) {
  const maxRiskAmount = balance * (RISK_RULES.maxRiskPerTrade / 100);
  const riskAmount = Math.min(balance * (riskPct / 100), maxRiskAmount);
  const slDistance = Math.abs(entryPrice - slPrice);
  if (!slDistance) {
    return { size: 0, reason: 'SL distance is zero — invalid plan', actualRisk: 0, riskPct: 0 };
  }

  const rawSize = riskAmount / slDistance;
  const size = Math.max(0.001, Math.round(rawSize * 10000) / 10000);

  const actualRisk = size * slDistance;
  if (actualRisk > riskAmount * 1.5) {
    return {
      size: 0,
      reason: `SL too wide for $${balance.toFixed(2)} account (would risk $${actualRisk.toFixed(2)} vs budget $${riskAmount.toFixed(2)}) — wait for tighter M15 entry`,
      actualRisk,
      riskPct: ((actualRisk / balance) * 100).toFixed(2),
    };
  }

  return {
    size,
    actualRisk: parseFloat(actualRisk.toFixed(2)),
    riskPct: ((actualRisk / balance) * 100).toFixed(2),
  };
}

function isAfterFridayCutoff() {
  const now = new Date();
  const day = now.getUTCDay();
  return day === 5 && now.getUTCHours() >= RISK_RULES.fridayBlock;
}

function imminentHighImpactNews(calendar) {
  const events = calendar?.events || [];
  return events.find(e => {
    const high = String(e.impact || '').toLowerCase().includes('high');
    return high && e.minutesAway != null && e.minutesAway >= 0 && e.minutesAway <= RISK_RULES.newsBlackout;
  }) || null;
}

export async function getDailyTradeHistory() {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(PLANS_DIR, today, 'trades.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function readRiskState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      lastUpdated: null,
      dailyTrades: 0,
      dailyPL: 0,
      weeklyPL: 0,
      weekStartBalance: 0,   // 0 = uninitialized; will be set on first trade check
      cooldownUntil: null,
      openDeals: [],
    };
  }
}

async function getWeeklyPL(accountState) {
  try {
    const fsSync = await import('fs');
    let state = { weekStartBalance: 0, weeklyPL: 0 };
    try {
      state = JSON.parse(fsSync.default.readFileSync(STATE_FILE, 'utf8'));
    } catch {}

    const currentBalance = accountState.balance;

    if (!state.weekStartBalance || state.weekStartBalance <= 0) {
      state.weekStartBalance = currentBalance;
      fsSync.default.writeFileSync(STATE_FILE, JSON.stringify({
        ...state,
        weekStartBalance: currentBalance,
        lastUpdated: new Date().toISOString(),
      }, null, 2));
      console.log(`[risk] initialized week start balance: $${currentBalance}`);
      return 0;
    }

    const weeklyPLPct = ((currentBalance - state.weekStartBalance) / state.weekStartBalance) * 100;
    console.log(`[risk] weekly: start=$${state.weekStartBalance} current=$${currentBalance} PL=${weeklyPLPct.toFixed(2)}%`);
    return weeklyPLPct;
  } catch (err) {
    console.warn('[risk] weekly PL calculation failed:', err.message);
    return 0;
  }
}

export async function writeRiskState(state) {
  state.lastUpdated = new Date().toISOString();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getTimeframeAlignment(context, direction) {
  // H1 = PRIMARY filter, M15 = execution. Score is H1+M15 only (out of 2).
  // H4 is CONTEXT ONLY — resolved and displayed separately, never part of the score.
  const h1Bias =
    context?.h1?.structure?.bias ??
    context?.smcH1?.structure?.bias ??
    context?.smcH1?.bias ??
    context?.h1?.bias ??
    context?.h1Bias ??
    null;
  const m15Bias =
    context?.m15?.structure?.bias ??
    context?.smcM15?.structure?.bias ??
    context?.smcM15?.bias ??
    context?.m15?.bias ??
    context?.m15Bias ??
    null;

  // Same staleness override as the 3-layer engine so the H4 info matches the rest of the system.
  const h4BiasRaw =
    context?.h4?.structure?.bias ??
    context?.smcH4?.structure?.bias ??
    context?.smcH4?.bias ??
    context?.h4?.bias ??
    context?.h4Bias ??
    null;
  const _h4Eval = resolveStaleH4Bias(
    context?.h4?.structure ?? context?.smcH4?.structure,
    context?.h4Candles ?? context?.h4?.candles
  );
  const h4Bias = _h4Eval.stale ? _h4Eval.bias : h4BiasRaw;

  console.log('[tf] H1:', h1Bias, '| M15:', m15Bias, '| H4(info):', h4Bias, '| dir:', direction);

  const target = direction === 'long' ? 'bullish' : 'bearish';
  const aligned = {
    h1: h1Bias === target,
    m15: m15Bias === target,
  };
  const score = Object.values(aligned).filter(Boolean).length;
  const total = 2; // H1 + M15 only — H4 is context, not scored

  // H4 status is info only (not in score).
  const h4Status = h4Bias === target ? 'agrees'
                 : h4Bias == null    ? 'unknown'
                 : 'disagrees';

  console.log('[tf] alignment H1=' + (aligned.h1 ? '✅' : '❌') +
    ' M15=' + (aligned.m15 ? '✅' : '❌') +
    ' = ' + score + '/' + total +
    ' (H4 ' + h4Status + ' — context only)');

  return { aligned, score, total, h1Bias, m15Bias, h4Bias, h4Status };
}

export async function checkRiskRules(plan, accountState, context = {}) {
  console.log(`[risk] checking: hour=${new Date().getUTCHours()} dir=${plan?.direction} tier=${plan?.threeLayer?.tier}`);
  const log = (msg) => console.log(`[risk] ${msg}`);

  const utcHour = new Date().getUTCHours();
  console.log(`[risk] hour: ${utcHour}:xx UTC (dead zone gating handled by executor)`);

  // ─── DRAWDOWN & LOSS-STREAK GUARDS (fills-based) ───────────────────────────
  // Two protections that both need recent fills, fetched once here:
  //   • STEP 3: daily loss circuit breaker — hard stop at -3% realized P&L today
  //   • STEP 2: same-direction loss streak — 3+ recent losses in plan.direction
  // Fail-open: if the fills API is unavailable we warn and continue (never crash the run).
  const coin = process.env.HL_COIN || 'PAXG';
  let recentFills = [];
  try {
    const { getHLFillsHistory } = await import('../broker/hyperliquid.js');
    recentFills = await getHLFillsHistory(coin, 7);
  } catch (err) {
    console.warn('[risk] fills fetch failed — skipping circuit breaker + loss-streak:', err.message);
  }

  if (recentFills.length > 0) {
    const bal = accountState?.balance ?? 0;
    const todayStr = new Date().toISOString().slice(0, 10);

    // STEP 3: daily loss circuit breaker
    const todayClosed = recentFills.filter(f =>
      f.isClose && new Date(f.time).toISOString().slice(0, 10) === todayStr
    );
    const todayNetPL = todayClosed.reduce((s, f) => s + f.closedPnl - f.fee, 0);
    const dailyLossPct = bal > 0 ? (todayNetPL / bal) * 100 : 0;

    if (dailyLossPct < -3) {
      const reason = `Daily circuit breaker: ${dailyLossPct.toFixed(2)}% realized loss today — trading stopped`;
      log(`REJECT circuitBreaker: ${reason}`);
      return { allowed: false, reason };
    }
    if (dailyLossPct < -2) {
      console.warn(`[risk] daily loss ${dailyLossPct.toFixed(2)}% — approaching -3% circuit breaker`);
    }
    console.log(`[risk] daily realized P&L: ${dailyLossPct.toFixed(2)}% ✅`);

    // STEP 2: same-direction loss-streak protection (resets daily — today's UTC closes only)
    if (plan.direction) {
      const todayLossesSameDir = todayClosed.filter(f =>
        f.direction === plan.direction && f.closedPnl < -0.01
      ).length;
      if (todayLossesSameDir >= 3) {
        const reason = `Loss streak protection: ${todayLossesSameDir} ${plan.direction} losses today — resets at UTC midnight`;
        log(`REJECT lossStreak: ${reason}`);
        return { allowed: false, reason };
      }
      console.log(`[risk] loss streak: ${todayLossesSameDir} ${plan.direction} losses today ✅`);
    }
  }

  // ATR minimum — block ranging/dead markets early
  const atrValue = context?.m15?.indicators?.atr
    ?? context?.m15Indicators?.atr
    ?? context?.indicators?.atr;
  if (atrValue !== undefined && atrValue !== null) {
    if (atrValue < 3) {
      return {
        allowed: false,
        reason: `ATR too low: ${atrValue.toFixed(2)}pts — market too quiet (min 3pts)`,
      };
    }
    console.log(`[risk] ATR: ${atrValue.toFixed(2)}pts ✅`);
  }

  // ─── PRICE-BASED TREND CONFIRMATION ────────────────────────────────────────
  // SMC structure (CHoCH/BOS) can lag actual price action. These filters use REAL
  // price vs H1 EMA20/50 and H1 swing highs/lows to hard-block counter-trend entries
  // (e.g. shorting while price rips above both H1 EMAs). Second filter, defence-in-depth.
  {
    const h1Candles = context?.h1Candles || context?.h1?.candles || [];
    const m15Candles = context?.m15Candles || context?.m15?.candles || [];
    const dir = plan.direction;
    const px = context?.currentPrice;

    if (dir && px && h1Candles.length >= 50 && m15Candles.length >= 20) {
      // Prefer already-computed EMAs; fall back to a local EMA over recent closes.
      const ema = (arr, period) => {
        const mult = 2 / (period + 1);
        let r = arr[0];
        for (let i = 1; i < arr.length; i++) r = (arr[i] - r) * mult + r;
        return r;
      };
      const h1Closes = h1Candles.slice(-50).map(c => c.close);
      const m15Closes = m15Candles.slice(-20).map(c => c.close);
      const h1Ema20 = context?.h1Indicators?.ema20 ?? ema(h1Closes, 20);
      const h1Ema50 = context?.h1Indicators?.ema50 ?? ema(h1Closes, 50);
      const m15Ema20 = context?.m15Indicators?.ema20 ?? ema(m15Closes, 20);

      const priceAboveH1Emas = px > h1Ema20 && px > h1Ema50;
      const priceBelowH1Emas = px < h1Ema20 && px < h1Ema50;

      console.log('[trend] price:', px.toFixed(2),
        '| H1 EMA20:', h1Ema20.toFixed(2),
        '| H1 EMA50:', h1Ema50.toFixed(2),
        '| M15 EMA20:', m15Ema20.toFixed(2),
        '| dir:', dir);

      // STEP 1: hard block — don't short above both H1 EMAs / don't long below both
      if (dir === 'short' && priceAboveH1Emas) {
        const reason = `Trend filter: price above H1 EMA20+EMA50 — no shorts ($${px.toFixed(2)} > $${h1Ema20.toFixed(2)})`;
        log(`REJECT trendFilter: ${reason}`);
        return { allowed: false, reason };
      }
      if (dir === 'long' && priceBelowH1Emas) {
        const reason = `Trend filter: price below H1 EMA20+EMA50 — no longs ($${px.toFixed(2)} < $${h1Ema20.toFixed(2)})`;
        log(`REJECT trendFilter: ${reason}`);
        return { allowed: false, reason };
      }
      console.log('[trend] OK to', dir, '— price',
        priceAboveH1Emas ? 'above' : priceBelowH1Emas ? 'below' : 'between', 'H1 EMAs');

      // STEP 4: higher-high / lower-low momentum (last 10 H1 candles)
      if (h1Candles.length >= 10) {
        const h1Highs = h1Candles.slice(-10).map(c => c.high);
        const h1Lows = h1Candles.slice(-10).map(c => c.low);
        const recentHigh = Math.max(...h1Highs);
        const recentLow = Math.min(...h1Lows);
        const olderHigh = Math.max(...h1Highs.slice(0, 5));
        const olderLow = Math.min(...h1Lows.slice(0, 5));
        const makingHigherHighs = recentHigh > olderHigh;
        const makingLowerLows = recentLow < olderLow;

        if (dir === 'short' && makingHigherHighs && !makingLowerLows) {
          const reason = `H1 making higher highs ($${olderHigh.toFixed(2)} → $${recentHigh.toFixed(2)}) — no shorts`;
          log(`REJECT trendFilter(HH): ${reason}`);
          return { allowed: false, reason };
        }
        if (dir === 'long' && makingLowerLows && !makingHigherHighs) {
          const reason = `H1 making lower lows ($${olderLow.toFixed(2)} → $${recentLow.toFixed(2)}) — no longs`;
          log(`REJECT trendFilter(LL): ${reason}`);
          return { allowed: false, reason };
        }
        console.log('[trend] HH/LL ok — higherHighs:', makingHigherHighs, 'lowerLows:', makingLowerLows);
      }
    } else if (dir) {
      console.log(`[trend] skipped — insufficient data (h1:${h1Candles.length} m15:${m15Candles.length} px:${px ?? 'n/a'})`);
    }
  }

  // Tier block check — surface WHICH layer/TF conflicts (from the 3-layer engine)
  const planTier = plan?.threeLayer?.tier;
  if (planTier && RISK_RULES.blockedTiers?.includes(planTier)) {
    const blockers = plan?.threeLayer?.blockingFactors?.length
      ? plan.threeLayer.blockingFactors.join('; ')
      : (plan?.threeLayer?.tierLabel || 'conflicting layers, no edge');
    return {
      allowed: false,
      reason: `Tier ${planTier} blocked — ${blockers}. Wait for Tier 1-3 setup.`,
    };
  }
  console.log(`[risk] tier check: Tier ${planTier ?? '?'} ✅`);

  const tier = plan.threeLayer?.tier ?? 4;
  const quality = plan.setupQuality;
  const matrix = RISK_RULES.executionMatrix[quality];
  if (!matrix) {
    const reason = `Unknown quality: ${quality}`;
    log(`REJECT executionMatrix: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS executionMatrix: ${quality} Tier ${tier}`);

  // 1. Confluence
  if ((plan.confluenceCount ?? 0) < RISK_RULES.requiredConfluence) {
    const reason = `Confluence too low: ${plan.confluenceCount}/12 (need ${RISK_RULES.requiredConfluence}+). Wait for stronger setup.`;
    log(`REJECT confluence: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS confluence=${plan.confluenceCount}`);

  // 2. Dynamic market quality — block poor conditions regardless of time
  const m15ATR = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? null;
  const spread = context?.spread ?? 0;
  const fundingRate = context?.funding?.rate ?? 0;
  const fundingAnnualized = Math.abs(fundingRate * 24 * 365 * 100);

  if (m15ATR != null && m15ATR < RISK_RULES.minATR) {
    const reason = `Market too quiet: ATR ${m15ATR.toFixed(2)}pts < ${RISK_RULES.minATR}pts minimum — waiting for volatility`;
    log(`REJECT marketQuality(atr): ${reason}`);
    return { allowed: false, reason };
  }
  if (spread > RISK_RULES.maxSpread) {
    const reason = `Spread too wide: ${spread.toFixed(2)}pts > ${RISK_RULES.maxSpread}pts — low liquidity`;
    log(`REJECT marketQuality(spread): ${reason}`);
    return { allowed: false, reason };
  }
  if (fundingAnnualized > RISK_RULES.maxFundingAnnualizedPct) {
    const reason = `Funding extreme: ${fundingAnnualized.toFixed(0)}% annualized — crowded trade, avoid`;
    log(`REJECT marketQuality(funding): ${reason}`);
    return { allowed: false, reason };
  }
  log(`market quality OK: ATR=${m15ATR != null ? m15ATR.toFixed(2) : 'n/a'} spread=${spread.toFixed(2)} funding=${(fundingRate * 100).toFixed(4)}%`);

  // 3. Friday cutoff
  if (isAfterFridayCutoff()) {
    const reason = 'Friday afternoon cutoff (>=15:00 UTC)';
    log(`REJECT fridayCutoff: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS fridayCutoff`);

  // 4. News blackout
  const imminent = imminentHighImpactNews(context.calendar);
  if (imminent) {
    const reason = `News blackout: ${imminent.title} in ${imminent.minutesAway}m`;
    log(`REJECT news: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS news blackout`);

  // 5. Open positions
  const openCount = accountState.openPositions?.length ?? 0;
  if (openCount >= RISK_RULES.maxOpenPositions) {
    const reason = `${openCount} position(s) already open (max ${RISK_RULES.maxOpenPositions})`;
    log(`REJECT openPositions: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS openPositions=${openCount}`);

  // 6. Daily P&L floor
  const dailyPctLoss = accountState.balance > 0 ? (accountState.dailyPL / accountState.balance) * 100 : 0;
  if (dailyPctLoss <= -RISK_RULES.maxDailyLoss) {
    const reason = `Daily loss limit hit (${dailyPctLoss.toFixed(2)}% <= -${RISK_RULES.maxDailyLoss}%)`;
    log(`REJECT dailyLoss: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS dailyPL=${dailyPctLoss.toFixed(2)}%`);

  // 8. Weekly drawdown + daily trade limit
  const state = await readRiskState();

  const dailyTradeCount = state?.dailyTrades || 0;
  if (dailyTradeCount >= RISK_RULES.maxDailyTrades) {
    return {
      allowed: false,
      reason: `Daily trade limit reached: ${dailyTradeCount}/${RISK_RULES.maxDailyTrades} trades today`,
    };
  }
  console.log(`[risk] daily trades: ${dailyTradeCount}/${RISK_RULES.maxDailyTrades} ✅`);

  if (state.weekStartBalance > 0) {
    const weeklyPct = await getWeeklyPL(accountState);
    if (weeklyPct <= -RISK_RULES.maxWeeklyDrawdown) {
      const reason = `Weekly drawdown limit (${weeklyPct.toFixed(2)}% <= -${RISK_RULES.maxWeeklyDrawdown}%)`;
      log(`REJECT weeklyDrawdown: ${reason}`);
      return { allowed: false, reason };
    }
    log(`PASS weeklyDrawdown=${weeklyPct.toFixed(2)}%`);
  } else {
    log('week start balance not set — skipping weekly check');
  }

  // 9. SL distance check — system auto-places TP at TARGET_RR, so only validate SL width
  const targetRR = parseFloat(process.env.TARGET_RR || '2.0');
  const entryForRisk = plan.entry?.price ?? context?.currentPrice ?? 0;
  const slForRisk = plan.stopLoss?.price ?? entryForRisk;
  const slDistance = Math.abs(entryForRisk - slForRisk);

  if (slDistance <= 0) {
    const reason = 'Invalid SL distance (entry equals SL)';
    log(`REJECT slDistance: ${reason}`);
    return { allowed: false, reason };
  }
  if (slDistance < 3) {
    const reason = `SL too tight: ${slDistance.toFixed(1)}pts (min 3pts)`;
    log(`REJECT slDistance: ${reason}`);
    return { allowed: false, reason };
  }
  if (slDistance > RISK_RULES.maxSLDistance) {
    const reason = `SL too wide: ${slDistance.toFixed(1)}pts (max ${RISK_RULES.maxSLDistance}pts)`;
    log(`REJECT slDistance: ${reason}`);
    return { allowed: false, reason };
  }
  const impliedTP = plan.direction === 'long'
    ? entryForRisk + slDistance * targetRR
    : entryForRisk - slDistance * targetRR;
  console.log(`[risk] SL distance: ${slDistance.toFixed(1)}pts ✅`);
  log(`PASS slDistance — TP will be at $${impliedTP.toFixed(0)} (${targetRR}R)`);

  // Timeframe alignment check (Principle 8)
  const _h4Bias = context?.h4?.structure?.bias ?? context?.smcH4?.structure?.bias ?? null;
  const _tfDir = plan.direction ?? (
    _h4Bias === 'bearish' ? 'short' :
    _h4Bias === 'bullish' ? 'long' :
    null
  );
  console.log('[tf] using direction:', _tfDir,
    '(plan:', plan.direction, 'h4:', _h4Bias + ')');
  if (!_tfDir) {
    console.log('[risk] no direction for TF check — skipping');
  }
  const tfAlign = _tfDir
    ? getTimeframeAlignment(context, _tfDir)
    : { score: 2, total: 2, aligned: {} };
  if (_tfDir && tfAlign.score === 0) {
    const reason = `No timeframe alignment: H1 and M15 both disagree with ${plan.direction} direction.`;
    log(`REJECT tfAlignment: ${reason}`);
    return { allowed: false, reason };
  }
  if (tfAlign.score === 1) {
    if ((plan.threeLayer?.tier ?? 4) > 3) {
      const reason = `Single TF alignment only (H1 or M15) — not enough confluence for this tier.`;
      log(`REJECT tfAlignment: ${reason}`);
      return { allowed: false, reason };
    }
    log('single TF alignment — allowing at reduced confidence');
  }
  if (tfAlign.score === 2) {
    log('FULL TF alignment ✅ — H1+M15 aligned (highest quality setup)');
  }

  // Pullback check — block chasing entries far from any key level (Principle 7)
  // Exception: if entry is inside a M15 OB or FVG, it IS the level — not chasing
  const planEntry = plan?.entry?.price || context?.currentPrice;
  const nearestLevel = context?.keyLevels?.nearest;
  if (planEntry) {
    // Resolve OBs — try all known context paths
    const m15OBsSplit =
      context?.m15?.orderBlocks ||
      context?.m15?.smc?.orderBlocks ||
      context?.smcM15?.orderBlocks ||
      {};
    const m15FVGsSplit =
      context?.m15?.fvgs ||
      context?.m15?.smc?.fvgs ||
      context?.smcM15?.fvgs ||
      {};

    // Flatten split OB/FVG objects ({ bullish: [...], bearish: [...] }) into arrays
    const m15OBs = Array.isArray(m15OBsSplit)
      ? m15OBsSplit
      : [...(m15OBsSplit.bullish || []), ...(m15OBsSplit.bearish || [])];
    const m15FVGs = Array.isArray(m15FVGsSplit)
      ? m15FVGsSplit
      : [...(m15FVGsSplit.bullish || []), ...(m15FVGsSplit.bearish || [])];

    console.log('[risk] m15 OBs count:', m15OBs.length);
    console.log('[risk] m15 FVGs count:', m15FVGs.length);
    if (m15OBs[0]) {
      console.log('[risk] first OB keys:', Object.keys(m15OBs[0]).join(', '));
    }

    // OBs use low/high; fallback to bottom/top/start/end for safety
    const entryInOB = m15OBs.some(ob => {
      const low = ob.low ?? ob.bottom ?? ob.start ?? 0;
      const high = ob.high ?? ob.top ?? ob.end ?? 999999;
      const inside = planEntry >= low && planEntry <= high;
      if (inside) {
        console.log('[risk] entry inside M15 OB:', low.toFixed(2) + '-' + high.toFixed(2), '✅');
      }
      return inside;
    });

    // FVGs use top/bottom; fallback to high/low/start/end for safety
    const entryInFVG = m15FVGs.some(fvg => {
      const low = fvg.bottom ?? fvg.low ?? fvg.start ?? 0;
      const high = fvg.top ?? fvg.high ?? fvg.end ?? 999999;
      const inside = planEntry >= low && planEntry <= high;
      if (inside) {
        console.log('[risk] entry inside M15 FVG:', low.toFixed(2) + '-' + high.toFixed(2), '✅');
      }
      return inside;
    });

    if (entryInOB || entryInFVG) {
      log(`entry inside M15 ${entryInOB ? 'OB' : 'FVG'} ✅ — pullback check passed`);
    } else if (nearestLevel) {
      const dist = Math.abs(planEntry - nearestLevel.price);
      if (dist > 30) {
        const reason = `Chasing: entry $${planEntry.toFixed(2)} is ${dist.toFixed(1)}pts from nearest level $${nearestLevel.price.toFixed(2)}`;
        log(`REJECT pullback: ${reason}`);
        return { allowed: false, reason };
      }
      log(`entry distance from level: ${dist.toFixed(1)}pts ✅`);
    }
  }

  // Block trades against the H1 trend. H1 is now the PRIMARY directional filter (was H4).
  // A directly OPPOSING H1 is a hard block. H4 is CONTEXT ONLY — when it opposes, it adds a
  // warning, never a block (it lags ~4h and was causing valid H1+M15 reversals to be rejected).
  const _ctH4Eval = resolveStaleH4Bias(
    context?.h4?.structure ?? context?.smcH4?.structure,
    context?.h4Candles ?? context?.h4?.candles
  );
  const h4Bias = _ctH4Eval.stale
    ? _ctH4Eval.bias
    : (context?.h4?.structure?.bias ?? context?.smcH4?.structure?.bias);
  const h1Bias =
    context?.h1?.structure?.bias ??
    context?.smcH1?.structure?.bias ??
    context?.smcH1?.bias ??
    context?.h1?.bias ??
    null;
  const tradeDirection = plan?.direction;

  if (h1Bias && tradeDirection) {
    const counterH1 =
      (tradeDirection === 'long' && h1Bias === 'bearish') ||
      (tradeDirection === 'short' && h1Bias === 'bullish');
    if (counterH1) {
      const reason = `Counter-H1 blocked: H1 ${h1Bias} conflicts with ${tradeDirection} direction`;
      log(`REJECT h1Trend: ${reason}`);
      return { allowed: false, reason };
    }
    log(`H1 trend: ${h1Bias} | direction: ${tradeDirection} | aligned ✅`);
  }

  // H4 as context only — warning, never a block.
  if (h4Bias && tradeDirection) {
    const h4Opposes =
      (tradeDirection === 'long' && h4Bias === 'bearish') ||
      (tradeDirection === 'short' && h4Bias === 'bullish');
    if (h4Opposes) {
      plan.warnings = [...(plan.warnings || []),
        `⚠️ H4 ${h4Bias} opposes ${tradeDirection} — context only, not blocking`];
      log(`WARN h4Context: H4 ${h4Bias} opposes ${tradeDirection} (warning only)`);
    } else {
      log(`H4 context: ${h4Bias} | direction: ${tradeDirection} | aligned ✅`);
    }
  }

  // Flat 1% risk on every trade — all tiers map to 1.0%.
  const tierRisk = {
    1: matrix.tier1 || 1.0,
    2: matrix.tier2 || 1.0,
    3: matrix.tier3 || 1.0,
    4: 1.0,
  }[tier] ?? 1.0;

  plan.risk.suggestedRiskPct = tierRisk;

  if (tier === 4) {
    plan.warnings = [...(plan.warnings || []),
      '⚠️ Tier 4 — macro/flow layers conflict with technicals',
      '⚠️ Flat 1% risk (layer conflict — caution)',
    ];
    log(`WARN tier4: executing at 1% (flat)`);
  }

  if (plan.consensus?.agreement === 'split') {
    plan.warnings = [...(plan.warnings || []),
      '⚠️ Split consensus — Claude and DeepSeek disagree',
    ];
    log(`WARN splitConsensus: proceeding with warning`);
  }

  log(`APPROVE: ${quality} Tier ${tier} → ${tierRisk}%`);
  return { allowed: true, reason: `${quality} Tier ${tier} approved at ${tierRisk}%` };
}
