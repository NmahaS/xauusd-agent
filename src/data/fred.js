import { config } from '../config.js';

const BASE_URL = 'https://api.stlouisfed.org/fred/series/observations';

async function fetchSeries(seriesId, limit = 30) {
  const url = new URL(BASE_URL);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', config.FRED_API_KEY);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED HTTP ${res.status} for ${seriesId}`);
  const json = await res.json();
  if (!Array.isArray(json.observations)) {
    throw new Error(`FRED bad response for ${seriesId}`);
  }
  return json.observations
    .filter(o => o.value !== '.' && o.value !== '')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }));
}

function trendFrom(observations) {
  if (observations.length < 5) return 'unknown';
  const recent = observations.slice(0, 5).map(o => o.value);
  const first = recent[recent.length - 1];
  const last = recent[0];
  const diff = last - first;
  if (Math.abs(diff) < 0.05) return 'stable';
  return diff > 0 ? 'rising' : 'falling';
}

export async function fetchFredMacro() {
  if (!config.FRED_API_KEY) {
    console.warn('[fred] FRED_API_KEY not set — skipping macro data');
    return {
      ok: false,
      tenYearYield: null,
      fedRate: null,
      breakeven: null,
      realYield: null,
      yieldTrend: 'unknown',
      goldImpact: 'unknown',
      error: 'FRED_API_KEY not set',
    };
  }

  try {
    const [tenYearObs, fedObs, beObs] = await Promise.all([
      fetchSeries('DGS10', 30),
      fetchSeries('FEDFUNDS', 12),
      fetchSeries('T10YIE', 30),
    ]);

    const tenY = tenYearObs[0]?.value ?? null;
    const fed = fedObs[0]?.value ?? null;
    const be = beObs[0]?.value ?? null;
    const realYield = tenY != null && be != null ? tenY - be : null;
    const yieldTrend = trendFrom(tenYearObs);

    let goldImpact;
    if (realYield == null) {
      goldImpact = 'unknown';
    } else if (realYield > 2) {
      goldImpact = 'strongly bearish (high real yields)';
    } else if (realYield > 1) {
      goldImpact = 'bearish (positive real yields)';
    } else if (realYield > 0) {
      goldImpact = 'neutral-bearish (slightly positive real yields)';
    } else {
      goldImpact = 'bullish (negative real yields)';
    }

    console.log(`[fred] 10Y=${tenY} FedFunds=${fed} BE=${be} Real=${realYield?.toFixed(2)} trend=${yieldTrend}`);
    return {
      ok: true,
      tenYearYield: tenY,
      fedRate: fed,
      breakeven: be,
      realYield,
      yieldTrend,
      goldImpact,
    };
  } catch (err) {
    console.warn(`[fred] failed: ${err.message}`);
    return {
      ok: false,
      tenYearYield: null,
      fedRate: null,
      breakeven: null,
      realYield: null,
      yieldTrend: 'unknown',
      goldImpact: 'unknown',
      error: err.message,
    };
  }
}
