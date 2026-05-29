import { detectSwings } from './swings.js';

// Premium/Discount zones based on most recent swing range.
// Discount = 0-50% (from low), Premium = 50-100%.
// OTE (Optimal Trade Entry) = fib 0.618-0.786.
export function computePremiumDiscount(candles, n = 5) {
  const swings = detectSwings(candles, n);
  if (swings.length < 2) {
    return {
      ok: false,
      reason: 'not enough swings',
    };
  }

  const lastSwing = swings[swings.length - 1];
  // Find prior opposite swing
  let priorOpposite = null;
  for (let i = swings.length - 2; i >= 0; i--) {
    if (swings[i].type !== lastSwing.type) {
      priorOpposite = swings[i];
      break;
    }
  }
  if (!priorOpposite) {
    return { ok: false, reason: 'no opposite swing found' };
  }

  const high = lastSwing.type === 'high' ? lastSwing.price : priorOpposite.price;
  const low = lastSwing.type === 'low' ? lastSwing.price : priorOpposite.price;
  const range = high - low;
  if (range <= 0) return { ok: false, reason: 'invalid range' };

  const mid = low + range * 0.5;
  const ote = {
    // OTE for long (on pullback from swing high): fib 0.618–0.786 retracement = price zone near bottom
    long: [low + range * (1 - 0.786), low + range * (1 - 0.618)],
    short: [low + range * 0.618, low + range * 0.786],
  };

  const currentPrice = candles[candles.length - 1].close;
  const positionPct = ((currentPrice - low) / range) * 100;
  const zone = positionPct >= 50 ? 'premium' : 'discount';

  return {
    ok: true,
    high,
    low,
    range,
    mid,
    currentPrice,
    positionPct,
    zone,
    ote,
    fibLevels: {
      0: low,
      0.236: low + range * 0.236,
      0.382: low + range * 0.382,
      0.5: mid,
      0.618: low + range * 0.618,
      0.786: low + range * 0.786,
      1: high,
    },
  };
}
