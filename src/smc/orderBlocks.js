import { detectFVGs } from './fvg.js';
import { detectSwings } from './swings.js';

// Order Block detection.
// Bullish OB: last DOWN-close candle before an impulsive up-move that breaks structure (BOS).
// The impulse must contain >=1 bullish FVG. Zone = [low, high] of the OB candle.
// Active = not yet traded through. Returns top 3 by proximity to current price.
export function detectOrderBlocks(candles, n = 5) {
  const swings = detectSwings(candles, n);
  if (swings.length < 2) return [];

  const fvgs = detectFVGs(candles);
  const orderBlocks = [];

  let lastHigh = null;
  let lastLow = null;

  for (const s of swings) {
    if (s.type === 'high') {
      if (lastHigh && s.price > lastHigh.price) {
        // Bullish BOS — scan back from s.index for the last down-close candle
        const impulseStart = lastHigh.index;
        const impulseEnd = s.index;
        let obIdx = -1;
        for (let k = impulseEnd; k >= Math.max(0, impulseStart - 10); k--) {
          const c = candles[k];
          if (c.close < c.open) {
            obIdx = k;
            break;
          }
        }
        if (obIdx !== -1) {
          const hasFvg = fvgs.some(f => f.type === 'bullish' && f.index > obIdx && f.index <= impulseEnd);
          if (hasFvg) {
            const ob = candles[obIdx];
            orderBlocks.push({
              type: 'bullish',
              index: obIdx,
              time: ob.time,
              low: ob.low,
              high: ob.high,
              zone: [ob.low, ob.high],
              createdAtImpulse: impulseEnd,
            });
          }
        }
      }
      lastHigh = s;
    } else {
      if (lastLow && s.price < lastLow.price) {
        // Bearish BOS — last up-close candle before the break
        const impulseStart = lastLow.index;
        const impulseEnd = s.index;
        let obIdx = -1;
        for (let k = impulseEnd; k >= Math.max(0, impulseStart - 10); k--) {
          const c = candles[k];
          if (c.close > c.open) {
            obIdx = k;
            break;
          }
        }
        if (obIdx !== -1) {
          const hasFvg = fvgs.some(f => f.type === 'bearish' && f.index > obIdx && f.index <= impulseEnd);
          if (hasFvg) {
            const ob = candles[obIdx];
            orderBlocks.push({
              type: 'bearish',
              index: obIdx,
              time: ob.time,
              low: ob.low,
              high: ob.high,
              zone: [ob.low, ob.high],
              createdAtImpulse: impulseEnd,
            });
          }
        }
      }
      lastLow = s;
    }
  }

  // Filter to active (not traded through)
  const currentPrice = candles[candles.length - 1].close;
  const active = orderBlocks.filter(ob => {
    // An OB is traded through if any subsequent candle closed beyond its opposing edge
    for (let k = ob.index + 1; k < candles.length; k++) {
      const c = candles[k];
      if (ob.type === 'bullish' && c.close < ob.low) return false;
      if (ob.type === 'bearish' && c.close > ob.high) return false;
    }
    return true;
  });

  // Sort by proximity to current price
  active.sort((a, b) => {
    const aDist = Math.min(Math.abs(currentPrice - a.low), Math.abs(currentPrice - a.high));
    const bDist = Math.min(Math.abs(currentPrice - b.low), Math.abs(currentPrice - b.high));
    return aDist - bDist;
  });

  return active.slice(0, 3);
}
