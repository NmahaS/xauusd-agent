// Hyperliquid order placement gated by config.AUTO_TRADE + risk manager rules.
// Always logs a PRE-FLIGHT line before any POST. config.DRY_EXECUTE=true short-circuits.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getAccountState, calculatePositionSize, checkRiskRules, RISK_RULES } from '../risk/manager.js';
import { placeHLOrder } from './hyperliquid.js';

const PLANS_DIR = path.resolve('plans');

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

export async function executeIfApproved(plan, context) {
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

  // 1. Account state from Hyperliquid
  let account = await getAccountState();
  if (!account.ok) {
    out.reason = `Account state fetch failed: ${account.error}`;
    return out;
  }
  if (config.DRY_EXECUTE && account.balance === 0) {
    console.log('[executor] DRY_EXECUTE: real balance is $0 — simulating with $10000 for risk math');
    account = { ...account, balance: 10000, equity: 10000, available: 10000 };
  }
  console.log(`[executor] account: balance=$${account.balance} available=$${account.available} open=${account.openPositions.length}`);

  // 2. Risk rules
  const risk = await checkRiskRules(plan, account, context);
  if (!risk.allowed) {
    out.reason = `Risk: ${risk.reason}`;
    return out;
  }

  // 3. Position sizing in XAU
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
  console.log(`[executor] sizing: ${sizing.size} XAU ($${sizing.actualRisk} risk, ${sizing.riskPct}%)`);

  // 4. Aggressive limit price — 0.3% through mark to ensure fill
  const markPrice = context.currentPrice ?? plan.entry.price;
  const limitPrice = plan.direction === 'long'
    ? markPrice * 1.003
    : markPrice * 0.997;

  // 5. PRE-FLIGHT — always logged before any POST
  const tp1 = plan.takeProfits?.[0]?.price;
  console.log(
    `[executor] PRE-FLIGHT: ${plan.direction} ${sizing.size} XAU @ $${limitPrice.toFixed(2)} ` +
    `SL=$${plan.stopLoss.price.toFixed(2)} TP=$${tp1?.toFixed(2) ?? 'n/a'} ` +
    `risk=${riskPct}% = $${sizing.actualRisk}`
  );

  // 6. DRY_EXECUTE short-circuit
  if (config.DRY_EXECUTE) {
    out.reason = 'DRY_EXECUTE mode — pre-flight logged, order skipped';
    console.log('[executor] DRY_EXECUTE=true — skipping POST to Hyperliquid');
    out.trade = {
      mode: 'dry',
      direction: plan.direction,
      size: sizing.size,
      entry: limitPrice,
      sl: plan.stopLoss.price,
      tp1: tp1 ?? null,
      riskAmount: sizing.actualRisk,
      riskPct: sizing.riskPct,
    };
    return out;
  }

  // 7. Real order
  let placed;
  try {
    placed = await placeHLOrder({
      coin: config.HL_COIN || 'PAXG',
      direction: plan.direction,
      size: sizing.size,
      limitPrice,
      stopLoss: plan.stopLoss.price,
      takeProfit: tp1 ?? null,
    });
  } catch (err) {
    out.reason = `HL order failed: ${err.message}`;
    console.error(`[executor] order failed: ${err.message}`);
    return out;
  }

  const trade = {
    timestamp: new Date().toISOString(),
    orderId: placed.orderId,
    direction: plan.direction,
    size: sizing.size,
    entry: placed.limitPrice ?? limitPrice,
    sl: plan.stopLoss.price,
    tp1: plan.takeProfits?.[0]?.price ?? null,
    tp2: plan.takeProfits?.[1]?.price ?? null,
    tp3: plan.takeProfits?.[2]?.price ?? null,
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
  console.log(`[executor] EXECUTED orderId=${placed.orderId} size=${sizing.size} XAU risk=$${sizing.actualRisk}`);

  out.executed = true;
  out.reason = `Order placed: ${placed.orderId}`;
  out.trade = trade;
  return out;
}

// Close an open Hyperliquid position (used by /close command).
export async function closePosition(coin, direction, size) {
  const { closeHLPosition } = await import('./hyperliquid.js');
  return closeHLPosition(coin, direction, size);
}
