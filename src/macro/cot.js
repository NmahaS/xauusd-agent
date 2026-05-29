// COT (Commitment of Traders) report parser.
// Data released every Friday 15:30 ET by CFTC. Commercials = smart money.
import fs from 'node:fs';
import path from 'node:path';

const CACHE_FILE = 'cache/cot.json';
const CACHE_TTL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days

// CFTC public API — no key needed
const CFTC_URL =
  'https://publicreporting.cftc.gov/api/explore/dataset/tradants_3_fut/records' +
  "?where=market_and_exchange_names%20like%20%27%25GOLD%25%27" +
  '&order_by=report_date_as_yyyy_mm_dd%20DESC&limit=8';

function loadCotCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const age = Date.now() - new Date(data.cachedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    console.log(`[cot] using cached COT (age: ${Math.round(age / 3600000)}h)`);
    return data.result;
  } catch { return null; }
}

function saveCotCache(result) {
  try {
    fs.mkdirSync('cache', { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ cachedAt: new Date().toISOString(), result }));
  } catch (err) {
    console.warn(`[cot] cache write failed: ${err.message}`);
  }
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export async function fetchCOTReport() {
  const cached = loadCotCache();
  if (cached) return cached;

  console.log('[cot] fetching CFTC gold COT data...');
  try {
    const res = await fetch(CFTC_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`CFTC API HTTP ${res.status}`);
    const json = await res.json();

    // OpenDataSoft wraps records in results.records[].record.fields
    const records = (json.results ?? json.records ?? []).map(r => r.record?.fields ?? r.fields ?? r);

    if (!records.length) throw new Error('CFTC API returned no gold records');

    // Extract last 8 weeks of data
    const weeks = records.map(r => ({
      date: r.report_date_as_yyyy_mm_dd,
      commLong: Number(r.comm_positions_long_all ?? 0),
      commShort: Number(r.comm_positions_short_all ?? 0),
      specLong: Number(r.noncomm_positions_long_all ?? 0),
      specShort: Number(r.noncomm_positions_short_all ?? 0),
      openInterest: Number(r.open_interest_all ?? 0),
    })).filter(w => w.date);

    if (weeks.length < 2) throw new Error(`Only ${weeks.length} COT records returned`);

    const latest = weeks[0];
    const prev2 = weeks[Math.min(2, weeks.length - 1)];

    const commercialNet = latest.commLong - latest.commShort;
    const speculatorNet = latest.specLong - latest.specShort;

    const commercialNets = weeks.map(w => w.commLong - w.commShort);
    const speculatorNets = weeks.map(w => w.specLong - w.specShort);

    const commercialNetAvg4w = commercialNets.slice(0, 4).reduce((s, v) => s + v, 0) / Math.min(4, commercialNets.length);
    const speculatorNetAvg4w = speculatorNets.slice(0, 4).reduce((s, v) => s + v, 0) / Math.min(4, speculatorNets.length);

    const prevCommercialNet = (prev2.commLong - prev2.commShort);
    let commercialTrend;
    if (commercialNet > prevCommercialNet + 5000) commercialTrend = 'accumulating';
    else if (commercialNet < prevCommercialNet - 5000) commercialTrend = 'distributing';
    else commercialTrend = 'neutral';

    const p90 = percentile(speculatorNets, 90);
    const p10 = percentile(speculatorNets, 10);
    const speculatorExtremeHigh = speculatorNet >= p90;
    const speculatorExtremeLow = speculatorNet <= p10;

    let cotBias;
    if (commercialTrend === 'accumulating' && !speculatorExtremeHigh) cotBias = 'bullish';
    else if (commercialTrend === 'distributing' && !speculatorExtremeLow) cotBias = 'bearish';
    else cotBias = 'neutral';

    const cotSignal =
      `Commercials net ${commercialNet > 0 ? 'LONG' : 'SHORT'} ${Math.abs(commercialNet).toLocaleString()} ` +
      `| Speculators net ${speculatorNet > 0 ? 'LONG' : 'SHORT'} ${Math.abs(speculatorNet).toLocaleString()} ` +
      `| Trend: ${commercialTrend} → COT bias: ${cotBias}`;

    console.log(`[cot] ${cotSignal}`);

    const result = {
      reportDate: latest.date,
      commercialNet,
      speculatorNet,
      commercialNetAvg4w,
      speculatorNetAvg4w,
      commercialTrend,
      speculatorExtremeHigh,
      speculatorExtremeLow,
      cotBias,
      cotSignal,
      raw: weeks.slice(0, 4),
    };

    saveCotCache(result);
    return result;
  } catch (err) {
    console.warn(`[cot] fetch failed: ${err.message} — COT unavailable this run`);
    return {
      reportDate: null,
      commercialNet: null,
      speculatorNet: null,
      commercialTrend: 'neutral',
      speculatorExtremeHigh: false,
      speculatorExtremeLow: false,
      cotBias: 'neutral',
      cotSignal: `COT unavailable: ${err.message}`,
      raw: [],
      error: err.message,
    };
  }
}
