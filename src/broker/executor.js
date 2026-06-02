// Hyperliquid order placement gated by AUTO_TRADE + risk manager rules.
// Always logs a PRE-FLIGHT line before any POST. DRY_EXECUTE=true short-circuits.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAccountState, checkRiskRules, RISK_RULES } from '../risk/manager.js';
import { placeHLOrder, closeHLPosition } from './hyperliquid.js';

const PLANS_DIR = path.join(process.cwd(), 'plans');

let isReconciling = false;

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

async function handleExistingPosition(existingPosition, plan) {
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
      return { action: 'compound', reason: `Compounding ${existingPosition.direction} at half risk` };
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

  let slMultiplier, tpRR, label;
  if (isTrending) {
    slMultiplier = 1.5;
    tpRR = 3.0;
    label = 'trending';
  } else if (isNormal) {
    slMultiplier = 1.0;
    tpRR = 2.0;
    label = 'normal';
  } else {
    slMultiplier = 0.8;
    tpRR = 1.5;
    label = 'quiet';
  }

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
      if (confluence < 7) {
        return {
          executed: false,
          reason: 'Dead zone compound: confluence ' + confluence +
                  '/12 too low (need 7+ in dead zone)',
        };
      }
      if (atr < 8) {
        return {
          executed: false,
          reason: 'Dead zone compound: ATR ' + atr?.toFixed(2) +
                  'pts too low (need 8pts in dead zone)',
        };
      }

      console.log('[executor] dead zone COMPOUND allowed:',
        'same direction ' + plan.direction +
        ', T' + tier + ' C' + confluence + ' ATR' + atr?.toFixed(1));
      // Continue — compound is decided by handleExistingPosition below.
    } else {
      // No position — strict new-entry rules.
      if (atr < 8) {
        return {
          executed: false,
          reason: 'Dead zone: ATR ' + atr?.toFixed(2) + 'pts too low (need 8pts)',
        };
      }
      if (confluence < 7) {
        return {
          executed: false,
          reason: 'Dead zone: confluence ' + confluence + '/12 too low (need 7+)',
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

  // 0. Cancel-on-new-signal: manage any resting (unfilled) GTC entry order from a prior run.
  //    Same direction → keep waiting for fill. Direction flip → cancel, then place fresh below.
  try {
    const { getOpenOrders, cancelOrder } = await import('./hyperliquid.js');

    const openOrders = await getOpenOrders();
    const pendingEntry = openOrders.find(o =>
      o.coin === coin &&
      !o.reduceOnly &&
      o.orderType !== 'Stop Market'
    );

    if (pendingEntry) {
      console.log('[executor] found pending entry order:', pendingEntry.oid, '@', pendingEntry.limitPx);

      const pendingDir = pendingEntry.side === 'B' ? 'long' : 'short';

      if (pendingDir === plan.direction) {
        // Same direction — keep the order, don't place a new one.
        console.log('[executor] same direction — keeping pending order', pendingEntry.oid);
        out.reason = 'Pending entry order kept — waiting for fill @ $' + pendingEntry.limitPx;
        out.pendingOrderId = pendingEntry.oid;
        return out;
      } else {
        // Direction changed — cancel old order, then place new one below.
        console.log('[executor] direction changed — cancelling pending order', pendingEntry.oid);
        await cancelOrder(coin, pendingEntry.oid);
        await new Promise(r => setTimeout(r, 1000));
        console.log('[executor] cancelled — placing new', plan.direction, 'order');
      }
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
  if (existingPos) {
    positionDecision = await handleExistingPosition(existingPos, plan);
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
      if (plan.risk) {
        plan.risk.suggestedRiskPct = (plan.risk.suggestedRiskPct || RISK_RULES.maxRiskPerTrade) * 0.5;
        console.log(`[executor] compound risk halved to ${plan.risk.suggestedRiskPct}%`);
      }
      await sendPositionDecisionMsg('compound', {
        existingDirection: existingPos.direction,
        reason: positionDecision.reason,
        risk: plan.risk?.suggestedRiskPct,
      });
      // Fall through — place the compound order at half risk
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

  // 3. Position sizing in XAU — always market price, never plan's limit price
  const riskPct = Math.min(plan.risk?.suggestedRiskPct || RISK_RULES.maxRiskPerTrade, RISK_RULES.maxRiskPerTrade);
  const riskAmount = account.balance * (riskPct / 100);
  const entryPrice = context.currentPrice || plan.entry?.price;
  console.log(`[executor] market entry at current price: $${entryPrice}`);

  const atr = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? 8;
  const dynamicLevels = getDynamicSLTP(plan.direction, entryPrice, atr);
  const finalSL = plan.stopLoss?.price ?? dynamicLevels.slPrice;
  const finalTP = dynamicLevels.tpPrice;
  const tpDistance = Math.abs(finalTP - entryPrice);

  console.log('[executor] plan SL price:', plan?.stopLoss?.price);
  console.log('[executor] dynamic SL price:', dynamicLevels?.slPrice?.toFixed(2));
  console.log('[executor] using SL:', finalSL?.toFixed(2));
  console.log('[executor] TARGET_RR:', process.env.TARGET_RR);
  console.log('[executor] tpDistance:', tpDistance.toFixed(2) + 'pts');
  console.log('[executor] tpPrice:', finalTP.toFixed(2));

  const slDistance = Math.abs(entryPrice - finalSL);

  console.log('[executor] SL distance:', slDistance.toFixed(2) + 'pts');
  console.log(`[executor] entry=${entryPrice} SL=${finalSL.toFixed(2)} distance=${slDistance.toFixed(2)}pts`);
  console.log(`[executor] riskAmount=$${riskAmount.toFixed(2)} riskPct=${riskPct}% balance=$${account.balance.toFixed(2)}`);

  if (!slDistance || isNaN(slDistance)) {
    out.reason = 'SL distance is zero or invalid — check entry/SL prices in plan';
    console.log(`[executor] sizing rejected: ${out.reason}`);
    return out;
  }

  const rawSize = riskAmount / slDistance;
  let size = Math.max(0.001, Math.round(rawSize * 1000) / 1000); // 3dp matches PAXG szDecimals
  const MAX_POSITION_SIZE = 0.25;  // ~2% risk at 8pt SL (was 0.15)
  if (size > MAX_POSITION_SIZE) {
    console.warn(`[sizing] HARD CAP: ${size} → ${MAX_POSITION_SIZE} PAXG`);
    console.warn(`[sizing] reason: max position size protection`);
    size = MAX_POSITION_SIZE;
  }
  const actualRisk = size * slDistance;

  console.log('[sizing] balance:', account.balance.toFixed(2));
  console.log('[sizing] riskPct:', riskPct + '%');
  console.log('[sizing] riskAmount: $' + riskAmount.toFixed(3));
  console.log('[sizing] slDistance:', slDistance.toFixed(2) + 'pts');
  console.log('[sizing] size:', size.toFixed(4) + ' PAXG');
  console.log('[sizing] notional: $' + (size * entryPrice).toFixed(2));
  console.log('[sizing] expected 1R loss: $' + (size * slDistance).toFixed(3));
  console.log('[sizing] expected 2R gain: $' + (size * slDistance * 2).toFixed(3));
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
  let slPrice;

  if (planSLPrice && planSLPrice > 0) {
    slPrice = planSLPrice;
    console.log('[executor] using PLAN SL:', slPrice.toFixed(2), 'ATR:', atr.toFixed(2));
  } else {
    const dynamicLevels = getDynamicSLTP(direction, entryPrice, atr);
    slPrice = dynamicLevels.slPrice;
    console.log('[executor] using ATR SL:', slPrice.toFixed(2), 'ATR:', atr.toFixed(2));
  }

  // ALWAYS calculate TP from the ACTUAL SL distance × targetRR — never an LLM/structural price.
  const slDistance = Math.abs(entryPrice - slPrice);
  const isTrending = atr >= 15;
  const targetRR = isTrending ? 3.0 : 2.0;
  const tpDistance = slDistance * targetRR;
  const tpPrice = direction === 'long'
    ? entryPrice + tpDistance
    : entryPrice - tpDistance;

  console.log('[executor] TP calculation:');
  console.log('  entry:', entryPrice.toFixed(2));
  console.log('  SL:', slPrice.toFixed(2));
  console.log('  SL distance:', slDistance.toFixed(2) + 'pts');
  console.log('  target RR:', targetRR + 'R');
  console.log('  TP distance:', tpDistance.toFixed(2) + 'pts');
  console.log('  TP price:', tpPrice.toFixed(2));
  const actualRR = tpDistance / slDistance;
  console.log('  actual RR:', actualRR.toFixed(2) + 'R ← must be', targetRR + 'R');

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

// Safety net for the resting-GTC entry model: a limit entry can fill BETWEEN pipeline
// runs, leaving a live position with no stop-loss (the next run may decide "hold" and
// return early, or produce no signal at all so the executor never runs). This sweep runs
// every cycle and attaches SL/TP to any open position lacking a stop-loss. No-op when the
// position is already protected — detection uses frontendOpenOrders (the plain openOrders
// endpoint omits the isTrigger/orderType fields needed to recognise a stop).
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
  if (open.length === 0) return { checked: 0, protected: 0 };

  let orders;
  try {
    orders = await getOpenOrdersDetailed();
  } catch (err) {
    // Fail safe: if we can't read orders we cannot tell protected from naked — do NOT
    // place blind SL/TP (risk of duplicates). Skip and retry next cycle.
    console.warn('[protect] could not fetch orders — skipping sweep (fail-safe):', err.message);
    return { checked: open.length, protected: 0 };
  }

  let protectedCount = 0;
  for (const pos of open) {
    const reduceOrders = orders.filter(o => o.coin === coin && o.reduceOnly);
    const hasSL = reduceOrders.some(o =>
      o.isTrigger === true || o.orderType === 'Stop Market' || o.orderType === 'Stop Limit'
    );
    if (hasSL) {
      console.log(`[protect] ${coin} ${pos.direction} ${pos.size} — stop-loss present ✅`);
      continue;
    }

    console.warn(`[protect] ⚠️ NAKED POSITION: ${pos.direction} ${pos.size} ${coin} @ $${pos.entryPrice} — no stop-loss, attaching SL/TP`);

    const entry = pos.entryPrice;
    if (!entry || isNaN(entry) || entry <= 0) {
      console.error(`[protect] invalid entry price (${entry}) — cannot size SL/TP, alerting only`);
      if (process.env.DRY_RUN !== 'true') {
        const { sendTelegramMessage } = await import('../telegram/notify.js');
        await sendTelegramMessage(
          `⚠️ <b>Naked position — manual SL needed</b>\n` +
          `${pos.direction.toUpperCase()} ${pos.size} ${coin} has no stop-loss and an invalid entry price.\n` +
          `Set SL/TP manually on Hyperliquid now!`
        ).catch(() => {});
      }
      continue;
    }

    // Cancel any stray reduce-only orders (e.g. an orphan TP) so we don't double up.
    for (const o of reduceOrders) {
      try {
        await cancelOrder(coin, o.oid);
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.warn('[protect] stray reduce-only cancel failed:', err.message);
      }
    }

    const atr = context?.m15Indicators?.atr ?? context?.m15?.indicators?.atr ?? 8;
    const { slPrice, tpPrice, tpRR, label } = getDynamicSLTP(pos.direction, entry, atr);

    let slOk = false, tpOk = false;
    try { slOk = await placeSL({ coin, direction: pos.direction, size: pos.size, slPrice }); }
    catch (err) { console.error('[protect] SL placement error:', err.message); }
    try { tpOk = await placeTP({ coin, direction: pos.direction, size: pos.size, tpPrice }); }
    catch (err) { console.error('[protect] TP placement error:', err.message); }

    if (slOk) protectedCount++;

    if (process.env.DRY_RUN !== 'true') {
      const { sendTelegramMessage } = await import('../telegram/notify.js');
      await sendTelegramMessage(
        `🛡 <b>Protected naked position</b>\n` +
        `${pos.direction.toUpperCase()} ${pos.size} ${coin} @ $${entry.toFixed(2)} had no stop-loss\n` +
        `(GTC entry likely filled between runs)\n` +
        `🛑 SL: $${slPrice.toFixed(2)}  🎯 TP: $${tpPrice.toFixed(2)} (${tpRR}R, ${label})\n` +
        (slOk && tpOk ? `Placed ✅` : `⚠️ SL ${slOk} / TP ${tpOk} — verify manually on Hyperliquid!`)
      ).catch(() => {});
    }
  }

  return { checked: open.length, protected: protectedCount };
}

// Close an open Hyperliquid position (used by /close command).
export async function closePosition(coin, direction, size) {
  const { closeHLPosition } = await import('./hyperliquid.js');
  return closeHLPosition(coin, direction, size);
}
