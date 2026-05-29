const HL_BASE = 'https://api.hyperliquid.xyz/info';

async function hlPost(body) {
  const res = await fetch(HL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return res.json();
}

export async function fetchHLCandles(coin, interval, count = 200) {
  const endTime = Date.now();
  const intervalMs = {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
  }[interval] || 60 * 60 * 1000;

  const startTime = endTime - count * intervalMs;

  const data = await hlPost({
    type: 'candleSnapshot',
    req: { coin, interval, startTime, endTime },
  });

  if (!Array.isArray(data)) throw new Error('Hyperliquid: invalid candle response');

  const candles = data.map(c => ({
    time: new Date(c.t).toISOString(),
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v),
  }));

  console.log(`[hl] fetched ${candles.length} ${interval} candles for ${coin}`);
  return candles;
}

export async function fetchHLMarketData(coin = process.env.HL_COIN || 'PAXG') {
  const [meta, assetCtxs] = await hlPost({ type: 'metaAndAssetCtxs' });
  const idx = meta.universe.findIndex(a => a.name === coin);
  if (idx === -1) {
    const allCoins = meta.universe.map(a => a.name).join(', ');
    console.error(`[hl] ${coin} not found. Available: ${allCoins}`);
    throw new Error(`${coin} not found on Hyperliquid. Check HL_COIN env var.`);
  }

  const asset = assetCtxs[idx];
  const markPrice = parseFloat(asset.markPx);
  const midPrice = parseFloat(asset.midPx || asset.markPx);
  const funding = parseFloat(asset.funding);
  const openInterest = parseFloat(asset.openInterest);

  console.log(`[hl] ${coin} mark=${markPrice} funding=${(funding * 100).toFixed(4)}% OI=${openInterest}`);

  return {
    coin,
    markPrice,
    midPrice,
    currentPrice: midPrice,
    funding,
    fundingAnnualized: funding * 24 * 365 * 100,
    openInterest,
    oraclePrice: parseFloat(asset.oraclePx),
    spread: Math.abs(midPrice - parseFloat(asset.oraclePx ?? asset.markPx)),
    marketStatus: 'TRADEABLE',
  };
}

export async function fetchDollarProxy() {
  try {
    // Frankfurter.app — ECB official data, free, no key
    const today = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD').then(r => r.json());
    const latest = today.rates?.USD || 1.1;
    // Use ECB long-run average as neutral baseline for trend direction
    const BASE_EURUSD = 1.08;
    const change = ((latest - BASE_EURUSD) / BASE_EURUSD) * 100;
    // USD strength = inverse of EUR/USD direction
    const usdChange = -change;
    const trend = Math.abs(usdChange) < 0.1 ? 'flat' : usdChange > 0 ? 'strengthening' : 'weakening';
    return {
      latestClose: latest,
      last: latest,
      change24h: usdChange,
      change24hPct: usdChange,
      trend,
      correlation: trend === 'strengthening' ? 'bearish-for-gold' : trend === 'weakening' ? 'bullish-for-gold' : 'neutral',
      goldImpact: trend === 'strengthening' ? 'bearish-for-gold' : trend === 'weakening' ? 'bullish-for-gold' : 'neutral',
      symbol: 'EUR/USD',
      source: 'frankfurter.app',
      ok: true,
    };
  } catch (err) {
    console.warn(`[hl] dollar proxy failed: ${err.message}`);
    return {
      latestClose: 1.1, last: 1.1, change24h: 0, change24hPct: 0,
      trend: 'unknown', correlation: 'unknown', goldImpact: 'unknown',
      symbol: 'EUR/USD', source: 'unavailable', ok: false,
    };
  }
}

export function getFundingSignal(funding) {
  if (funding > 0.0001) return {
    longPct: 70, shortPct: 30,
    signal: 'crowded_long_contrarian_bearish',
    fundingNote: `Longs paying ${(funding * 100).toFixed(4)}%/hr — crowded long`,
  };
  if (funding < -0.0001) return {
    longPct: 30, shortPct: 70,
    signal: 'crowded_short_contrarian_bullish',
    fundingNote: `Shorts paying ${(Math.abs(funding) * 100).toFixed(4)}%/hr — crowded short`,
  };
  return {
    longPct: 50, shortPct: 50,
    signal: 'neutral',
    fundingNote: `Funding balanced at ${(funding * 100).toFixed(4)}%/hr`,
  };
}

export async function fetchAllHLData() {
  const coin = process.env.HL_COIN || 'PAXG';
  console.log('[hl] fetching all market data...');

  const [h1Candles, h4Candles, m15Candles, marketData, dxy] = await Promise.all([
    fetchHLCandles(coin, '1h', 200),
    fetchHLCandles(coin, '4h', 200),
    fetchHLCandles(coin, '15m', 200),
    fetchHLMarketData(coin),
    fetchDollarProxy(),
  ]);

  const igSentiment = getFundingSignal(marketData.funding);

  const recent24h = h1Candles.slice(-24);
  const dailyHigh = recent24h.length ? Math.max(...recent24h.map(c => c.high)) : null;
  const dailyLow = recent24h.length ? Math.min(...recent24h.map(c => c.low)) : null;
  const open24h = recent24h[0]?.open ?? marketData.currentPrice;
  const change24h = open24h
    ? ((marketData.currentPrice - open24h) / open24h * 100).toFixed(2)
    : '0.00';

  console.log(`[hl] data ready: H1=${h1Candles.length} H4=${h4Candles.length} M15=${m15Candles.length}`);
  console.log(`[hl] price=${marketData.currentPrice} funding=${(marketData.funding * 100).toFixed(4)}%`);

  return {
    h1Candles,
    h4Candles,
    m15Candles,
    currentPrice: marketData.currentPrice,
    markPrice: marketData.markPrice,
    spread: marketData.spread,
    dailyHigh,
    dailyLow,
    marketStatus: 'TRADEABLE',
    change24h,
    igSentiment,
    funding: marketData.funding,
    fundingAnnualized: marketData.fundingAnnualized,
    openInterest: marketData.openInterest,
    oraclePrice: marketData.oraclePrice,
    dxy,
    session: null,
    dataSource: 'hyperliquid',
  };
}
