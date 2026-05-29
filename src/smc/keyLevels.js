export function identifyKeyLevels(h4Candles, h1Candles, m15Candles, currentPrice) {
  const levels = [];

  if (!Array.isArray(h4Candles) || h4Candles.length < 5) {
    console.warn('[levels] insufficient H4 candles for key level detection');
    return { all: [], approaching: [], nearest: null, nearestResistance: null, nearestSupport: null };
  }

  // H4 swing highs and lows (major levels)
  const h4Highs = [];
  const h4Lows = [];
  for (let i = 2; i < h4Candles.length - 2; i++) {
    const c = h4Candles[i];
    const isHigh = c.high > h4Candles[i - 1].high &&
                   c.high > h4Candles[i - 2].high &&
                   c.high > h4Candles[i + 1].high &&
                   c.high > h4Candles[i + 2].high;
    const isLow  = c.low < h4Candles[i - 1].low &&
                   c.low < h4Candles[i - 2].low &&
                   c.low < h4Candles[i + 1].low &&
                   c.low < h4Candles[i + 2].low;
    if (isHigh) h4Highs.push(c.high);
    if (isLow)  h4Lows.push(c.low);
  }

  // Last 3 H4 highs = resistance levels
  h4Highs.slice(-3).forEach(price => {
    const distance = price - currentPrice;
    levels.push({
      price,
      type: 'resistance',
      timeframe: 'H4',
      distance: Math.abs(distance),
      direction: distance > 0 ? 'above' : 'below',
      tradeAction: 'SHORT when price reaches this level',
    });
  });

  // Last 3 H4 lows = support levels
  h4Lows.slice(-3).forEach(price => {
    const distance = price - currentPrice;
    levels.push({
      price,
      type: 'support',
      timeframe: 'H4',
      distance: Math.abs(distance),
      direction: distance > 0 ? 'above' : 'below',
      tradeAction: 'LONG when price reaches this level',
    });
  });

  // Sort by distance from current price
  levels.sort((a, b) => a.distance - b.distance);

  // Tag: is price approaching a level?
  const approaching = levels.filter(l => l.distance < 20);

  console.log(`[levels] ${levels.length} key levels identified`);
  console.log(`[levels] ${approaching.length} levels within 20pts`);
  approaching.forEach(l => {
    console.log(`[levels] ${l.direction.toUpperCase()} ${l.distance.toFixed(1)}pts: $${l.price.toFixed(2)} (${l.type} ${l.timeframe})`);
  });

  return {
    all: levels,
    approaching,
    nearest: levels[0] || null,
    nearestResistance: levels.find(l => l.type === 'resistance' && l.direction === 'above'),
    nearestSupport: levels.find(l => l.type === 'support' && l.direction === 'below'),
  };
}
