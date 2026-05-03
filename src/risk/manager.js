// Hardcoded risk rules for the A$100 IG Australia account. These cannot be overridden
// from inside the LLM/consensus pipeline — auto-execution is gated by checkRiskRules.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export const RISK_RULES = {
  maxRiskPerTrade: 1.5,         // % of equity — up to A$1.50 on A$100 at Tier 1
  maxDailyLoss: 3.0,            // stop trading after -3% daily P&L
  maxWeeklyDrawdown: 8.0,       // pause until next week at -8%
  maxOpenPositions: 1,          // single concurrent position on $100 account
  maxDailyTrades: 4,
  minLotSize: 0.1,              // IG minimum
  maxLotSize: 0.5,              // hard cap for $100 account
  minRR: 1.5,                   // reject if TP1 RR < 1.5
  requiredConfluence: 5,
  requiredQuality: ['A+', 'A'],
  requiredConsensus: ['full'],  // only when both LLMs agree
  blockedSessions: ['off', 'asia'],
  fridayBlock: 15,              // no new trades after 15:00 UTC Friday
  newsBlackout: 30,             // minutes

  // Quality gates — only auto-execute A and A+ with full consensus
  autoExecuteQualities: ['A+', 'A'],
  autoExecuteConsensus: ['full'],   // both LLMs must agree

  // B quality → Telegram signal only, never auto-execute
  signalOnlyQualities: ['B'],

  // Wednesday block — backtest showed 0% WR
  blockedDays: [3],  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

  // Quality × tier execution matrix — risk % per trade (0 = signal only)
  executionMatrix: {
    'A+': { tier1: 1.5, tier2: 1.0, tier3: 0.5, tier4: 0 },
    'A':  { tier1: 1.5, tier2: 1.0, tier3: 0.5, tier4: 0 },
    'B':  { tier1: 1.0, tier2: 0.5, tier3: 0,   tier4: 0 },
  },

  // B-grade specific gates — extra filters beyond the matrix
  bGradeRequirements: {
    minTier: 2,
    requireFullConsensus: true,
    minConfluence: 5,
    maxRisk: 1.0,
  },
};

const PLANS_DIR = path.resolve('plans');
const STATE_FILE = path.resolve('src/risk/state.json');

const BASE_URL = config.IG_DEMO === false || config.IG_DEMO === 'false'
  ? 'https://api.ig.com/gateway/deal'
  : 'https://demo-api.ig.com/gateway/deal';

// Thin IG GET helper bound to a session passed in from the pipeline. Kept separate
// from src/data/ig.js because that module's helpers are private to itself.
async function igGet(session, path, version = 1) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      'X-IG-API-KEY': config.IG_API_KEY,
      CST: session.cst,
      'X-SECURITY-TOKEN': session.xst,
      Accept: 'application/json; charset=UTF-8',
      Version: String(version),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IG GET ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function getAccountState(igSession) {
  if (!igSession) {
    return { ok: false, error: 'no IG session', balance: 0, equity: 0, available: 0, openPositions: [], dailyPL: 0 };
  }

  let accounts, positions;
  try {
    [accounts, positions] = await Promise.all([
      igGet(igSession, '/accounts', 1),
      igGet(igSession, '/positions', 2),
    ]);
  } catch (err) {
    return { ok: false, error: err.message, balance: 0, equity: 0, available: 0, openPositions: [], dailyPL: 0 };
  }

  const wantId = config.IG_ACCOUNT_ID;
  const acct = wantId
    ? (accounts.accounts || []).find(a => a.accountId === wantId) || (accounts.accounts || [])[0]
    : (accounts.accounts || [])[0];

  const balance = acct?.balance?.balance ?? 0;
  const profitLoss = acct?.balance?.profitLoss ?? 0;
  const available = acct?.balance?.available ?? 0;
  const deposit = acct?.balance?.deposit ?? 0;

  const openPositions = (positions.positions || []).map(p => ({
    dealId: p.position?.dealId,
    direction: p.position?.direction === 'BUY' ? 'long' : 'short',
    size: p.position?.size ?? p.position?.contractSize ?? 0,
    pl: p.position?.profitLoss ?? null,
    sl: p.position?.stopLevel ?? null,
    tp: p.position?.limitLevel ?? null,
    epic: p.market?.epic ?? null,
    level: p.position?.level ?? null,
  }));

  return {
    ok: true,
    balance,
    equity: balance + profitLoss,
    available,
    deposit,
    openPositions,
    dailyPL: profitLoss,                 // best-effort — IG /accounts.profitLoss is the open P/L
    accountId: acct?.accountId || null,
    currency: acct?.currency || 'AUD',
  };
}

// Position sizing using straight risk math: riskAmount / SL distance = lot size,
// rounded down to nearest 0.1, bounded by min/max. Critical safety: if even 0.1 lots
// produces actual risk > 1.5x budget, reject — caller should wait for tighter M15 entry.
export function calculatePositionSize(balance, riskPct, entryPrice, slPrice) {
  const riskAmount = balance * (riskPct / 100);
  const slDistance = Math.abs(entryPrice - slPrice);
  if (!slDistance) {
    return { size: 0, reason: 'SL distance is zero — invalid plan', actualRisk: 0, riskPct: 0 };
  }

  const rawSize = riskAmount / slDistance;
  let size = Math.max(RISK_RULES.minLotSize, Math.min(RISK_RULES.maxLotSize, Math.floor(rawSize * 10) / 10));

  const actualRisk = size * slDistance;
  if (actualRisk > riskAmount * 1.5) {
    return {
      size: 0,
      reason: `SL too wide for $${balance.toFixed(2)} account (would risk A$${actualRisk.toFixed(2)} vs budget A$${riskAmount.toFixed(2)}) — wait for tighter M15 entry`,
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
      weekStartBalance: 100,
      cooldownUntil: null,
      openDeals: [],
    };
  }
}

export async function writeRiskState(state) {
  state.lastUpdated = new Date().toISOString();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// Each rule logs a [risk] line so the GitHub Actions trace shows exactly which rule
// rejected (or passed) the auto-execute decision.
export async function checkRiskRules(plan, accountState, context = {}) {
  const log = (msg) => console.log(`[risk] ${msg}`);

  // 1. Day-of-week block (Wednesday: 0% WR in backtest)
  const dayOfWeek = new Date().getUTCDay();
  if (RISK_RULES.blockedDays.includes(dayOfWeek)) {
    const reason = 'Wednesday blocked — historically weakest day';
    log(`REJECT dayOfWeek: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS dayOfWeek=${dayOfWeek}`);

  // 2. Execution matrix — quality × tier determines allowed risk
  const tier = plan.threeLayer?.tier ?? 4;
  const quality = plan.setupQuality;
  const matrix = RISK_RULES.executionMatrix[quality];
  if (!matrix) {
    const reason = `Unknown quality: ${quality}`;
    log(`REJECT executionMatrix: ${reason}`);
    return { allowed: false, reason };
  }
  const allowedRisk = matrix[`tier${tier}`] ?? 0;
  if (allowedRisk === 0) {
    const reason = (quality === 'B' && tier === 3)
      ? 'B Tier 3 — manual only, macro not aligned'
      : `${quality} at Tier ${tier} — signal only, no auto-execution`;
    log(`REJECT executionMatrix: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS executionMatrix: ${quality} Tier ${tier} → ${allowedRisk}%`);

  // B-grade extra checks
  if (quality === 'B') {
    if (tier > 2) {
      const reason = 'B-grade requires Tier 1 or 2 (all layers must align)';
      log(`REJECT bGrade: ${reason}`);
      return { allowed: false, reason };
    }
    if (plan.consensus?.agreement !== 'full') {
      const reason = 'B-grade requires full LLM consensus (both agree)';
      log(`REJECT bGrade: ${reason}`);
      return { allowed: false, reason };
    }
    if ((plan.confluenceCount ?? 0) < RISK_RULES.bGradeRequirements.minConfluence) {
      const reason = `B-grade needs ${RISK_RULES.bGradeRequirements.minConfluence}+ confluence (got ${plan.confluenceCount})`;
      log(`REJECT bGrade: ${reason}`);
      return { allowed: false, reason };
    }
    log(`PASS bGrade: Tier ${tier} | consensus=full | confluence=${plan.confluenceCount}`);
  }

  // Set risk % from matrix (bounded by overall cap)
  plan.risk.suggestedRiskPct = Math.min(allowedRisk, RISK_RULES.maxRiskPerTrade);

  // 3. Consensus — both LLMs must agree (full) for A+/A auto-execution
  const agreement = plan.consensus?.agreement || 'unknown';
  if (!RISK_RULES.autoExecuteConsensus.includes(agreement)) {
    const reason = `Split consensus — both LLMs must agree for auto-execution`;
    log(`REJECT consensus: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS consensus=${agreement}`);

  // 4. Confluence
  if ((plan.confluenceCount ?? 0) < RISK_RULES.requiredConfluence) {
    const reason = `Confluence ${plan.confluenceCount}/${RISK_RULES.requiredConfluence} too low`;
    log(`REJECT confluence: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS confluence=${plan.confluenceCount}`);

  // 5. Session
  const sess = plan.session?.current || 'unknown';
  if (RISK_RULES.blockedSessions.includes(sess)) {
    const reason = `Blocked session: ${sess}`;
    log(`REJECT session: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS session=${sess}`);

  // 6. Friday cutoff
  if (isAfterFridayCutoff()) {
    const reason = 'Friday afternoon cutoff (>=15:00 UTC)';
    log(`REJECT fridayCutoff: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS fridayCutoff`);

  // 7. News blackout
  const imminent = imminentHighImpactNews(context.calendar);
  if (imminent) {
    const reason = `News blackout: ${imminent.title} in ${imminent.minutesAway}m`;
    log(`REJECT news: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS news blackout`);

  // 8. Open positions
  const openCount = accountState.openPositions?.length ?? 0;
  if (openCount >= RISK_RULES.maxOpenPositions) {
    const reason = `${openCount} position(s) already open (max ${RISK_RULES.maxOpenPositions})`;
    log(`REJECT openPositions: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS openPositions=${openCount}`);

  // 9. Daily trade count
  const dailyTrades = (await getDailyTradeHistory()).length;
  if (dailyTrades >= RISK_RULES.maxDailyTrades) {
    const reason = `${dailyTrades} trades today — daily limit ${RISK_RULES.maxDailyTrades}`;
    log(`REJECT dailyTrades: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS dailyTrades=${dailyTrades}`);

  // 10. Daily P&L floor (best-effort using accountState.dailyPL)
  const dailyPctLoss = accountState.balance > 0 ? (accountState.dailyPL / accountState.balance) * 100 : 0;
  if (dailyPctLoss <= -RISK_RULES.maxDailyLoss) {
    const reason = `Daily loss limit hit (${dailyPctLoss.toFixed(2)}% <= -${RISK_RULES.maxDailyLoss}%)`;
    log(`REJECT dailyLoss: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS dailyPL=${dailyPctLoss.toFixed(2)}%`);

  // 11. Weekly drawdown
  const state = await readRiskState();
  const weekBase = state.weekStartBalance || RISK_RULES.weekStartBalance || 100;
  const weeklyPct = ((accountState.balance - weekBase) / weekBase) * 100;
  if (weeklyPct <= -RISK_RULES.maxWeeklyDrawdown) {
    const reason = `Weekly drawdown limit (${weeklyPct.toFixed(2)}% <= -${RISK_RULES.maxWeeklyDrawdown}%)`;
    log(`REJECT weeklyDrawdown: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS weeklyDrawdown=${weeklyPct.toFixed(2)}%`);

  // 12. Min RR on TP1
  const tp1rr = plan.takeProfits?.[0]?.rr ?? 0;
  if (tp1rr < RISK_RULES.minRR) {
    const reason = `TP1 RR ${tp1rr} < ${RISK_RULES.minRR} minimum`;
    log(`REJECT minRR: ${reason}`);
    return { allowed: false, reason };
  }
  log(`PASS minRR=${tp1rr}`);

  return { allowed: true, reason: `${quality} Tier ${tier} approved at ${plan.risk.suggestedRiskPct}% risk` };
}
