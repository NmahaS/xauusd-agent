// Risk rules for the Hyperliquid XAU/USDC perpetual account.
// getAccountState uses Hyperliquid — no IG session required.
import fs from 'node:fs/promises';
import path from 'node:path';

export const RISK_RULES = {
  maxRiskPerTrade: 2.0,         // % of equity
  maxDailyLoss: 6.0,            // stop trading after -6% daily P&L
  maxWeeklyDrawdown: 15.0,      // pause until next week at -15%
  maxOpenPositions: 2,          // up to 2 concurrent positions
  maxDailyTrades: 6,
  minRR: 1.5,                   // reject if TP1 RR < 1.5
  requiredConfluence: 5,
  requiredQuality: ['A+', 'A', 'B'],
  requiredConsensus: ['full', 'split'],
  blockedSessions: ['off'],
  fridayBlock: 15,              // no new trades after 15:00 UTC Friday
  newsBlackout: 30,             // minutes

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
      weekStartBalance: 10000,
      cooldownUntil: null,
      openDeals: [],
    };
  }
}

export async function writeRiskState(state) {
  state.lastUpdated = new Date().toISOString();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function checkRiskRules(plan, accountState, context = {}) {
  const log = (msg) => console.log(`[risk] ${msg}`);

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
    const reason = `Confluence ${plan.confluenceCount}/${RISK_RULES.requiredConfluence} too low`;
    log(`REJECT confluence: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS confluence=${plan.confluenceCount}`);

  // 2. Session — only block off-hours (17:00-00:00 UTC)
  const sess = plan.session?.current || 'unknown';
  if (sess === 'off') {
    const reason = 'Off-session (17:00-00:00 UTC) — no liquidity';
    log(`REJECT session: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS session=${sess}`);

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

  // 6. Daily trade count
  const dailyTrades = (await getDailyTradeHistory()).length;
  if (dailyTrades >= RISK_RULES.maxDailyTrades) {
    const reason = `${dailyTrades} trades today — daily limit ${RISK_RULES.maxDailyTrades}`;
    log(`REJECT dailyTrades: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS dailyTrades=${dailyTrades}`);

  // 7. Daily P&L floor
  const dailyPctLoss = accountState.balance > 0 ? (accountState.dailyPL / accountState.balance) * 100 : 0;
  if (dailyPctLoss <= -RISK_RULES.maxDailyLoss) {
    const reason = `Daily loss limit hit (${dailyPctLoss.toFixed(2)}% <= -${RISK_RULES.maxDailyLoss}%)`;
    log(`REJECT dailyLoss: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS dailyPL=${dailyPctLoss.toFixed(2)}%`);

  // 8. Weekly drawdown
  const state = await readRiskState();
  const weekBase = state.weekStartBalance || 10000;
  const weeklyPct = ((accountState.balance - weekBase) / weekBase) * 100;
  if (weeklyPct <= -RISK_RULES.maxWeeklyDrawdown) {
    const reason = `Weekly drawdown limit (${weeklyPct.toFixed(2)}% <= -${RISK_RULES.maxWeeklyDrawdown}%)`;
    log(`REJECT weeklyDrawdown: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS weeklyDrawdown=${weeklyPct.toFixed(2)}%`);

  // 9. Min RR on TP1
  const tp1rr = plan.takeProfits?.[0]?.rr ?? 0;
  if (tp1rr < RISK_RULES.minRR) {
    const reason = `TP1 RR ${tp1rr} < ${RISK_RULES.minRR} minimum`;
    log(`REJECT minRR: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS minRR=${tp1rr}`);

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
