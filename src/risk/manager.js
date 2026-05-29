// Risk rules for the Hyperliquid XAU/USDC perpetual account.
// getAccountState uses Hyperliquid — no IG session required.
import fs from 'node:fs/promises';
import path from 'node:path';

export const RISK_RULES = {
  maxRiskPerTrade: 2.0,         // % of equity
  maxDailyLoss: 6.0,            // stop trading after -6% daily P&L
  maxWeeklyDrawdown: 15.0,      // pause until next week at -15%
  maxOpenPositions: 6,          // up to 6 concurrent positions
  maxDailyTrades: 10,           // max trades per calendar day
  maxSLDistance: 50,             // reject if SL > 50pts from entry
  blockedTiers: [4],             // tier 4 = conflicting layers — no edge
  requiredConfluence: 6,
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

  executionMatrix: {
    'A+': { tier1: 2.0, tier2: 1.5, tier3: 1.0, tier4: 0.5 },
    'A':  { tier1: 2.0, tier2: 1.5, tier3: 1.0, tier4: 0.5 },
    'B':  { tier1: 2.0, tier2: 1.5, tier3: 1.0, tier4: 0.5 },
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
  console.log('[tf-debug] context keys:', Object.keys(context || {}));
  console.log('[tf-debug] h4 keys:', Object.keys(context?.h4 || {}));
  console.log('[tf-debug] h4 structure:', JSON.stringify(context?.h4?.structure)?.slice(0, 100));
  console.log('[tf-debug] h4 bias raw:', context?.h4?.structure?.bias);

  const h4Bias =
    context?.h4?.structure?.bias ??
    context?.smcH4?.structure?.bias ??
    context?.smcH4?.bias ??
    context?.h4?.bias ??
    context?.h4Bias ??
    null;
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

  console.log('[tf] resolved → h4:', h4Bias, 'h1:', h1Bias, 'm15:', m15Bias);

  const target = direction === 'long' ? 'bullish' : 'bearish';
  const aligned = {
    h4: h4Bias === target,
    h1: h1Bias === target,
    m15: m15Bias === target,
  };
  const score = Object.values(aligned).filter(Boolean).length;

  console.log(
    `[risk] TF alignment: H4=${aligned.h4 ? '✅' : '❌'} H1=${aligned.h1 ? '✅' : '❌'} M15=${aligned.m15 ? '✅' : '❌'} (${score}/3)`
  );
  return { aligned, score, h4Bias, h1Bias, m15Bias };
}

export async function checkRiskRules(plan, accountState, context = {}) {
  console.log(`[risk] checking: hour=${new Date().getUTCHours()} dir=${plan?.direction} tier=${plan?.threeLayer?.tier}`);
  const log = (msg) => console.log(`[risk] ${msg}`);

  const utcHour = new Date().getUTCHours();
  console.log(`[risk] hour: ${utcHour}:xx UTC (dead zone gating handled by executor)`);

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

  // Tier block check
  const planTier = plan?.threeLayer?.tier;
  if (planTier && RISK_RULES.blockedTiers?.includes(planTier)) {
    return {
      allowed: false,
      reason: `Tier ${planTier} blocked — conflicting layers, no edge. Wait for Tier 1-3 setup.`,
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
    : { score: 3, aligned: {} };
  if (_tfDir && tfAlign.score === 0) {
    const reason = `No timeframe alignment: H4, H1, M15 all disagree with ${plan.direction} direction.`;
    log(`REJECT tfAlignment: ${reason}`);
    return { allowed: false, reason };
  }
  if (tfAlign.score === 1) {
    if ((plan.threeLayer?.tier ?? 4) > 3) {
      const reason = `Single TF alignment only — not enough confluence for this tier.`;
      log(`REJECT tfAlignment: ${reason}`);
      return { allowed: false, reason };
    }
    log('single TF alignment — allowing at reduced confidence');
  }
  if (tfAlign.score === 3) {
    log('FULL TF alignment ✅ — highest quality setup');
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

  // Block trades against H4 trend (exception: Tier 1 + confluence ≥ 8 for major reversals)
  const h4Bias = context?.h4?.structure?.bias ?? context?.smcH4?.structure?.bias;
  const tradeDirection = plan?.direction;

  if (h4Bias && tradeDirection) {
    const isCounterTrend =
      (tradeDirection === 'long' && h4Bias === 'bearish') ||
      (tradeDirection === 'short' && h4Bias === 'bullish');

    if (isCounterTrend) {
      const tier = plan?.threeLayer?.tier;
      const confluence = plan?.confluenceCount || 0;
      if (tier === 1 && confluence >= 8) {
        log(`counter-trend allowed: Tier 1 + confluence ${confluence} (major reversal)`);
      } else {
        const reason = tradeDirection === 'long'
          ? `Counter-trend blocked: LONG against H4 bearish. Need Tier 1 + 8+ confluence for reversal.`
          : `Counter-trend blocked: SHORT against H4 bullish. Need Tier 1 + 8+ confluence for reversal.`;
        log(`REJECT h4Trend: ${reason}`);
        return { allowed: false, reason };
      }
    } else {
      log(`H4 trend: ${h4Bias} | direction: ${tradeDirection} | aligned ✅`);
    }
  }

  // Apply tier-based risk override
  const tierRisk = {
    1: matrix.tier1 || 2.0,
    2: matrix.tier2 || 1.5,
    3: matrix.tier3 || 1.0,
    4: 0.5,
  }[tier] ?? 0.5;

  plan.risk.suggestedRiskPct = tierRisk;

  if (tier === 4) {
    plan.warnings = [...(plan.warnings || []),
      '⚠️ Tier 4 — macro/flow layers conflict with technicals',
      '⚠️ Executing at reduced 0.5% risk due to layer conflict',
    ];
    log(`WARN tier4: executing at 0.5% (reduced)`);
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
