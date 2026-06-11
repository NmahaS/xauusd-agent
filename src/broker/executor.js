// Hyperliquid order placement gated by AUTO_TRADE + risk manager rules.
// Always logs a PRE-FLIGHT line before any POST. DRY_EXECUTE=true short-circuits.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAccountState, checkRiskRules, RISK_RULES } from '../risk/manager.js';
import { placeHLOrder, closeHLPosition } from './hyperliquid.js';
import { config } from '../config.js';

const PLANS_DIR = path.join(process.cwd(), 'plans');
// Persists the FIRST trade's SL point-distance so every compound trails the same distance.
// Lives in data/ (Railway-persistent). One file per open position; cleared when the position closes.
const POSITION_STATE_FILE = path.join(process.cwd(), 'data', 'position-state.json');
const MAX_POSITION_SIZE = 0.25;  // hard cap on PAXG position size (~2% risk at 8pt SL)

let isReconciling = false;

async function readPositionState() {
  try {
    return JSON.parse(await fs.readFile(POSITION_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writePositionState(state) {
  await fs.mkdir(path.dirname(POSITION_STATE_FILE), { recursive: true });
  await fs.writeFile(POSITION_STATE_FILE, JSON.stringify(state, null, 2));
}

async function clearPositionState() {
  try {
    await fs.unlink(POSITION_STATE_FILE);
    console.log('[executor] position state cleared');
  } catch {}
}

// New entry: risk exactly 1% of balance against the structural SL distance, hard-capped + floored.
function calculateNewEntrySize(balance, entryPrice, slPrice) {
  const riskPct = 1.0;
  const riskAmount = balance * (riskPct / 100);
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance <= 0) throw new Error('Invalid SL distance: ' + slDistance);

  let size = riskAmount / slDistance;
  size = Math.min(size, MAX_POSITION_SIZE);
  size = Math.max(0.001, parseFloat(size.toFixed(3)));  // 3dp = PAXG szDecimals (what HL accepts)

  console.log('[sizing] NEW ENTRY:');
  console.log('  balance: $' + balance.toFixed(2));
  console.log('  risk: 1% = $' + riskAmount.toFixed(2));
  console.log('  SL distance: ' + slDistance.toFixed(2) + 'pts');
  console.log('  size: ' + size.toFixed(4) + ' PAXG');
  console.log('  actual risk: $' + (size * slDistance).toFixed(2));
  return size;
}

// Compound add: 0.5% of balance sized against the FIRST trade's SL distance (kept constant).
function calculateCompoundSize(balance, firstSLDistance) {
  const compoundRiskPct = 0.5;
  const riskAmount = balance * (compoundRiskPct / 100);
  if (!(firstSLDistance > 0)) throw new Error('Invalid first SL distance: ' + firstSLDistance);

  let size = riskAmount / firstSLDistance;
  size = Math.min(size, MAX_POSITION_SIZE);
  size = Math.max(0.001, parseFloat(size.toFixed(3)));  // 3dp = PAXG szDecimals (what HL accepts)

  console.log('[sizing] COMPOUND:');
  console.log('  balance: $' + balance.toFixed(2));
  console.log('  risk: 0.5% = $' + riskAmount.toFixed(2));
  console.log('  using first SL distance: ' + firstSLDistance.toFixed(2) + 'pts');
  console.log('  compound size: ' + size.toFixed(4) + ' PAXG');
  console.log('  added risk: $' + (size * firstSLDistance).toFixed(2));
  return size;
}

async function getLastTradeMeta() {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(PLANS_DIR, today, 'trades.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[arr.length - 1] ?? null;
  } catch {
    return null;
  }
}

async function sendPositionDecisionMsg(type, data) {
  if (process.env.DRY_RUN === 'true') return;
  const { sendTelegramMessage } = await import('../telegram/notify.js');
  try {
    if (type === 'hold') {
      const pnl = data.unrealizedPnl ?? 0;
      const pnlStr = pnl < 0
        ? `-$${Math.abs(pnl).toFixed(2)}`
        : `+$${pnl.toFixed(2)}`;
      await sendTelegramMessage(
        `⏸ <b>Holding existing ${(data.existingDirection || '').toUpperCase()} — position at ${pnlStr} (no average down)</b>\n` +
        `<i>${data.reason}</i>`
      );
    } else if (type === 'compound') {
      await sendTelegramMessage(
        `📈 <b>Compounding ${(data.existingDirection || '').toUpperCase()} at ${(data.risk ?? '?')}% risk</b>\n` +
        `Position profitable — adding at half risk\n` +
        `<i>${data.reason}</i>`
      );
    } else if (type === 'flip') {
      await sendTelegramMessage(
        `🔄 <b>Position flip</b>\n` +
        `Closing ${(data.existingDirection || '').toUpperCase()} → Opening ${(data.newDirection || '').toUpperCase()}\n` +
        `<i>${data.reason}</i>`
      );
    }
  } catch (err) {
    console.warn(`[executor] Telegram ${type} msg failed: ${err.message}`);
  }
}

async function handleExistingPosition(existingPosition, plan, balance) {
  const lastMeta = await getLastTradeMeta();
  const existingTier = lastMeta?.tier ?? 4;
  const existingConfluence = lastMeta?.confluenceCount ?? 0;
  const newTier = plan.threeLayer?.tier ?? 4;
  const newConfluence = plan.confluenceCount ?? 0;

  console.log(`[executor] position check: existing ${existingPosition.direction} T${existingTier}/C${existingConfluence} vs new ${plan.direction} T${newTier}/C${newConfluence}`);

  if (existingPosition.direction === plan.direction) {
    const unrealizedPnl = existingPosition.unrealizedPnl || 0;
    if (unrealizedPnl >= 0) {
      console.log(`[executor] same direction ${existingPosition.direction} +$${unrealizedPnl.toFixed(2)} — COMPOUNDING`);
      // Dead-zone compounds are now governed by the dead-zone gate at the top of
      // executeIfApproved (strict confluence ≥ 7 + ATR ≥ 8). If we reached here in the dead
      // zone, the gate already approved it — so no separate dead-zone block here.

      // Compound model: add 0.5% each time (1% → 1.5% → 2% → 2.5%), sized against the FIRST
      // trade's SL distance held in position state. Capped at 3 compounds. No state (e.g. a
      // position opened before this feature) → hold; the next NEW entry establishes state.
      const coinName = process.env.HL_COIN || 'PAXG';
      const posState = await readPositionState();
      if (!posState || posState.coin !== coinName ||
          posState.direction !== existingPosition.direction || !(posState.firstSLDistance > 0)) {
        return {
          action: 'hold',
          reason: 'No matching position state for compound — holding (state is set on the next new entry)',
          unrealizedPnl,
        };
      }

      const MAX_COMPOUNDS = 3;
      const newCompoundCount = (posState.compoundCount || 0) + 1;
      if (newCompoundCount > MAX_COMPOUNDS) {
        return {
          action: 'hold',
          reason: `Max ${MAX_COMPOUNDS} compounds reached (current: ${posState.compoundCount})`,
          unrealizedPnl,
        };
      }

      const newTotalRisk = 1.0 + newCompoundCount * 0.5;
      const compoundSize = calculateCompoundSize(balance, posState.firstSLDistance);
      console.log(`[compound] count: ${newCompoundCount}/${MAX_COMPOUNDS} | total risk after: ${newTotalRisk}%`);

      posState.compoundCount = newCompoundCount;
      posState.totalRiskPct = newTotalRisk;
      await writePositionState(posState);

      return {
        action: 'compound',
        size: compoundSize,
        reason: `Compound ${newCompoundCount}/${MAX_COMPOUNDS} — +0.5% (total ${newTotalRisk}%)`,
      };
    } else {
      console.log(`[executor] same direction ${existingPosition.direction} -$${Math.abs(unrealizedPnl).toFixed(2)} — holding, no average down`);
      return { action: 'hold', reason: `Position losing $${unrealizedPnl.toFixed(2)} — no average down`, unrealizedPnl };
    }
  }

  const consensus = plan?.consensus?.agreement;
  const openTime = existingPosition?.openTime || existingPosition?.entryTime;
  const hoursOpen = openTime
    ? (Date.now() - new Date(openTime).getTime()) / 3600000
    : 0;

  console.log(`[executor] flip eval: existing ${existingPosition.direction} T${existingTier}/C${existingConfluence} open ${hoursOpen.toFixed(1)}h`);
  console.log(`[executor] flip eval: new ${plan.direction} T${newTier}/C${newConfluence} consensus=${consensus}`);

  const tierOK = newTier <= 2;
  const confluenceOK = newConfluence >= existingConfluence + 3;
  const timeOK = hoursOpen >= 4;
  const consensusOK = consensus === 'full';
  const shouldFlip = tierOK && confluenceOK && timeOK && consensusOK;

  if (shouldFlip) {
    console.log('[executor] FLIP approved ✅');
    return {
      action: 'flip',
      reason: `Flip: T${newTier}/C${newConfluence} ${plan.direction} — all conditions met`,
    };
  }

  const flipReasons = [];
  if (!tierOK) flipReasons.push(`need T1-2 (got T${newTier})`);
  if (!confluenceOK) flipReasons.push(`need C${existingConfluence + 3}+ (got ${newConfluence})`);
  if (!timeOK) flipReasons.push(`need 4h (${hoursOpen.toFixed(1)}h open)`);
  if (!consensusOK) flipReasons.push(`need full consensus (got ${consensus})`);

  console.log(`[executor] flip BLOCKED: ${flipReasons.join(', ')}`);
  return {
    action: 'hold',
    reason: `Flip blocked: ${flipReasons.join(', ')} — holding ${existingPosition.direction}`,
  };
}

export function calculateSingleTP(entryPrice, slPrice, direction, targetRR = 2.0) {
  const slDistance = Math.abs(entryPrice - slPrice);
  const tpDistance = slDistance * targetRR;
  const tp = direction === 'long'
    ? entryPrice + tpDistance
    : entryPrice - tpDistance;

  console.log('[tp] entry:', entryPrice.toFixed(2),
    'SL:', slPrice.toFixed(2),
    'dist:', slDistance.toFixed(2) + 'pts',
    'RR:', targetRR + 'R',
    'TP:', tp.toFixed(2));

  return parseFloat(tp.toFixed(1));
}

function getDynamicSLTP(direction, entryPrice, atr) {
  const isTrending = atr >= 15;
  const isNormal = atr >= 8 && atr < 15;

  // SL distance adapts to volatility (regime), but the reward target is a flat TARGET_RR (2R)
  // on every trade — so 1% risk always targets a 2% gain regardless of regime.
  let slMultiplier, label;
  if (isTrending) {
    slMultiplier = 1.5;
    label = 'trending';
  } else if (isNormal) {
    slMultiplier = 1.0;
    label = 'normal';
  } else {
    slMultiplier = 0.8;
    label = 'quiet';
  }
  const tpRR = parseFloat(process.env.TARGET_RR || '2.0');

  const slDistance = atr * slMultiplier;
  const tpDistance = slDistance * tpRR;
  const slPrice = direction === 'long' ? entryPrice - slDistance : entryPrice + slDistance;
  const tpPrice = direction === 'long' ? entryPrice + tpDistance : entryPrice - tpDistance;

  console.log(`[sizing] ATR: ${atr.toFixed(2)}pts | regime: ${label}`);
  console.log(`[sizing] SL: ${slDistance.toFixed(2)}pts (${slMultiplier}x ATR) | TP: ${tpDistance.toFixed(2)}pts (${tpRR}R)`);
  console.log(`[sizing] SL price: $${slPrice.toFixed(2)} | TP price: $${tpPrice.toFixed(2)}`);

  return { slPrice, tpPrice, slDistance, tpDistance, tpRR, label, slMultiplier };
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

export async function executeIfApproved(plan, context) {
  const autoTradeEnabled = process.env.AUTO_TRADE === 'true';
  const dryExecuteEnabled = process.env.DRY_EXECUTE === 'true';

  console.log('[executor] env check: AUTO_TRADE=' + process.env.AUTO_TRADE + ' DRY_EXECUTE=' + process.env.DRY_EXECUTE);
  console.log(`[executor] AUTO_TRADE=${process.env.AUTO_TRADE} → enabled=${autoTradeEnabled}`);
  console.log(`[executor] DRY_EXECUTE=${process.env.DRY_EXECUTE} → dry=${dryExecuteEnabled}`);

  const coin = process.env.HL_COIN || 'PAXG';
  const utcHour = new Date().getUTCHours();
  const isDeadZone = utcHour >= 0 && utcHour < 6;

  if (isDeadZone) {
    const tier = plan?.threeLayer?.tier;
    const confluence = plan?.confluenceCount || 0;
    const atr = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? 0;

    const { getHLPositions } = await import('../broker/hyperliquid.js');
    const positions = await getHLPositions();
    const existing = positions.find(p => p.coin === coin);

    console.log('[executor] dead zone check:',
      'tier='+tier, 'confluence='+confluence,
      'atr='+atr?.toFixed(2),
      'existing='+(existing ? existing.direction : 'none'));

    if (existing) {
      // Position open — allow same-direction compound only; never flip in the dead zone.
      if (plan.direction && existing.direction !== plan.direction) {
        return {
          executed: false,
          reason: 'Dead zone: ' + existing.direction.toUpperCase() +
                  ' position open, ' + String(plan.direction).toUpperCase() +
                  ' signal — no flip in dead zone',
        };
      }

      // Same direction — allow compound only under strict dead-zone rules.
      if (confluence < 5) {
        return {
          executed: false,
          reason: 'Dead zone compound: confluence ' + confluence +
                  '/12 too low (need 5+)',
        };
      }
      if (atr < 7) {
        return {
          executed: false,
          reason: 'Dead zone compound: ATR ' + atr?.toFixed(2) +
                  'pts too low (need 7pts in dead zone)',
        };
      }

      console.log('[executor] dead zone COMPOUND allowed:',
        'same direction ' + plan.direction +
        ', T' + tier + ' C' + confluence + ' ATR' + atr?.toFixed(1));
      // Continue — compound is decided by handleExistingPosition below.
    } else {
      // No position — strict new-entry rules.
      if (atr < 7) {
        return {
          executed: false,
          reason: 'Dead zone: ATR ' + atr?.toFixed(2) + 'pts too low (need 7pts)',
        };
      }
      if (confluence < 5) {
        return {
          executed: false,
          reason: 'Dead zone: confluence ' + confluence + '/12 too low (need 5+)',
        };
      }
      if (tier === 4) {
        return {
          executed: false,
          reason: 'Dead zone: Tier 4 blocked',
        };
      }
      console.log('[executor] dead zone NEW ENTRY allowed:',
        'T' + tier + ' C' + confluence + ' ATR' + atr?.toFixed(1));
    }
  }

  const out = {
    executed: false,
    reason: 'N/A',
    trade: null,
    autoTrade: autoTradeEnabled,
    dryExecute: dryExecuteEnabled,
  };

  if (!autoTradeEnabled) {
    out.reason = `AUTO_TRADE env var is "${process.env.AUTO_TRADE}" not "true"`;
    console.log(`[executor] AUTO_TRADE=false — signal only, no order placed`);
    return out;
  }
  if (!plan?.direction) {
    out.reason = 'No directional signal';
    return out;
  }

  // 0. Cancel-on-new-signal: every 15-min cycle cancels all resting entry orders and places a
  //    fresh one based on the current signal and price. This keeps entries up-to-date each cycle.
  try {
    const { getOpenOrdersDetailed, cancelOrder } = await import('./hyperliquid.js');

    const openOrders = await getOpenOrdersDetailed();
    const pendingEntries = openOrders.filter(o =>
      o.coin === coin &&
      !o.reduceOnly &&
      o.orderType !== 'Stop Market' &&
      !o.isTrigger
    );

    if (pendingEntries.length > 0) {
      console.log('[executor] cancelling', pendingEntries.length, 'pending entry order(s) for new signal cycle');

      for (const order of pendingEntries) {
        try {
          await cancelOrder(coin, order.oid);
          console.log('[executor] cancelled pending order', order.oid,
            '(', order.side === 'B' ? 'long' : 'short', 'limit @ $' + order.limitPx + ')');
        } catch (err) {
          console.error('[executor] cancel failed:', err.message);
        }
      }

      // Wait for cancellations to settle before placing fresh order
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.warn('[executor] pending-order check failed (non-fatal):', err.message);
  }

  // 1. Account state from Hyperliquid
  let account = await getAccountState();
  if (!account.ok) {
    out.reason = `Account state fetch failed: ${account.error}`;
    return out;
  }
  if (dryExecuteEnabled && account.balance === 0) {
    console.log('[executor] DRY_EXECUTE: real balance is $0 — simulating with $10000 for risk math');
    account = { ...account, balance: 10000, equity: 10000, available: 10000 };
  }
  console.log(`[executor] account: balance=$${account.balance} available=$${account.available} open=${account.openPositions.length}`);

  // 1.5: Smart position handling — hold or flip on existing position
  const existingPos = account.openPositions?.find(p => p.coin === coin);
  let positionDecision = null;
  let existingSLPrice = null;  // compounds keep the original stop and size the add against it
  if (existingPos) {
    positionDecision = await handleExistingPosition(existingPos, plan, account.balance);
    console.log(`[executor] position decision: ${positionDecision.action} — ${positionDecision.reason}`);

    if (positionDecision.action === 'hold') {
      out.reason = `Position held: ${positionDecision.reason}`;
      await sendPositionDecisionMsg('hold', {
        existingDirection: existingPos.direction,
        reason: positionDecision.reason,
        unrealizedPnl: existingPos.unrealizedPnl ?? 0,
      });
      return out;
    }

    if (positionDecision.action === 'compound') {
      // Keep the existing stop on a winner; size the add against IT (0.5% risk to the real stop).
      try {
        const { getOpenOrdersDetailed } = await import('./hyperliquid.js');
        const sl = (await getOpenOrdersDetailed()).find(o =>
          o.coin === coin && o.reduceOnly &&
          (o.isTrigger === true || o.orderType === 'Stop Market' || o.orderType === 'Stop Limit')
        );
        if (sl) existingSLPrice = sl.triggerPx ?? sl.limitPx;
      } catch (err) {
        console.warn('[executor] compound: existing SL fetch failed:', err.message);
      }
      const compoundRiskPct = Math.min(config.DEFAULT_RISK_PCT, RISK_RULES.maxRiskPerTrade) * 0.5;
      console.log(`[executor] compound — adding at half risk (${compoundRiskPct}%), existing SL ${existingSLPrice != null ? existingSLPrice.toFixed(2) : 'n/a'}`);
      await sendPositionDecisionMsg('compound', {
        existingDirection: existingPos.direction,
        reason: positionDecision.reason,
        risk: compoundRiskPct,
      });
      // Fall through — place the compound order at half risk (computed in riskPct below)
    }

    if (positionDecision.action === 'flip') {
      // Send notification then close existing before opening new
      await sendPositionDecisionMsg('flip', {
        existingDirection: existingPos.direction,
        newDirection: plan.direction,
        reason: positionDecision.reason,
      });

      if (!dryExecuteEnabled) {
        try {
          console.log(`[executor] closing ${existingPos.direction} ${coin} (${existingPos.size}) before flip`);
          await closeHLPosition(coin, existingPos.direction, existingPos.size);
          console.log('[executor] position closed — waiting 2s before opening new');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (err) {
          out.reason = `Flip failed — could not close existing position: ${err.message}`;
          console.error(`[executor] flip close error: ${err.message}`);
          return out;
        }
        account = await getAccountState();
        if (!account.ok) {
          out.reason = `Account re-fetch failed after flip: ${account.error}`;
          return out;
        }
        console.log(`[executor] post-flip account: balance=$${account.balance} available=$${account.available}`);
      } else {
        console.log(`[executor] DRY_EXECUTE — skipping actual position close for flip`);
      }
    }
  }

  // 2. Risk rules
  const risk = await checkRiskRules(plan, account, context);
  if (!risk.allowed) {
    out.reason = `Risk: ${risk.reason}`;
    return out;
  }

  // 3. Position sizing — model:
  //    NEW entry → risk exactly 1% of balance against the structural SL distance; TP = 2R.
  //    COMPOUND  → add 0.5%, sized against the FIRST trade's SL point-distance (from position
  //                state). reconcileUnifiedSL then trails the unified SL/TP to that same distance
  //                from the new weighted-average entry right after the fill.
  const entryPrice = context.currentPrice || plan.entry?.price;
  console.log(`[executor] market entry at current price: $${entryPrice}`);

  const atr = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? 8;
  const dynamicLevels = getDynamicSLTP(plan.direction, entryPrice, atr);
  const tpRR = dynamicLevels.tpRR;

  // slDistance = the SL distance used for the order's inline bracket; riskDistance = the distance
  // the sizing risk is measured against (the FIRST SL distance on a compound, so the add ≈ 0.5%).
  let finalSL, slDistance, riskDistance, riskPct, size;
  if (positionDecision?.action === 'compound') {
    riskPct = 0.5;
    const posState = await readPositionState();
    riskDistance = posState?.firstSLDistance
      ?? (existingSLPrice != null && existingSLPrice > 0
        ? Math.abs(entryPrice - existingSLPrice)
        : dynamicLevels.slDistance);
    size = positionDecision.size ?? calculateCompoundSize(account.balance, riskDistance);
    // Keep the existing stop for the inline bracket; reconcileUnifiedSL re-derives the unified
    // SL/TP from the new weighted-avg entry (trailing the first SL distance) after the fill.
    finalSL = (existingSLPrice != null && existingSLPrice > 0)
      ? existingSLPrice
      : (plan.direction === 'long' ? entryPrice - riskDistance : entryPrice + riskDistance);
    slDistance = Math.abs(entryPrice - finalSL);
    console.log(`[executor] compound — first SL distance ${riskDistance.toFixed(2)}pts, inline SL ${finalSL.toFixed(2)} (reconcile trails to avg entry)`);
  } else {
    // New entry: trust the LLM/plan structural SL when it sits the correct side of entry with a
    // sane buffer; otherwise fall back to the ATR-based dynamic SL (always correct side).
    riskPct = 1.0;
    const planSL = plan.stopLoss?.price ?? null;
    const minSLDistance = Math.max(dynamicLevels.slDistance * 0.5, atr * 0.5);
    const planSLValid = planSL != null && (
      plan.direction === 'long'
        ? planSL <= entryPrice - minSLDistance
        : planSL >= entryPrice + minSLDistance
    );
    if (planSL != null && !planSLValid) {
      console.warn(`[executor] plan SL ${planSL} invalid for ${plan.direction} @ entry ${entryPrice} ` +
        `(needs ${minSLDistance.toFixed(2)}pts buffer on correct side) — using ATR SL ${dynamicLevels.slPrice.toFixed(2)}`);
    }
    finalSL = planSLValid ? planSL : dynamicLevels.slPrice;
    slDistance = Math.abs(entryPrice - finalSL);
    riskDistance = slDistance;
    if (!slDistance || isNaN(slDistance)) {
      out.reason = 'SL distance is zero or invalid — check entry/SL prices in plan';
      console.log(`[executor] sizing rejected: ${out.reason}`);
      return out;
    }
    size = calculateNewEntrySize(account.balance, entryPrice, finalSL);
  }

  // TP is always 2R, measured from entry off the canonical risk distance (= structural SL
  // distance on a new entry, = first SL distance on a compound).
  const finalTP = plan.direction === 'long'
    ? parseFloat((entryPrice + riskDistance * tpRR).toFixed(1))
    : parseFloat((entryPrice - riskDistance * tpRR).toFixed(1));
  const tpDistance = Math.abs(finalTP - entryPrice);
  const riskAmount = account.balance * (riskPct / 100);

  console.log('[executor] plan SL price:', plan?.stopLoss?.price);
  console.log('[executor] dynamic SL price:', dynamicLevels?.slPrice?.toFixed(2));
  console.log('[executor] using SL:', finalSL?.toFixed(2));
  console.log('[executor] TARGET_RR:', process.env.TARGET_RR);
  console.log('[executor] tpDistance:', tpDistance.toFixed(2) + 'pts');
  console.log('[executor] tpPrice:', finalTP.toFixed(2));

  console.log('[executor] SL distance:', slDistance.toFixed(2) + 'pts');
  console.log(`[executor] entry=${entryPrice} SL=${finalSL.toFixed(2)} distance=${slDistance.toFixed(2)}pts`);
  console.log(`[executor] riskAmount=$${riskAmount.toFixed(2)} riskPct=${riskPct}% balance=$${account.balance.toFixed(2)}`);

  if (!slDistance || isNaN(slDistance)) {
    out.reason = 'SL distance is zero or invalid — check entry/SL prices in plan';
    console.log(`[executor] sizing rejected: ${out.reason}`);
    return out;
  }

  // Final guards: hard cap + floor (helpers already clamp, but guard again after either branch).
  if (size > MAX_POSITION_SIZE) {
    console.warn(`[sizing] HARD CAP: ${size} → ${MAX_POSITION_SIZE} PAXG (max position size protection)`);
    size = MAX_POSITION_SIZE;
  }
  size = Math.max(0.001, parseFloat(size.toFixed(3)));  // 3dp = PAXG szDecimals (what HL accepts)

  // actualRisk = risk to the canonical stop (first SL distance on a compound → add ≈ 0.5%).
  const actualRisk = size * riskDistance;

  console.log('[sizing] balance:', account.balance.toFixed(2));
  console.log('[sizing] riskPct:', riskPct + '%');
  console.log('[sizing] riskAmount: $' + riskAmount.toFixed(3));
  console.log('[sizing] slDistance:', slDistance.toFixed(2) + 'pts');
  console.log('[sizing] riskDistance:', riskDistance.toFixed(2) + 'pts');
  console.log('[sizing] size:', size.toFixed(4) + ' PAXG');
  console.log('[sizing] notional: $' + (size * entryPrice).toFixed(2));
  console.log('[sizing] expected 1R loss: $' + (size * riskDistance).toFixed(3));
  console.log('[sizing] expected 2R gain: $' + (size * riskDistance * 2).toFixed(3));
  console.log('[sizing] RR ratio:', (tpDistance / slDistance).toFixed(2) + 'R');

  if (actualRisk > riskAmount * 1.5) {
    out.reason = `SL too wide for $${account.balance.toFixed(2)} account — would risk $${actualRisk.toFixed(2)} vs budget $${riskAmount.toFixed(2)}, wait for tighter M15 entry`;
    console.log(`[executor] sizing rejected: ${out.reason}`);
    return out;
  }

  const sizing = {
    size,
    actualRisk: parseFloat(actualRisk.toFixed(2)),
    riskPct: ((actualRisk / account.balance) * 100).toFixed(2),
  };

  console.log(`[executor] sizing: ${sizing.size} PAXG ($${sizing.actualRisk} risk, ${sizing.riskPct}%)`);

  // Compound total size cap
  if (positionDecision?.action === 'compound' && existingPos) {
    const totalAfterCompound = existingPos.size + sizing.size;
    const MAX_TOTAL_POSITION = 0.25;  // same cap as single entry (was 0.15)
    if (totalAfterCompound > MAX_TOTAL_POSITION) {
      console.warn(`[executor] compound blocked: total would be ${totalAfterCompound} PAXG (max ${MAX_TOTAL_POSITION})`);
      out.reason = 'Compound blocked: total ' + totalAfterCompound.toFixed(3) +
        ' would exceed ' + MAX_TOTAL_POSITION + ' PAXG max';
      return out;
    }
  }

  // 4. Mark price + order mode detection
  const markPrice = context.currentPrice ?? plan.entry.price;
  const planEntry = plan.entry?.price || markPrice;
  const distanceToEntry = Math.abs(markPrice - planEntry);
  const useMaker = distanceToEntry <= 8 && !!plan.entry?.price;

  console.log('[executor] entry distance:', distanceToEntry.toFixed(2) + 'pts');
  console.log('[executor] order mode:', useMaker ? 'MAKER (GTC)' : 'TAKER (GTC)');

  // 5. PRE-FLIGHT — always logged before any POST
  console.log(
    `[executor] PRE-FLIGHT: ${useMaker ? 'MAKER (GTC)' : 'TAKER (GTC)'} ${plan.direction.toUpperCase()} ${sizing.size} PAXG` +
    ` markPrice=${markPrice}` +
    ` SL=${finalSL.toFixed(2)} TP=${finalTP.toFixed(2)} (${dynamicLevels.tpRR}R)` +
    ` risk=${riskPct}% = $${sizing.actualRisk}`
  );

  // 6. DRY_EXECUTE short-circuit
  if (dryExecuteEnabled) {
    out.reason = 'DRY_EXECUTE mode — pre-flight logged, order skipped';
    console.log('[executor] DRY_EXECUTE=true — skipping POST to Hyperliquid');
    out.trade = {
      mode: 'dry',
      direction: plan.direction,
      size: sizing.size,
      entry: markPrice,
      sl: finalSL,
      tp: finalTP,
      targetRR: dynamicLevels.tpRR,
      riskAmount: sizing.actualRisk,
      riskPct: sizing.riskPct,
      tier: plan.threeLayer?.tier ?? null,
      confluenceCount: plan.confluenceCount ?? null,
      quality: plan.setupQuality ?? null,
    };
    return out;
  }

  // 7. Real order (GTC limit) — SL/TP attach after fill via reconcileUnifiedSL
  let placed;
  try {
    placed = await placeHLOrder({
      coin: process.env.HL_COIN || 'PAXG',
      direction: plan.direction,
      size: sizing.size,
      markPrice,
      plan,
      orderMode: useMaker ? 'maker' : 'taker',
      context,
      finalSL,
      finalTP,
    });
  } catch (err) {
    out.reason = `HL order failed: ${err.message}`;
    console.error(`[executor] order failed: ${err.message}`);
    return out;
  }

  if (positionDecision?.action === 'compound' && existingPos && !dryExecuteEnabled) {
    const compoundFillPrice = placed.fillPrice || markPrice;
    const compoundFillSize = placed.fillSize ?? sizing.size;
    const totalSize = existingPos.size + compoundFillSize;
    console.log('[executor] compound fill price:', compoundFillPrice.toFixed(2));
    console.log('[executor] compound total size:', totalSize, coin);
    if (process.env.DRY_RUN !== 'true') {
      const { sendTelegramMessage } = await import('../telegram/notify.js');
      await sendTelegramMessage(
        `📈 <b>Position compounded</b>\n` +
        `Added: ${compoundFillSize} ${coin} @ $${compoundFillPrice.toFixed(2)}\n` +
        `Total size: ${totalSize} ${coin}\n` +
        `<i>Reconciling unified SL/TP...</i>`
      ).catch(err => console.warn(`[executor] compound Telegram failed: ${err.message}`));
    }
  }

  const trade = {
    timestamp: new Date().toISOString(),
    orderId: placed.orderId,
    direction: plan.direction,
    size: placed.fillSize ?? sizing.size,
    entry: placed.fillPrice ?? markPrice,
    sl: finalSL,
    tp: placed.tpPrice ?? finalTP,
    targetRR: dynamicLevels.tpRR,
    slPlaced: placed.slPlaced ?? false,
    tpPlaced: placed.tpPlaced ?? false,
    riskAmount: sizing.actualRisk,
    riskPct: sizing.riskPct,
    tier: plan.threeLayer?.tier ?? null,
    confluenceCount: plan.confluenceCount ?? null,
    quality: plan.setupQuality ?? null,
    orderMode: useMaker ? 'maker' : 'taker',
    feeRate: useMaker ? 0.010 : 0.035,
    plan: {
      symbol: plan.symbol,
      timestamp: plan.timestamp,
      setupQuality: plan.setupQuality,
      confluenceCount: plan.confluenceCount,
      consensus: plan.consensus,
    },
  };

  // Exit early if the GTC entry is still resting — no position yet, so no SL/TP to place.
  // The resting order waits on the book; the next pipeline run re-checks it (keep or cancel).
  if (placed.status === 'unfilled' || !placed.fillSize) {
    const pendPx = placed.fillPrice ?? markPrice;
    out.reason = 'Limit order pending — waiting for fill @ $' + Number(pendPx).toFixed(2);
    out.pendingOrderId = placed.orderId ?? null;
    console.warn('[executor] entry order resting (GTC) — no fill yet, SL/TP deferred to next run');
    return out;
  }

  await appendTrade(trade);
  console.log(`[executor] EXECUTED orderId=${placed.orderId} size=${sizing.size} XAU risk=$${sizing.actualRisk}`);

  // Store the FIRST trade's parameters so every compound trails the same SL point-distance.
  // A compound add must NOT overwrite this (it keeps the original distance + compound count).
  if (positionDecision?.action !== 'compound') {
    const firstEntry = placed.fillPrice ?? markPrice;
    // Store the distance the SIZE was computed against (entry-based abs(entry − SL), per the
    // model) — NOT abs(fill − SL), which drifts with slippage. reconcileUnifiedSL trails this
    // exact distance from the avg entry, so realized risk matches the intended 1% / 0.5%.
    const firstSLDistance = slDistance;
    await writePositionState({
      coin,
      direction: plan.direction,
      firstEntry,
      firstSLDistance,
      firstSLPrice: finalSL,
      targetRR: tpRR,
      compoundCount: 0,
      totalRiskPct: 1.0,
      openedAt: new Date().toISOString(),
    });
    console.log('[executor] position state saved: SL distance ' + firstSLDistance.toFixed(2) + 'pts');
  }

  try {
    const fsSync = (await import('node:fs')).default;
    const statePath = new URL('../risk/state.json', import.meta.url).pathname;
    const riskState = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
    riskState.dailyTrades = (riskState.dailyTrades || 0) + 1;
    fsSync.writeFileSync(statePath, JSON.stringify(riskState, null, 2));
    console.log(`[executor] daily trades: ${riskState.dailyTrades}/${RISK_RULES?.maxDailyTrades || 10}`);
  } catch (err) {
    console.warn('[executor] failed to update dailyTrades:', err.message);
  }

  // Reconcile unified SL/TP after every fill (new entry or compound)
  if (!dryExecuteEnabled && process.env.DRY_RUN !== 'true') {
    console.log('[executor] waiting 3s for position to register...');
    await new Promise(r => setTimeout(r, 3000));

    const { getHLPositions: _getPos } = await import('../broker/hyperliquid.js');
    let verifiedPos = (await _getPos()).find(p =>
      p.coin === coin && p.direction === plan.direction
    );
    if (!verifiedPos) {
      console.error('[executor] position not found after 3s — retrying in 3s');
      await new Promise(r => setTimeout(r, 3000));
      verifiedPos = (await _getPos()).find(p =>
        p.coin === coin && p.direction === plan.direction
      );
    }

    if (!verifiedPos) {
      console.error('[executor] CRITICAL: cannot verify position after 6s');
      const { sendTelegramMessage } = await import('../telegram/notify.js');
      await sendTelegramMessage(
        '⚠️ <b>SL/TP failed — position not verified</b>\n' +
        'Manually set SL/TP on Hyperliquid!'
      ).catch(() => {});
    } else {
      console.log('[executor] position verified ✅ — placing SL/TP');
      try {
        await reconcileUnifiedSL(
          coin,
          plan.direction,
          context,
          placed.fillSize || sizing.size,
          placed.fillPrice || markPrice,
          plan.stopLoss?.price,
        );
        console.log('[executor] SL/TP placed successfully ✅');
      } catch (err) {
        console.error('[executor] SL/TP placement FAILED:', err.message);
        const { sendTelegramMessage } = await import('../telegram/notify.js');
        await sendTelegramMessage(
          '⚠️ <b>SL/TP placement failed!</b>\n' +
          'Error: ' + err.message + '\n' +
          'Manually set SL/TP on Hyperliquid now!'
        ).catch(() => {});
      }
    }
  }

  out.executed = true;
  out.reason = `Order placed: ${placed.orderId}`;
  out.trade = trade;
  out.orderMode = useMaker ? 'maker' : 'taker';
  out.feeRate = useMaker ? 0.010 : 0.035;
  out.atrRegime = dynamicLevels.label;
  out.tpRR = dynamicLevels.tpRR;
  out.atr = atr;
  return out;
}

async function reconcileUnifiedSL(coin, direction, context, fallbackSize, fallbackEntry, planSLPrice) {
  if (isReconciling) {
    console.log('[executor] reconcile already running — skipping duplicate');
    return;
  }
  isReconciling = true;
  try {
  const { getHLPositions, cancelExistingSL, cancelExistingTP, placeSL, placeTP } =
    await import('../broker/hyperliquid.js');

  // Load first-trade parameters: the canonical SL point-distance every compound preserves.
  const posState = await readPositionState();
  const stateValid = !!posState && posState.coin === coin
    && posState.direction === direction && posState.firstSLDistance > 0;

  const positions = await getHLPositions();
  const position = positions.find(p => p.coin === coin && p.direction === direction);

  const totalSize = position?.size ?? fallbackSize;

  // Bug 2 fix: entryPrice from HL can be 0 or NaN for freshly-opened positions.
  // ?? only guards null/undefined — use explicit validity check and fall back to fill price.
  const rawEntry = position?.entryPrice;
  const entryPrice = (rawEntry && !isNaN(rawEntry) && rawEntry > 0) ? rawEntry : fallbackEntry;

  if (!totalSize || totalSize <= 0) {
    console.error('[executor] reconcile: no position size found — skipping SL/TP');
    return;
  }
  if (!entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
    console.error(`[executor] reconcile: invalid entry price (${entryPrice}) — skipping SL/TP`);
    return;
  }

  const atr = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? 9;
  const regimeLabel = atr >= 15 ? 'trending' : atr >= 8 ? 'normal' : 'quiet';
  const targetRR = stateValid
    ? (posState.targetRR || parseFloat(process.env.TARGET_RR || '2.0'))
    : parseFloat(process.env.TARGET_RR || '2.0');

  // SL distance priority: the FIRST trade's distance (kept across compounds) → plan SL → ATR.
  let slDistance;
  if (stateValid) {
    slDistance = posState.firstSLDistance;
    console.log(`[executor] reconcile: first SL distance ${slDistance.toFixed(2)}pts kept (${posState.compoundCount || 0} compound(s))`);
  } else if (planSLPrice && planSLPrice > 0) {
    slDistance = Math.abs(entryPrice - planSLPrice);
    console.log(`[executor] reconcile: no state — plan SL distance ${slDistance.toFixed(2)}pts`);
  } else {
    slDistance = getDynamicSLTP(direction, entryPrice, atr).slDistance;
    console.log(`[executor] reconcile: no state/plan — ATR SL distance ${slDistance.toFixed(2)}pts`);
  }

  // SL and TP recalculated from the NEW weighted-average entry — trails on every compound,
  // always keeping the first SL point-distance and a flat targetRR (2R) reward.
  const slPrice = direction === 'long' ? entryPrice - slDistance : entryPrice + slDistance;
  const tpDistance = slDistance * targetRR;
  const tpPrice = direction === 'long' ? entryPrice + tpDistance : entryPrice - tpDistance;

  console.log('[executor] ═══ RECALC FROM AVG ENTRY ═══');
  console.log('  total size: ' + totalSize.toFixed(4) + ' ' + coin);
  console.log('  avg entry: $' + entryPrice.toFixed(2));
  console.log('  SL distance: ' + slDistance.toFixed(2) + 'pts' + (stateValid ? ' (kept from entry 1)' : ''));
  console.log('  SL price: $' + slPrice.toFixed(2));
  console.log('  TP distance: ' + tpDistance.toFixed(2) + 'pts (' + targetRR + 'R)');
  console.log('  TP price: $' + tpPrice.toFixed(2));
  console.log('  total risk: $' + (totalSize * slDistance).toFixed(2));
  console.log('  total reward: $' + (totalSize * tpDistance).toFixed(2));

  console.log(`[executor] reconciling SL/TP for ${totalSize} ${coin}`);
  console.log(`[executor] entry: $${entryPrice.toFixed(2)} | SL: $${slPrice.toFixed(2)} | TP: $${tpPrice.toFixed(2)} (${targetRR}R)`);

  await cancelExistingSL(coin);
  await cancelExistingTP(coin);
  console.log('[executor] waiting 4s for cancellations to confirm...');
  await new Promise(r => setTimeout(r, 4000));

  // Final verification — count remaining SL orders before placing new ones.
  // frontendOpenOrders: plain openOrders omits orderType/isTrigger so this matched nothing.
  const ordersCheck = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'frontendOpenOrders', user: process.env.HL_WALLET_ADDRESS }),
  }).then(r => r.json());

  const remainingSLs = Array.isArray(ordersCheck) &&
    ordersCheck.filter(o =>
      o.coin === coin &&
      o.reduceOnly &&
      (o.orderType === 'Stop Market' || o.orderType === 'Stop Limit' || o.isTrigger === true)
    );

  if (remainingSLs && remainingSLs.length > 0) {
    console.warn('[executor] WARNING: ' + remainingSLs.length +
      ' SL orders still exist after cancel — waiting 2 more seconds');
    await new Promise(r => setTimeout(r, 2000));
  }

  // Bug 1 fix: check return values — placeSL/placeTP return false on HL rejection without throwing.
  // Without this check, reconcile logged "✅" and sent Telegram even when HL silently rejected.
  const slOk = await placeSL({ coin, direction, size: totalSize, slPrice });
  const tpOk = await placeTP({ coin, direction, size: totalSize, tpPrice });

  if (!slOk || !tpOk) {
    throw new Error(`SL/TP placement rejected by Hyperliquid — SL: ${slOk}, TP: ${tpOk}`);
  }

  // FIX 3: Check for duplicate SLs after placement and alert via Telegram if found
  try {
    const finalOrders = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'frontendOpenOrders', user: process.env.HL_WALLET_ADDRESS }),
    }).then(r => r.json());

    const finalSLs = Array.isArray(finalOrders) &&
      finalOrders.filter(o =>
        o.coin === coin &&
        o.reduceOnly &&
        (o.orderType === 'Stop Market' || o.orderType === 'Stop Limit' || o.isTrigger === true)
      );

    if (finalSLs && finalSLs.length > 1) {
      console.warn(`[executor] ⚠️ DUPLICATE SL DETECTED: ${finalSLs.length} SL orders on books for ${coin}`);
      finalSLs.forEach(o => console.warn(`[executor]   oid=${o.oid} px=${o.limitPx} sz=${o.sz}`));
      const { sendTelegramMessage } = await import('../telegram/notify.js');
      await sendTelegramMessage(
        `⚠️ <b>Duplicate SL detected!</b>\n` +
        `${finalSLs.length} SL orders on books for ${coin}\n` +
        `Manually cancel extras on Hyperliquid!\n` +
        finalSLs.map(o => `  oid=${o.oid} @ $${o.limitPx}`).join('\n')
      ).catch(() => {});
    } else {
      console.log(`[executor] SL order count after placement: ${finalSLs ? finalSLs.length : 'n/a'} ✅`);
    }
  } catch (err) {
    console.warn('[executor] duplicate SL check failed (non-fatal):', err.message);
  }

  console.log(`[executor] unified SL/TP reconciled ✅`);
  console.log(`[executor] covers: ${totalSize} ${coin} total`);

  const { sendTelegramMessage } = await import('../telegram/notify.js');
  await sendTelegramMessage(
    `🔄 <b>SL/TP unified</b>\n` +
    `${direction.toUpperCase()} ${totalSize} ${coin}\n` +
    `🛑 SL: $${slPrice.toFixed(2)} (covers full position)\n` +
    `🎯 TP: $${tpPrice.toFixed(2)} (${targetRR}R)\n` +
    `ATR regime: ${regimeLabel}`
  ).catch(err => console.warn(`[executor] reconcile Telegram failed: ${err.message}`));
  } finally {
    isReconciling = false;
  }
}

export async function updateUnifiedSLTP(coin, direction, totalSize, newSLPrice, newTPPrice) {
  const { cancelExistingSL, cancelExistingTP, placeSL, placeTP } =
    await import('../broker/hyperliquid.js');

  console.log(`[executor] updating unified SL/TP for ${totalSize} ${coin}`);
  console.log(`[executor] new SL: $${newSLPrice.toFixed(2)} | new TP: $${newTPPrice.toFixed(2)}`);
  console.log(`[executor] total position size: ${totalSize}`);

  await cancelExistingSL(coin);
  await cancelExistingTP(coin);
  console.log('[executor] waiting 4s for cancellations to confirm...');
  await new Promise(r => setTimeout(r, 4000));

  await placeSL({ coin, direction, size: totalSize, slPrice: newSLPrice });
  await placeTP({ coin, direction, size: totalSize, tpPrice: newTPPrice });

  console.log(`[executor] unified SL/TP updated ✅`);
}

// Safety net + reconcile sweep for the resting-GTC entry model. A limit entry (or a COMPOUND
// add) can fill BETWEEN pipeline runs, so inline reconcileUnifiedSL never runs for it. This
// sweep runs every cycle and enforces the invariant: every open position has exactly one SL and
// one TP, each covering the FULL size, with TP at exactly TARGET_RR from the weighted-average
// entry. It keeps an existing stop (never moves a winner's stop) and only derives one from ATR
// when the position is naked. No-op when already in sync — so a compound (size grows, avg entry
// shifts) is re-bracketed to full size at 2R, while a steady position is left untouched.
// Detection uses frontendOpenOrders (plain openOrders omits isTrigger/orderType/sz).
export async function protectNakedPositions(context) {
  const coin = process.env.HL_COIN || 'PAXG';
  const { getHLPositions, getOpenOrdersDetailed, cancelOrder, placeSL, placeTP } =
    await import('./hyperliquid.js');

  let positions;
  try {
    positions = await getHLPositions();
  } catch (err) {
    console.warn('[protect] could not fetch positions — skipping sweep:', err.message);
    return { checked: 0, protected: 0 };
  }
  const open = positions.filter(p => p.coin === coin && p.size > 0);
  if (open.length === 0) {
    // Flat — drop any stale first-trade state so the next entry starts a clean compound count.
    await clearPositionState();
    return { checked: 0, protected: 0 };
  }

  let orders;
  try {
    orders = await getOpenOrdersDetailed();
  } catch (err) {
    // Fail safe: if we can't read orders we cannot tell protected from naked — do NOT
    // place blind SL/TP (risk of duplicates). Skip and retry next cycle.
    console.warn('[protect] could not fetch orders — skipping sweep (fail-safe):', err.message);
    return { checked: open.length, protected: 0 };
  }

  const targetRR = parseFloat(process.env.TARGET_RR || '2.0');
  let protectedCount = 0;
  for (const pos of open) {
    const entry = pos.entryPrice;  // Hyperliquid weighted-average entry (shifts on compound)
    if (!entry || isNaN(entry) || entry <= 0) {
      console.error(`[protect] invalid entry price (${entry}) — cannot size SL/TP, alerting only`);
      if (process.env.DRY_RUN !== 'true') {
        const { sendTelegramMessage } = await import('../telegram/notify.js');
        await sendTelegramMessage(
          `⚠️ <b>Position — manual SL needed</b>\n` +
          `${pos.direction.toUpperCase()} ${pos.size} ${coin} has an invalid entry price.\n` +
          `Set SL/TP manually on Hyperliquid now!`
        ).catch(() => {});
      }
      continue;
    }

    const reduceOrders = orders.filter(o => o.coin === coin && o.reduceOnly);
    const isStop = (o) => o.isTrigger === true || o.orderType === 'Stop Market' || o.orderType === 'Stop Limit';
    const slOrders = reduceOrders.filter(isStop);
    const tpOrders = reduceOrders.filter(o => !isStop(o));
    const slCovered = slOrders.reduce((s, o) => s + (o.sz || 0), 0);
    const tpCovered = tpOrders.reduce((s, o) => s + (o.sz || 0), 0);

    // SL distance: when first-trade state matches this position, keep that SAME point-distance
    // and trail it from the (shifting) avg entry — so a compound that filled between runs gets
    // the same SL/TP recalc reconcileUnifiedSL would have done. Otherwise keep an existing stop
    // (never move a winner's stop) and derive from ATR only if naked.
    const atr = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? 8;
    const posState = await readPositionState();
    const stateValid = !!posState && posState.coin === coin
      && posState.direction === pos.direction && posState.firstSLDistance > 0;

    let slDist, slPrice, slTrailed = false;
    if (stateValid) {
      slDist = posState.firstSLDistance;
      slPrice = pos.direction === 'long' ? entry - slDist : entry + slDist;
      slTrailed = true;
    } else {
      slPrice = slOrders.length > 0 ? (slOrders[0].triggerPx ?? slOrders[0].limitPx) : null;
      if (!slPrice || slPrice <= 0) slPrice = getDynamicSLTP(pos.direction, entry, atr).slPrice;
      slDist = Math.abs(entry - slPrice);
    }
    const posTargetRR = stateValid ? (posState.targetRR || targetRR) : targetRR;
    const tpPrice = pos.direction === 'long' ? entry + slDist * posTargetRR : entry - slDist * posTargetRR;

    // Invariant: one SL + one TP, each covering the FULL position, TP at targetRR from the avg
    // entry. A compound fill (size grows + avg entry shifts) breaks coverage and the SL/TP level.
    // No-op when already in sync, so steady positions are never churned — the SL-price tolerance
    // only triggers a re-sync once the avg entry has actually moved (a compound).
    const sizeTol = Math.max(0.0015, pos.size * 0.02);
    const tpTol = Math.max(0.5, slDist * 0.1);
    const slPriceTol = Math.max(0.5, slDist * 0.1);
    const existingSLPx = slOrders.length === 1 ? (slOrders[0].triggerPx ?? slOrders[0].limitPx ?? 0) : 0;
    const slInSync = slOrders.length === 1 && Math.abs(slCovered - pos.size) <= sizeTol
      && (!slTrailed || Math.abs(existingSLPx - slPrice) <= slPriceTol);
    const tpInSync = tpOrders.length === 1 && Math.abs(tpCovered - pos.size) <= sizeTol
      && Math.abs((tpOrders[0].limitPx ?? 0) - tpPrice) <= tpTol;
    if (slInSync && tpInSync) {
      console.log(`[protect] ${coin} ${pos.direction} ${pos.size} — SL/TP in sync ✅ (SL $${slPrice.toFixed(2)}, TP $${tpPrice.toFixed(2)})`);
      continue;
    }

    const wasNaked = slOrders.length === 0;
    console.warn(`[protect] ${wasNaked ? '⚠️ NAKED' : '🔁 OUT-OF-SYNC'} ${pos.direction} ${pos.size} ${coin} @ avg $${entry.toFixed(2)} ` +
      `— SL ${slOrders.length}x cover ${slCovered.toFixed(4)}, TP ${tpOrders.length}x cover ${tpCovered.toFixed(4)} ` +
      `→ reconciling full size @ ${targetRR}R (SL $${slPrice.toFixed(2)}, TP $${tpPrice.toFixed(2)})`);

    // Cancel all reduce-only orders, then place ONE SL + ONE TP covering the full position.
    for (const o of reduceOrders) {
      try { await cancelOrder(coin, o.oid); await new Promise(r => setTimeout(r, 300)); }
      catch (err) { console.warn('[protect] reduce-only cancel failed:', err.message); }
    }
    await new Promise(r => setTimeout(r, 1500));

    let slOk = false, tpOk = false;
    try { slOk = await placeSL({ coin, direction: pos.direction, size: pos.size, slPrice }); }
    catch (err) { console.error('[protect] SL placement error:', err.message); }
    try { tpOk = await placeTP({ coin, direction: pos.direction, size: pos.size, tpPrice }); }
    catch (err) { console.error('[protect] TP placement error:', err.message); }

    if (slOk) protectedCount++;

    if (process.env.DRY_RUN !== 'true') {
      const { sendTelegramMessage } = await import('../telegram/notify.js');
      await sendTelegramMessage(
        `🛡 <b>${wasNaked ? 'Protected naked position' : 'Re-synced SL/TP (compound)'}</b>\n` +
        `${pos.direction.toUpperCase()} ${pos.size} ${coin} @ avg $${entry.toFixed(2)}\n` +
        `🛑 SL: $${slPrice.toFixed(2)} (${slDist.toFixed(1)}pts)  🎯 TP: $${tpPrice.toFixed(2)} (${targetRR}R)\n` +
        (slOk && tpOk ? `Covers full size ✅` : `⚠️ SL ${slOk} / TP ${tpOk} — verify manually on Hyperliquid!`)
      ).catch(() => {});
    }
  }

  return { checked: open.length, protected: protectedCount };
}

// Close an open Hyperliquid position (used by /close command).
export async function closePosition(coin, direction, size) {
  const { closeHLPosition } = await import('./hyperliquid.js');
  const result = await closeHLPosition(coin, direction, size);
  // Position closed — drop the first-trade state so the next entry starts a fresh compound count.
  await clearPositionState();
  return result;
}
