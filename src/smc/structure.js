import { detectSwings } from './swings.js';

// Track bias across swing sequence.
// BOS (Break of Structure): price breaks the most recent same-direction swing level, trend continues.
// CHoCH (Change of Character): price breaks against prior trend — first signal of reversal.
export function analyzeStructure(candles, n = 5) {
  if (!Array.isArray(candles) || candles.length < 20) {
    return { bias: 'neutral', lastEvent: null, eventCandle: null, brokenLevel: null, swings: [] };
  }
  const swings = detectSwings(candles, n);
  if (swings.length === 0) {
    return { bias: 'neutral', lastEvent: null, eventCandle: null, brokenLevel: null, swings };
  }

  let bias = 'neutral';
  let lastEvent = null;
  let eventCandle = null;
  let brokenLevel = null;

  let lastHigh = null;
  let lastLow = null;

  for (const s of swings) {
    if (s.type === 'high') {
      if (lastHigh && s.price > lastHigh.price) {
        // Higher high
        if (bias === 'bearish') {
          lastEvent = 'CHoCH-bullish';
          eventCandle = s;
          brokenLevel = lastHigh.price;
          bias = 'bullish';
        } else {
          lastEvent = 'BOS-bullish';
          eventCandle = s;
          brokenLevel = lastHigh.price;
          bias = 'bullish';
        }
      }
      lastHigh = s;
    } else {
      if (lastLow && s.price < lastLow.price) {
        // Lower low
        if (bias === 'bullish') {
          lastEvent = 'CHoCH-bearish';
          eventCandle = s;
          brokenLevel = lastLow.price;
          bias = 'bearish';
        } else {
          lastEvent = 'BOS-bearish';
          eventCandle = s;
          brokenLevel = lastLow.price;
          bias = 'bearish';
        }
      }
      lastLow = s;
    }
  }

  return { bias, lastEvent, eventCandle, brokenLevel, swings };
}
