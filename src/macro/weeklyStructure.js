// Weekly DXY proxy (EUR/USD) trend + yield trend for macro bias.
// Uses TwelveData weekly candles and the existing FRED module.
import fs from 'node:fs';

const CACHE_FILE = 'cache/weekly_macro.json';
const CACHE_TTL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days — refresh only on Monday

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const age = Date.now() - new Date(data.cachedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return data.result;
  } catch { return null; }
}

function saveCache(result) {
  try {
    fs.mkdirSync('cache', { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ cachedAt: new Date().toISOString(), result }));
  } catch (err) {
    console.warn(`[weekly-macro] cache write failed: ${err.message}`);
  }
}

async function fetchWeeklyEURUSD() {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) {
    console.warn('[weekly-macro] TWELVEDATA_API_KEY not set — skipping weekly EUR/USD');
    return null;
  }
  const url = `https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1week&outputsize=12&apikey=${key}&timezone=UTC`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TwelveData weekly EUR/USD HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.values)) throw new Error(`TwelveData weekly: ${json.message || 'no values'}`);
  // values come newest-first; reverse to get chronological order
  return json.values
    .map(v => ({ time: v.datetime, close: parseFloat(v.close) }))
    .reverse();
}

function classifyWeeklyTrend(closes) {
  if (closes.length < 4) return 'unknown';
  const last4 = closes.slice(-4);
  let rising = 0;
  for (let i = 1; i < last4.length; i++) {
    if (last4[i].close > last4[i - 1].close) rising++;
  }
  if (rising === 3) return 'strongly_rising';
  if (rising === 2) return 'rising';
  if (rising === 1) return 'falling';
  return 'strongly_falling';
}

async function fetchWeeklyYieldTrend() {
  const key = process.env.FRED_API_KEY;
  if (!key) return { trend: 'unknown', yieldBias: 'neutral' };
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${key}&file_type=json&sort_order=desc&limit=8`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`FRED weekly DGS10 HTTP ${res.status}`);
    const json = await res.json();
    const obs = (json.observations || []).filter(o => o.value !== '.' && o.value !== '').map(o => parseFloat(o.value));
    if (obs.length < 4) return { trend: 'unknown', yieldBias: 'neutral' };
    // obs[0] = most recent week, obs[3] = 4 weeks ago
    const diff = obs[0] - obs[3];
    const trend = Math.abs(diff) < 0.05 ? 'stable' : diff > 0 ? 'rising' : 'falling';
    const yieldBias = trend === 'falling' ? 'bullish_gold' : trend === 'rising' ? 'bearish_gold' : 'neutral';
    return { trend, yieldBias, latestYield: obs[0] };
  } catch (err) {
    console.warn(`[weekly-macro] FRED yield fetch failed: ${err.message}`);
    return { trend: 'unknown', yieldBias: 'neutral' };
  }
}

export async function fetchWeeklyMacro() {
  const cached = loadCache();
  if (cached) {
    console.log('[weekly-macro] using cached weekly macro');
    return cached;
  }

  console.log('[weekly-macro] fetching fresh weekly structure...');

  let weeklyCandles = null;
  try {
    weeklyCandles = await fetchWeeklyEURUSD();
  } catch (err) {
    console.warn(`[weekly-macro] EUR/USD weekly fetch failed: ${err.message}`);
  }

  const yieldData = await fetchWeeklyYieldTrend();

  let weeklyDXYTrend = 'unknown';
  let weeklyDXYBias = 'neutral';

  if (weeklyCandles?.length >= 4) {
    // EUR/USD rising → dollar weakening → bullish gold
    weeklyDXYTrend = classifyWeeklyTrend(weeklyCandles);
    const biasMap = {
      strongly_rising: 'strongly_bullish_gold',
      rising: 'bullish_gold',
      falling: 'bearish_gold',
      strongly_falling: 'strongly_bearish_gold',
    };
    weeklyDXYBias = biasMap[weeklyDXYTrend] ?? 'neutral';
    console.log(`[weekly-macro] EUR/USD weekly trend: ${weeklyDXYTrend} → gold bias: ${weeklyDXYBias}`);
  } else {
    console.warn('[weekly-macro] insufficient weekly candles for EUR/USD trend');
  }

  // Combine DXY + yield into weekly macro bias
  const dxyBullish = weeklyDXYBias.includes('bullish');
  const dxyBearish = weeklyDXYBias.includes('bearish');
  const yieldBullish = yieldData.yieldBias === 'bullish_gold';
  const yieldBearish = yieldData.yieldBias === 'bearish_gold';

  let weeklyMacroBias;
  if (dxyBullish && yieldBullish) weeklyMacroBias = 'bullish';
  else if (dxyBearish && yieldBearish) weeklyMacroBias = 'bearish';
  else if (dxyBullish && !yieldBearish) weeklyMacroBias = 'bullish';
  else if (dxyBearish && !yieldBullish) weeklyMacroBias = 'bearish';
  else weeklyMacroBias = 'neutral';

  const summary =
    `Weekly EUR/USD: ${weeklyDXYTrend} (${weeklyDXYBias}) | ` +
    `10Y yield: ${yieldData.trend} (${yieldData.yieldBias}) | ` +
    `Combined: ${weeklyMacroBias}`;

  console.log(`[weekly-macro] ${summary}`);

  const result = {
    weeklyDXYTrend,
    weeklyDXYBias,
    weeklyYieldTrend: yieldData.trend,
    weeklyYieldBias: yieldData.yieldBias,
    latestYield: yieldData.latestYield ?? null,
    weeklyMacroBias,
    summary,
  };

  saveCache(result);
  return result;
}
