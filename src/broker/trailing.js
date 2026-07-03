// Trailing-stop manager — lets winners run in trends.
//
// Exit model (paired with reconcileUnifiedSL / protectNakedPositions):
//   • 50% of the position takes profit at the fixed 2R TP.
//   • The remaining 50% has NO TP — it rides this trailing stop.
//
// Ladder (profit measured in R from the ORIGINAL entry, R = firstSLDistance):
//   +1R → SL to breakeven (level 0)
//   +2R → SL to +1R       (level 1)   ← also when the 2R partial TP fills
//   +nR → SL to +(n-1)R   (level n-1) — the stop trails exactly 1R behind, forever
//
// trailLevel is persisted in position-state.json and read by reconcile + protect so they never
// snap the stop back to firstSLDistance once it has been ratcheted up. Live mode only — the
// pipeline guards the call (AUTO_TRADE && !DRY_EXECUTE && !DRY_RUN).
import fs from 'fs';
import { getHLPositions, cancelExistingSL, placeSL, getOpenOrdersDetailed } from './hyperliquid.js';
import { dataPath } from '../utils/dataDir.js';

const STATE_FILE = dataPath('position-state.json');

// Move the stop to newSL with retry + read-back verification. The trailing update is the biggest
// uncapped tail risk: if a single cancel→place silently fails (API error, timing, network) the
// runner keeps its ORIGINAL stop and a +5R winner can revert all the way back. So we don't trust the
// place() result alone — after placing we read live orders back and confirm a reduce-only stop
// actually rests within 1pt of the target before reporting success. On total failure we alert loudly
// and return false WITHOUT the caller advancing trail state, so it re-attempts next cycle.
//
// Pure reliability wrapper around the existing cancelExistingSL/placeSL — no sizing, risk, or
// strategy logic lives here.
async function moveSLWithRetry(coin, direction, size, newSL, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await cancelExistingSL(coin);
      await new Promise(r => setTimeout(r, 2000));

      await placeSL({ coin, direction, size, slPrice: newSL });
      await new Promise(r => setTimeout(r, 1500));

      // VERIFY the SL order actually exists at the new price. frontendOpenOrders (not plain
      // openOrders) is the only endpoint carrying reduceOnly/isTrigger/triggerPx — plain openOrders
      // omits them, so a stop matched on those fields there would silently find nothing. A stop's
      // price lives in triggerPx; fall back to limitPx if absent.
      const orders = await getOpenOrdersDetailed();
      const slFound = orders.find(o => {
        if (o.coin !== coin) return false;
        const isStop = o.reduceOnly === true &&
          (o.isTrigger === true || (o.orderType || '').startsWith('Stop'));
        if (!isStop) return false;
        const px = o.triggerPx ?? o.limitPx;
        // Match within 1pt of target
        return Number.isFinite(px) && Math.abs(px - newSL) < 1.0;
      });

      if (slFound) {
        console.log('[trail] ✅ SL move verified on attempt ' + attempt +
          ' — SL at $' + newSL.toFixed(2) + ' size ' + slFound.sz);
        return true;
      }

      console.warn('[trail] ⚠️ SL not found at $' + newSL.toFixed(2) +
        ' after attempt ' + attempt + ' — retrying');
    } catch (e) {
      console.error('[trail] attempt ' + attempt + ' error: ' + e.message);
    }

    // Wait before next retry
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // ALL retries failed — alert loudly, keep whatever SL exists
  console.error('[trail] 🚨 SL MOVE FAILED after ' + maxRetries + ' attempts');
  try {
    const { sendTelegramMessage } = await import('../telegram/notify.js');
    await sendTelegramMessage(
      '🚨 <b>TRAILING STOP FAILED</b>\n' +
      'Could not move SL to $' + newSL.toFixed(2) + ' after ' + maxRetries + ' tries\n' +
      'Coin: ' + coin + ' | Direction: ' + direction + '\n' +
      '⚠️ CHECK POSITION MANUALLY — SL may be at old level'
    );
  } catch (e) {}
  return false;
}

export async function updateTrailingStop(coin, context) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return;  // no open-position state → nothing to trail
  }

  const price = context?.currentPrice;
  const entry = state?.firstEntry;
  const slDist = state?.firstSLDistance;
  if (!price || !entry || !(slDist > 0)) return;

  const positions = await getHLPositions();
  const pos = positions.find(p => p.coin === coin && p.size > 0);
  if (!pos) return;

  const { direction } = pos;
  // Guard against stale state from a prior/opposite position.
  if (state.coin !== coin || state.direction !== direction) {
    console.warn(`[trail] state ${state.coin}/${state.direction} ≠ live ${coin}/${direction} — skipping`);
    return;
  }

  const profitPts = direction === 'long' ? price - entry : entry - price;
  const profitR = profitPts / slDist;
  console.log('[trail]', direction, coin, 'profit:', profitR.toFixed(2) + 'R', '(price', price, 'entry', entry + ')');

  // Trail 1R behind: +1R→BE(0), +2R→+1R(1), +3R→+2R(2), … Only ratchets up, never down.
  if (profitR < 1) return;
  const newSLLevel = Math.floor(profitR) - 1;          // 0 = breakeven, n = +nR locked in
  const currentLevel = typeof state.trailLevel === 'number' ? state.trailLevel : -1;
  if (newSLLevel <= currentLevel) return;              // already at/above this level — no move

  const newSL = direction === 'long'
    ? entry + (newSLLevel * slDist)
    : entry - (newSLLevel * slDist);

  const levelLabel = newSLLevel === 0 ? 'breakeven' : '+' + newSLLevel + 'R';
  console.log('[trail] moving SL to', levelLabel, '($' + newSL.toFixed(2) + ') — letting winner run');

  // Cancel the old stop, place a fresh one covering the FULL remaining size (after a partial TP fill
  // pos.size is already the runner half), then read it back to confirm it rests. moveSLWithRetry
  // retries on API/timing/network failure and alerts on total failure, so a silent miss can't leave
  // the runner on its original stop. Leaves the 2R TP limit untouched.
  const moved = await moveSLWithRetry(coin, direction, pos.size, newSL);

  if (moved) {
    // Advance the trail level ONLY once the stop is verified in place.
    state.trailLevel = newSLLevel;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    try {
      const { sendTelegramMessage } = await import('../telegram/notify.js');
      await sendTelegramMessage(
        `📈 <b>Trailing stop</b>\n` +
        `${direction.toUpperCase()} ${coin} at +${profitR.toFixed(1)}R\n` +
        `🛑 SL → ${levelLabel} ($${newSL.toFixed(2)}) — letting winner run`
      );
    } catch (e) {
      console.warn('[trail] telegram failed:', e.message);
    }
  } else {
    // Move failed after all retries (moveSLWithRetry already alerted). Do NOT advance trailLevel so
    // it re-attempts next cycle; protectNakedPositions runs later this same cycle and re-establishes
    // a stop if the position is momentarily naked.
    console.warn('[trail] state NOT updated — will retry next cycle');
  }
}

// Recovery sweep — runs every cycle right after updateTrailingStop to catch a trail that SHOULD have
// ratcheted but didn't (a prior cycle's move failed all retries, or the process died mid-move). It
// recomputes the correct level from live profit and, if the persisted trailLevel lags, re-issues the
// move through the same verified retry path. When already caught up it's read-only.
//
// The ladder here mirrors updateTrailingStop exactly (Math.floor(profitR) - 1, unbounded: +1R→BE,
// +2R→+1R, +nR→+(n-1)R) so recovery lands on the identical stop the live path would have set — it
// re-runs existing exit logic, it does not introduce a different one. Reliability only.
export async function verifyTrailingState(coin, context) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return;  // no open-position state → nothing to verify
  }

  const price = context?.currentPrice;
  const entry = state?.firstEntry;
  const slDist = state?.firstSLDistance;
  if (!price || !entry || !(slDist > 0)) return;

  const positions = await getHLPositions();
  const pos = positions.find(p => p.coin === coin && p.size > 0);
  if (!pos) return;

  // Guard against stale state from a prior/opposite position (same guard updateTrailingStop uses).
  if (state.coin !== coin || state.direction !== pos.direction) {
    console.warn(`[trail-verify] state ${state.coin}/${state.direction} ≠ live ${coin}/${pos.direction} — skipping`);
    return;
  }

  const profitPts = pos.direction === 'long' ? price - entry : entry - price;
  const profitR = profitPts / slDist;

  // What trail level SHOULD we be at for the current profit? null = not yet at the first (+1R) rung.
  const shouldBeLevel = profitR >= 1 ? Math.floor(profitR) - 1 : null;
  const currentLevel = typeof state.trailLevel === 'number' ? state.trailLevel : -1;

  // Only correct when profit says we should be HIGHER than we are — never snaps a stop down.
  if (shouldBeLevel === null || shouldBeLevel <= currentLevel) return;

  console.log('[trail-verify] profit ' + profitR.toFixed(1) + 'R but trail at level ' +
    currentLevel + ' — should be ' + shouldBeLevel + ', correcting');

  const newSL = pos.direction === 'long'
    ? entry + (shouldBeLevel * slDist)
    : entry - (shouldBeLevel * slDist);

  const moved = await moveSLWithRetry(coin, pos.direction, pos.size, newSL);
  if (moved) {
    state.trailLevel = shouldBeLevel;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('[trail-verify] ✅ corrected trail to level ' + shouldBeLevel);
  }
}
