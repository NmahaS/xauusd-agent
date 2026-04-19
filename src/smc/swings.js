// Pivot swing detection — pure function.
// Pivot high at i: high[i] > all highs in [i-n..i-1] AND > all highs in [i+1..i+n]
// Pivot low: mirror.
export function detectSwings(candles, n = 5) {
  const swings = [];
  if (!Array.isArray(candles) || candles.length < 2 * n + 1) return swings;

  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];

    let isHigh = true;
    for (let k = 1; k <= n; k++) {
      if (!(c.high > candles[i - k].high) || !(c.high > candles[i + k].high)) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) {
      swings.push({ index: i, time: c.time, price: c.high, type: 'high' });
      continue;
    }

    let isLow = true;
    for (let k = 1; k <= n; k++) {
      if (!(c.low < candles[i - k].low) || !(c.low < candles[i + k].low)) {
        isLow = false;
        break;
      }
    }
    if (isLow) {
      swings.push({ index: i, time: c.time, price: c.low, type: 'low' });
    }
  }

  return swings;
}
