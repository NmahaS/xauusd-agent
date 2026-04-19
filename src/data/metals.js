import { config } from '../config.js';

async function fetchMetalpriceApi() {
  if (!config.METALPRICE_API_KEY) throw new Error('METALPRICE_API_KEY not set');
  const url = `https://api.metalpriceapi.com/v1/latest?api_key=${config.METALPRICE_API_KEY}&base=USD&currencies=XAU,XAG,XPT`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MetalpriceAPI HTTP ${res.status}`);
  const json = await res.json();
  console.log(`[metals] MetalpriceAPI raw response: ${JSON.stringify(json)}`);
  if (!json.success || !json.rates) {
    throw new Error(`MetalpriceAPI error: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const rates = json.rates;
  // USDXAU/USDXAG/USDXPT are already USD prices per troy oz (e.g. USDXAU=3300 means $3300/oz).
  // XAU/XAG/XPT (without USD prefix) are inverted — do NOT use those.
  const gold = rates.USDXAU;
  const silver = rates.USDXAG;
  const platinum = rates.USDXPT ?? null;
  if (gold == null || silver == null) {
    throw new Error(`MetalpriceAPI missing USDXAU or USDXAG fields. Available: ${Object.keys(rates).join(',')}`);
  }

  if (gold < 1000 || gold > 20000 || silver < 10 || silver > 500) {
    throw new Error(
      `MetalpriceAPI sanity check failed (gold=${gold}, silver=${silver}). ` +
      `Raw rates: ${JSON.stringify(rates)}`
    );
  }
  if (platinum != null && (platinum < 200 || platinum > 10000)) {
    throw new Error(`MetalpriceAPI platinum sanity check failed (platinum=${platinum}). Raw rates: ${JSON.stringify(rates)}`);
  }

  return { gold, silver, platinum, source: 'metalpriceapi' };
}

async function fetchMetalsDev() {
  if (!config.METALSDEV_API_KEY) throw new Error('METALSDEV_API_KEY not set');
  const url = `https://api.metals.dev/v1/latest?api_key=${config.METALSDEV_API_KEY}&currency=USD&unit=toz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Metals.dev HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 'success' || !json.metals) {
    throw new Error(`Metals.dev error: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const gold = json.metals.gold;
  const silver = json.metals.silver;
  const platinum = json.metals.platinum ?? null;
  if (gold == null || silver == null) {
    throw new Error(`Metals.dev missing gold/silver. Raw metals: ${JSON.stringify(json.metals)}`);
  }
  if (gold < 500 || silver < 5) {
    throw new Error(
      `Metals.dev sanity check failed (gold=${gold}, silver=${silver}). ` +
      `Raw metals: ${JSON.stringify(json.metals)}`
    );
  }
  return { gold, silver, platinum, source: 'metals.dev' };
}

function computeRatios(spot, chartGoldPrice) {
  const auAg = spot.silver ? spot.gold / spot.silver : null;
  const auPt = spot.platinum ? spot.gold / spot.platinum : null;
  const spotVsChart = chartGoldPrice ? spot.gold - chartGoldPrice : null;
  const spotVsChartPct = chartGoldPrice ? ((spot.gold - chartGoldPrice) / chartGoldPrice) * 100 : null;

  let auAgSignal = 'normal';
  if (auAg != null) {
    if (auAg > 90) auAgSignal = 'gold extremely extended vs silver (overbought risk)';
    else if (auAg > 80) auAgSignal = 'gold extended vs silver';
    else if (auAg < 60) auAgSignal = 'silver outperforming (risk-on)';
  }

  return { auAg, auPt, spotVsChart, spotVsChartPct, auAgSignal };
}

export async function fetchMetals({ chartGoldPrice } = {}) {
  // Silver is no longer fetched from TwelveData — only MetalpriceAPI or Metals.dev.
  const sources = [fetchMetalpriceApi, fetchMetalsDev];
  let spot = null;
  let lastError = null;
  for (const fn of sources) {
    try {
      spot = await fn();
      console.log(`[metals] using ${spot.source}: Au=${spot.gold?.toFixed(2)} Ag=${spot.silver?.toFixed(3)} Pt=${spot.platinum?.toFixed(2) ?? 'n/a'}`);
      break;
    } catch (err) {
      lastError = err.message;
      console.warn(`[metals] ${fn.name} failed: ${err.message}`);
    }
  }
  if (!spot) {
    return {
      ok: false,
      gold: null,
      silver: null,
      platinum: null,
      auAg: null,
      auPt: null,
      spotVsChart: null,
      spotVsChartPct: null,
      auAgSignal: 'unknown',
      source: 'none',
      error: lastError,
    };
  }
  const ratios = computeRatios(spot, chartGoldPrice);
  return { ok: true, ...spot, ...ratios };
}
