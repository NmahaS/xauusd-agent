// Volume Profile: distributes candle volume across price buckets.
// Identifies HVN (strong S/R), LVN (fast movement), POC, and Value Area.

export function computeVolumeProfile(candles, period = 'week') {
  const now = new Date();
  const cutoff = period === 'week'
    ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    : new Date(now.setUTCHours(0, 0, 0, 0));

  const relevant = candles.filter(c => new Date(c.time) >= cutoff);
  if (relevant.length < 5) return null;

  const high = Math.max(...relevant.map(c => c.high));
  const low = Math.min(...relevant.map(c => c.low));
  const range = high - low;
  if (range < 1) return null;

  const BUCKETS = 20;
  const bucketSize = range / BUCKETS;

  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    price: low + (i + 0.5) * bucketSize,
    volume: 0,
  }));

  for (const candle of relevant) {
    const candleRange = candle.high - candle.low;
    if (candleRange === 0) continue;
    for (const bucket of buckets) {
      const bLow = bucket.price - bucketSize / 2;
      const bHigh = bucket.price + bucketSize / 2;
      const overlapLow = Math.max(candle.low, bLow);
      const overlapHigh = Math.min(candle.high, bHigh);
      if (overlapHigh <= overlapLow) continue;
      const overlapPct = (overlapHigh - overlapLow) / candleRange;
      bucket.volume += (candle.volume || 1) * overlapPct;
    }
  }

  const sorted = [...buckets].sort((a, b) => b.volume - a.volume);

  const hvn = sorted.slice(0, 3).map(b => parseFloat(b.price.toFixed(2)));
  const lvn = sorted.slice(-3).map(b => parseFloat(b.price.toFixed(2)));
  const poc = parseFloat(sorted[0].price.toFixed(2));

  const totalVol = sorted.reduce((s, b) => s + b.volume, 0);
  const targetVol = totalVol * 0.70;
  let accumulated = 0;
  const vaprices = [];
  for (const b of sorted) {
    accumulated += b.volume;
    vaprices.push(b.price);
    if (accumulated >= targetVol) break;
  }
  const valueAreaHigh = parseFloat(Math.max(...vaprices).toFixed(2));
  const valueAreaLow = parseFloat(Math.min(...vaprices).toFixed(2));

  return { poc, hvn, lvn, valueAreaHigh, valueAreaLow, weeklyHigh: high, weeklyLow: low, period };
}

export function getVolumeProfileSignal(currentPrice, profile) {
  if (!profile || currentPrice == null) {
    return { signal: 'unknown', nearestHVN: null, nearestLVN: null, poc: null, description: 'No volume profile data' };
  }

  const nearestHVN = profile.hvn.reduce((best, h) =>
    Math.abs(h - currentPrice) < Math.abs(best - currentPrice) ? h : best
  , profile.hvn[0]);

  const nearestLVN = profile.lvn.reduce((best, l) =>
    Math.abs(l - currentPrice) < Math.abs(best - currentPrice) ? l : best
  , profile.lvn[0]);

  const atHVN = Math.abs(currentPrice - nearestHVN) < 10;
  const atLVN = Math.abs(currentPrice - nearestLVN) < 10;
  const aboveVA = currentPrice > profile.valueAreaHigh;
  const belowVA = currentPrice < profile.valueAreaLow;
  const atPOC = Math.abs(currentPrice - profile.poc) < 15;

  const signal = atHVN ? 'at_hvn' : atLVN ? 'at_lvn' : atPOC ? 'at_poc' :
                 aboveVA ? 'above_va' : belowVA ? 'below_va' : 'in_va';

  const description =
    atHVN ? 'Price at high-volume node — strong S/R' :
    atLVN ? 'Price at low-volume node — fast movement zone' :
    atPOC ? 'Price at Point of Control — institutional equilibrium' :
    aboveVA ? 'Price above value area — premium, watch for rejection' :
    belowVA ? 'Price below value area — discount, watch for support' :
    'Price within value area — fair value range';

  return {
    signal,
    nearestHVN: nearestHVN?.toFixed(2),
    nearestLVN: nearestLVN?.toFixed(2),
    poc: profile.poc?.toFixed(2),
    valueAreaHigh: profile.valueAreaHigh?.toFixed(2),
    valueAreaLow: profile.valueAreaLow?.toFixed(2),
    atHVN, atLVN, atPOC, aboveVA, belowVA,
    description,
  };
}
