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
import { getHLPositions, cancelExistingSL, placeSL } from './hyperliquid.js';
import { dataPath } from '../utils/dataDir.js';

const STATE_FILE = dataPath('position-state.json');

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

  // Cancel the old stop, then place a fresh one covering the FULL remaining size (after a partial
  // TP fill pos.size is already the runner half). Leaves the 2R TP limit untouched.
  await cancelExistingSL(coin);
  await new Promise(r => setTimeout(r, 2000));
  const ok = await placeSL({ coin, direction, size: pos.size, slPrice: newSL });
  if (!ok) {
    // We've already cancelled the old stop, so the position is momentarily naked. Do NOT advance
    // trailLevel (so this re-attempts next cycle), and alert — protectNakedPositions runs later
    // this same cycle and re-establishes a stop, but make the gap visible.
    console.error('[trail] placeSL rejected after cancel — position may be naked until protect sweep');
    try {
      const { sendTelegramMessage } = await import('../telegram/notify.js');
      await sendTelegramMessage(
        `⚠️ <b>Trailing stop placement failed</b>\n` +
        `${direction.toUpperCase()} ${coin} — old stop cancelled, new one rejected.\n` +
        `Protect sweep will retry; verify a stop is set on Hyperliquid.`
      );
    } catch {}
    return;
  }

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
}
