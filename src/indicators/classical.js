import pkg from 'technicalindicators';
const { EMA, RSI, ATR, MACD } = pkg;

function last(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null;
}

// Find last two swing points (highs or lows) in a numeric series using pivot n=2
function findLastTwoSwings(series, type, n = 2) {
  const swings = [];
  for (let i = n; i < series.length - n; i++) {
    const v = series[i];
    let isPivot = true;
    for (let k = 1; k <= n; k++) {
      if (type === 'high') {
        if (!(v > series[i - k] && v > series[i + k])) { isPivot = false; break; }
      } else {
        if (!(v < series[i - k] && v < series[i + k])) { isPivot = false; break; }
      }
    }
    if (isPivot) swings.push({ index: i, value: v });
  }
  return swings.slice(-2);
}

function detectDivergence(candles, rsiValues) {
  // rsiValues aligns with the last rsiValues.length candles (RSI skips first period-1 values)
  if (!rsiValues || rsiValues.length < 10) {
    return { bullish: false, bearish: false };
  }
  const offset = candles.length - rsiValues.length;
  const priceHighs = candles.slice(offset).map(c => c.high);
  const priceLows = candles.slice(offset).map(c => c.low);

  const rsiHighs = findLastTwoSwings(rsiValues, 'high');
  const rsiLows = findLastTwoSwings(rsiValues, 'low');

  let bearish = false;
  if (rsiHighs.length === 2) {
    const [h1, h2] = rsiHighs;
    const priceH1 = priceHighs[h1.index];
    const priceH2 = priceHighs[h2.index];
    // Bearish divergence: price makes higher high, RSI makes lower high
    if (priceH2 > priceH1 && h2.value < h1.value) bearish = true;
  }

  let bullish = false;
  if (rsiLows.length === 2) {
    const [l1, l2] = rsiLows;
    const priceL1 = priceLows[l1.index];
    const priceL2 = priceLows[l2.index];
    // Bullish divergence: price makes lower low, RSI makes higher low
    if (priceL2 < priceL1 && l2.value > l1.value) bullish = true;
  }

  return { bullish, bearish };
}

export function computeClassicalIndicators(candles) {
  if (!Array.isArray(candles) || candles.length < 50) {
    return {
      ok: false,
      error: `need >=50 candles, got ${candles?.length ?? 0}`,
    };
  }
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = candles.length >= 200 ? EMA.calculate({ period: 200, values: closes }) : [];
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const latestMacd = last(macd);
  const divergence = detectDivergence(candles, rsi);
  const lastClose = last(closes);
  const ema20L = last(ema20);
  const ema50L = last(ema50);
  const ema200L = last(ema200);

  let trend = 'neutral';
  if (ema20L && ema50L) {
    if (ema20L > ema50L && (ema200L == null || lastClose > ema200L)) trend = 'bullish';
    else if (ema20L < ema50L && (ema200L == null || lastClose < ema200L)) trend = 'bearish';
  }

  return {
    ok: true,
    lastClose,
    ema20: ema20L,
    ema50: ema50L,
    ema200: ema200L,
    rsi: last(rsi),
    atr: last(atr),
    macd: latestMacd ? {
      macd: latestMacd.MACD ?? null,
      signal: latestMacd.signal ?? null,
      histogram: latestMacd.histogram ?? null,
    } : null,
    divergence,
    trend,
  };
}
