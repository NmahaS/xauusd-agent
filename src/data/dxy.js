import { fetchSymbolCandles } from './twelvedata.js';

// TwelveData free tier doesn't support DXY. EUR/USD serves as an inverse dollar proxy:
// EUR/USD rising  => dollar weakening => bullish for gold
// EUR/USD falling => dollar strengthening => bearish for gold
const PROXY_SYMBOL = 'EUR/USD';
const PROXY_LABEL = 'EUR/USD (dollar proxy)';

function computeTrend(candles) {
  if (candles.length < 5) return 'unknown';
  const recent = candles.slice(-5);
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;
  const pct = ((last - first) / first) * 100;
  if (pct > 0.15) return 'rising';
  if (pct < -0.15) return 'falling';
  return 'stable';
}

function change24h(candles) {
  if (candles.length < 24) return null;
  const now = candles[candles.length - 1].close;
  const then = candles[candles.length - 24].close;
  return ((now - then) / then) * 100;
}

function goldImpact(trend) {
  if (trend === 'rising') return 'bullish for gold (USD weakening via EUR/USD rising)';
  if (trend === 'falling') return 'bearish for gold (USD strengthening via EUR/USD falling)';
  return 'neutral for gold';
}

export async function fetchDxy() {
  try {
    const res = await fetchSymbolCandles(PROXY_SYMBOL, '1h', 50);
    if (!res.ok || res.candles.length === 0) {
      throw new Error(res.error || `no ${PROXY_SYMBOL} candles`);
    }
    const candles = res.candles;
    const last = candles[candles.length - 1];
    const trend = computeTrend(candles);
    const change = change24h(candles);
    const impact = goldImpact(trend);
    console.log(`[dollar-proxy] ${PROXY_LABEL} last=${last.close.toFixed(5)} trend=${trend} 24h=${change?.toFixed(2)}%`);
    return {
      ok: true,
      symbol: PROXY_LABEL,
      last: last.close,
      change24hPct: change,
      trend,
      goldImpact: impact,
      candles,
    };
  } catch (err) {
    console.warn(`[dollar-proxy] failed: ${err.message}`);
    return {
      ok: false,
      symbol: PROXY_LABEL,
      last: null,
      change24hPct: null,
      trend: 'unknown',
      goldImpact: 'unknown',
      candles: [],
      error: err.message,
    };
  }
}
