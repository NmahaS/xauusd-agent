// Fair Value Gap detection (3-candle pattern).
// Bullish FVG: candles[i+1].low > candles[i-1].high (gap between candle i-1 and i+1).
// Bearish FVG: candles[i+1].high < candles[i-1].low.
// Unfilled = midpoint of the gap not revisited by any later candle.
export function detectFVGs(candles) {
  const fvgs = [];
  if (!Array.isArray(candles) || candles.length < 3) return fvgs;

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    // Bullish FVG
    if (next.low > prev.high) {
      const top = next.low;
      const bottom = prev.high;
      const mid = (top + bottom) / 2;
      let filled = false;
      let filledIndex = null;
      for (let k = i + 2; k < candles.length; k++) {
        if (candles[k].low <= mid) {
          filled = true;
          filledIndex = k;
          break;
        }
      }
      fvgs.push({
        type: 'bullish',
        index: i,
        time: candles[i].time,
        top,
        bottom,
        mid,
        filled,
        filledIndex,
      });
    }

    // Bearish FVG
    if (next.high < prev.low) {
      const top = prev.low;
      const bottom = next.high;
      const mid = (top + bottom) / 2;
      let filled = false;
      let filledIndex = null;
      for (let k = i + 2; k < candles.length; k++) {
        if (candles[k].high >= mid) {
          filled = true;
          filledIndex = k;
          break;
        }
      }
      fvgs.push({
        type: 'bearish',
        index: i,
        time: candles[i].time,
        top,
        bottom,
        mid,
        filled,
        filledIndex,
      });
    }
  }

  return fvgs;
}

export function unfilledFVGs(candles) {
  return detectFVGs(candles).filter(f => !f.filled);
}
