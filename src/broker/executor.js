// IG order placement gated by config.AUTO_TRADE + risk manager rules. Always logs a
// PRE-FLIGHT line before any POST so the GitHub Actions trace shows exactly what would
// be sent. config.DRY_EXECUTE=true short-circuits the actual order placement.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getAccountState, calculatePositionSize, checkRiskRules, RISK_RULES } from '../risk/manager.js';

const PLANS_DIR = path.resolve('plans');

const BASE_URL = config.IG_DEMO === false || config.IG_DEMO === 'false'
  ? 'https://api.ig.com/gateway/deal'
  : 'https://demo-api.ig.com/gateway/deal';

function igHeaders(session, version = 1) {
  return {
    'X-IG-API-KEY': config.IG_API_KEY,
    CST: session.cst,
    'X-SECURITY-TOKEN': session.xst,
    Accept: 'application/json; charset=UTF-8',
    'Content-Type': 'application/json',
    Version: String(version),
  };
}

async function igGet(session, p, version = 1) {
  const res = await fetch(`${BASE_URL}${p}`, { method: 'GET', headers: igHeaders(session, version) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IG GET ${p} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function igPost(session, p, body, version = 2) {
  const res = await fetch(`${BASE_URL}${p}`, {
    method: 'POST',
    headers: igHeaders(session, version),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`IG POST ${p} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Resolves the contract expiry dynamically so we don't hard-code 'JUN-26' or '-'.
// Spread bet/CFD spot: '-'. Futures: 'JUN-26' style. IG returns this in instrument.expiry.
async function resolveExpiry(session, epic) {
  try {
    const json = await igGet(session, `/markets/${epic}`, 3);
    return json?.instrument?.expiry ?? '-';
  } catch (err) {
    console.warn(`[executor] could not resolve expiry for ${epic}: ${err.message} — defaulting to '-'`);
    return '-';
  }
}

async function appendTrade(trade) {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(PLANS_DIR, today);
  const file = path.join(dir, 'trades.json');
  await fs.mkdir(dir, { recursive: true });
  let arr = [];
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) arr = parsed;
  } catch {}
  arr.push(trade);
  await fs.writeFile(file, JSON.stringify(arr, null, 2));
  return file;
}

async function placeIGOrder({ session, epic, expiry, direction, size, stopLevel, limitLevel }) {
  const body = {
    epic,
    expiry,
    direction: direction === 'long' ? 'BUY' : 'SELL',
    size: String(size),
    orderType: 'MARKET',
    timeInForce: 'FILL_OR_KILL',
    guaranteedStop: false,
    forceOpen: true,                          // safety: open new, never net against existing
    stopLevel: parseFloat(stopLevel),
    limitLevel: parseFloat(limitLevel),
    currencyCode: config.CURRENCY || 'AUD',
  };

  const created = await igPost(session, '/positions/otc', body, 2);
  const dealReference = created?.dealReference;
  if (!dealReference) {
    throw new Error(`IG /positions/otc: no dealReference (response=${JSON.stringify(created).slice(0, 200)})`);
  }

  // Confirm acceptance
  let confirm = null;
  try {
    confirm = await igGet(session, `/confirms/${dealReference}`, 1);
  } catch (err) {
    console.warn(`[executor] /confirms/${dealReference} fetch failed: ${err.message}`);
  }

  return {
    dealReference,
    dealId: confirm?.dealId ?? null,
    dealStatus: confirm?.dealStatus ?? 'UNKNOWN',
    reason: confirm?.reason ?? null,
    level: confirm?.level ?? null,
    size: confirm?.size ?? size,
  };
}

export async function executeIfApproved(plan, context, igSession) {
  const out = {
    executed: false,
    reason: 'N/A',
    trade: null,
    autoTrade: !!config.AUTO_TRADE,
    dryExecute: !!config.DRY_EXECUTE,
  };

  if (!config.AUTO_TRADE) {
    out.reason = 'Auto-trade disabled';
    console.log('[executor] AUTO_TRADE=false — signal only, no order placed');
    return out;
  }
  if (!plan?.direction) {
    out.reason = 'No directional signal';
    return out;
  }
  if (!igSession) {
    out.reason = 'No IG session';
    return out;
  }
  if (!context?.goldEpic) {
    out.reason = 'goldEpic missing from context';
    return out;
  }

  // 1. Account state
  let account = await getAccountState(igSession);
  if (!account.ok) {
    out.reason = `Account state fetch failed: ${account.error}`;
    return out;
  }
  // DRY_EXECUTE-only fallback: an unfunded LIVE account returns balance=0, which trips the
  // weekly-drawdown check at -100% before pre-flight can fire. In DRY mode that's pure
  // theatre — substitute the configured starting balance so the risk math is meaningful.
  if (config.DRY_EXECUTE && account.balance === 0) {
    console.log('[executor] DRY_EXECUTE: real balance is A$0 (account unfunded) — simulating with A$100 for risk math');
    account = { ...account, balance: 100, equity: 100, available: 100 };
  }
  console.log(`[executor] account: balance=A$${account.balance} available=A$${account.available} open=${account.openPositions.length}`);

  // 2. Risk rules — each PASS/REJECT logs its own [risk] line
  const risk = await checkRiskRules(plan, account, context);
  if (!risk.allowed) {
    out.reason = `Risk: ${risk.reason}`;
    return out;
  }

  // 3. Position sizing
  const riskPct = plan.risk?.suggestedRiskPct || RISK_RULES.maxRiskPerTrade;
  const sizing = calculatePositionSize(
    account.balance,
    Math.min(riskPct, RISK_RULES.maxRiskPerTrade),
    plan.entry.price,
    plan.stopLoss.price,
  );
  if (sizing.size === 0) {
    out.reason = sizing.reason;
    console.log(`[executor] sizing rejected: ${sizing.reason}`);
    return out;
  }
  console.log(`[executor] sizing: ${sizing.size} lots (A$${sizing.actualRisk} risk, ${sizing.riskPct}%)`);

  // 4. Resolve expiry from /markets
  const expiry = await resolveExpiry(igSession, context.goldEpic);

  // 5. PRE-FLIGHT — always logs before any POST
  const tp1 = plan.takeProfits?.[0]?.price;
  console.log(
    `[executor] PRE-FLIGHT: ${plan.direction} ${sizing.size} lots @ ${plan.entry.price.toFixed(2)} ` +
    `SL=${plan.stopLoss.price.toFixed(2)} TP=${tp1?.toFixed(2) ?? 'n/a'} ` +
    `expiry=${expiry} forceOpen=true`
  );

  // 6. DRY_EXECUTE short-circuit
  if (config.DRY_EXECUTE) {
    out.reason = 'DRY_EXECUTE mode — pre-flight logged, order skipped';
    console.log('[executor] DRY_EXECUTE=true — skipping POST to IG');
    out.trade = {
      mode: 'dry',
      direction: plan.direction,
      size: sizing.size,
      entry: plan.entry.price,
      sl: plan.stopLoss.price,
      tp1: tp1 ?? null,
      expiry,
      riskAmount: sizing.actualRisk,
      riskPct: sizing.riskPct,
    };
    return out;
  }

  // 7. Real order
  let placed;
  try {
    placed = await placeIGOrder({
      session: igSession,
      epic: context.goldEpic,
      expiry,
      direction: plan.direction,
      size: sizing.size,
      stopLevel: plan.stopLoss.price,
      limitLevel: tp1 ?? plan.takeProfits?.[0]?.price,
    });
  } catch (err) {
    out.reason = `IG order failed: ${err.message}`;
    console.error(`[executor] order failed: ${err.message}`);
    return out;
  }

  if (placed.dealStatus !== 'ACCEPTED') {
    out.reason = `IG rejected: ${placed.reason || placed.dealStatus}`;
    console.warn(`[executor] dealStatus=${placed.dealStatus} reason=${placed.reason}`);
    return out;
  }

  const trade = {
    timestamp: new Date().toISOString(),
    dealId: placed.dealId,
    dealReference: placed.dealReference,
    direction: plan.direction,
    size: sizing.size,
    entry: placed.level ?? plan.entry.price,
    sl: plan.stopLoss.price,
    tp1: plan.takeProfits?.[0]?.price ?? null,
    tp2: plan.takeProfits?.[1]?.price ?? null,
    tp3: plan.takeProfits?.[2]?.price ?? null,
    expiry,
    riskAmount: sizing.actualRisk,
    riskPct: sizing.riskPct,
    plan: {
      symbol: plan.symbol,
      timestamp: plan.timestamp,
      setupQuality: plan.setupQuality,
      confluenceCount: plan.confluenceCount,
      consensus: plan.consensus,
    },
  };

  await appendTrade(trade);
  console.log(`[executor] EXECUTED dealId=${placed.dealId} size=${sizing.size} risk=A$${sizing.actualRisk}`);

  out.executed = true;
  out.reason = `Order accepted: ${placed.dealId}`;
  out.trade = trade;
  return out;
}

// Used by /close command and emergency unwind.
export async function closePosition(igSession, dealId, direction, size) {
  const body = {
    dealId,
    direction: direction === 'long' ? 'SELL' : 'BUY',
    size: String(size),
    orderType: 'MARKET',
  };
  return igPost(igSession, '/positions/otc', { ...body, _method: 'DELETE' }, 1);
}
