import { detectSwings } from './swings.js';

// Liquidity pools (equal highs / equal lows).
// EQH: >=2 swing highs within 0.2*ATR of each other. EQL: mirror.
// Swept = a later candle exceeded the level then closed back inside.
function average(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeAtr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function clusterSwings(swings, tolerance) {
  const clusters = [];
  for (const s of swings) {
    let added = false;
    for (const c of clusters) {
      const mean = average(c.map(x => x.price));
      if (Math.abs(s.price - mean) <= tolerance) {
        c.push(s);
        added = true;
        break;
      }
    }
    if (!added) clusters.push([s]);
  }
  return clusters.filter(c => c.length >= 2);
}

export function detectLiquidity(candles, n = 5) {
  const atr = computeAtr(candles, 14);
  if (!atr) return { eqh: [], eql: [], atr: null };
  const tolerance = 0.2 * atr;

  const swings = detectSwings(candles, n);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  const highClusters = clusterSwings(highs, tolerance);
  const lowClusters = clusterSwings(lows, tolerance);

  function buildLevel(cluster, type) {
    const prices = cluster.map(s => s.price);
    const level = type === 'high' ? Math.max(...prices) : Math.min(...prices);
    const lastIdx = Math.max(...cluster.map(s => s.index));

    // Check sweep: a candle after lastIdx exceeded the level then closed back
    let swept = false;
    let sweptAt = null;
    for (let k = lastIdx + 1; k < candles.length; k++) {
      const c = candles[k];
      if (type === 'high' && c.high > level && c.close < level) {
        swept = true;
        sweptAt = k;
        break;
      }
      if (type === 'low' && c.low < level && c.close > level) {
        swept = true;
        sweptAt = k;
        break;
      }
    }

    return {
      type: type === 'high' ? 'EQH' : 'EQL',
      level,
      count: cluster.length,
      firstIndex: cluster[0].index,
      lastIndex: lastIdx,
      swept,
      sweptAt,
    };
  }

  return {
    eqh: highClusters.map(c => buildLevel(c, 'high')),
    eql: lowClusters.map(c => buildLevel(c, 'low')),
    atr,
    tolerance,
  };
}
