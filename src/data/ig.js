import { config } from '../config.js';

const BASE_URL = config.IG_DEMO === false || config.IG_DEMO === 'false'
  ? 'https://api.ig.com/gateway/deal'
  : 'https://demo-api.ig.com/gateway/deal';

export const IG_ENV = BASE_URL.startsWith('https://api.ig.com') ? 'LIVE' : 'DEMO';

const GOLD_EPICS = [
  'CS.D.CFDGOLD.CFD.IP',    // Standard CFD gold — works on live
  'CS.D.USCGC.TODAY.IP',    // Spread bet fallback
  'IX.D.XAUUSD.MINI.IP',    // Mini gold fallback
];

const EURUSD_EPICS = [
  'CS.D.EURUSD.CFD.IP',     // Standard CFD EUR/USD — works on live
  'CS.D.EURUSD.TODAY.IP',   // Spread bet fallback
];

function parseSnapshotTime(s) {
  // IG returns "2026/04/25 02:00:00:000" — millis separated by colon, not dot
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?::(\d{3}))?$/);
  if (!m) return new Date(s).toISOString();
  const [, y, mo, d, h, mi, se, ms = '000'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}.${ms}Z`;
}

function mid(bid, ask) {
  if (bid == null || ask == null) return null;
  return (Number(bid) + Number(ask)) / 2;
}

// IG transmits prices as integers compressed by an instrument-specific divisor.
// Resolution order:
//   1. instrument.scalingFactor — set on canonical CFD epics (e.g. CS.D.CFDGOLD.CFD.IP).
//   2. onePipMeans — for `.TODAY.IP` spread-bet epics (e.g. "0.0001 USD/EUR" → divisor 10000).
//   3. price-magnitude heuristic — last-resort safety net for XAU when metadata is missing.
function deriveScalingFactor(instrument, { epic, samplePrice } = {}) {
  if (!instrument) return 1;
  if (instrument.scalingFactor != null && Number(instrument.scalingFactor) !== 0) {
    return Number(instrument.scalingFactor);
  }
  const m = String(instrument.onePipMeans || '').match(/^\s*([0-9]*\.?[0-9]+)/);
  if (m) {
    const pipValue = Number(m[1]);
    if (pipValue > 0) return Math.round(1 / pipValue);
  }
  if (samplePrice != null && /XAU|GOLD/i.test(epic || '')) {
    if (samplePrice > 100000) return 100;
    if (samplePrice > 10000) return 10;
  }
  return 1;
}

function applyScalingFactor(price, scalingFactor) {
  if (price == null) return null;
  if (!scalingFactor || scalingFactor === 1) return price;
  return Number(price) / scalingFactor;
}

function scaleCandle(c, scalingFactor) {
  if (!scalingFactor || scalingFactor === 1) return c;
  return {
    ...c,
    open: applyScalingFactor(c.open, scalingFactor),
    high: applyScalingFactor(c.high, scalingFactor),
    low: applyScalingFactor(c.low, scalingFactor),
    close: applyScalingFactor(c.close, scalingFactor),
  };
}

function igPriceToCandle(p) {
  return {
    time: parseSnapshotTime(p.snapshotTime),
    open: mid(p.openPrice?.bid, p.openPrice?.ask),
    high: mid(p.highPrice?.bid, p.highPrice?.ask),
    low: mid(p.lowPrice?.bid, p.lowPrice?.ask),
    close: mid(p.closePrice?.bid, p.closePrice?.ask),
    volume: p.lastTradedVolume != null ? Number(p.lastTradedVolume) : 0,
  };
}

async function igLogin() {
  const url = `${BASE_URL}/session`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-IG-API-KEY': config.IG_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json; charset=UTF-8',
      Version: '2',
    },
    body: JSON.stringify({
      identifier: config.IG_USERNAME,
      password: config.IG_PASSWORD,
      encryptedPassword: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IG login HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const cst = res.headers.get('cst') || res.headers.get('CST');
  const xst = res.headers.get('x-security-token') || res.headers.get('X-SECURITY-TOKEN');
  if (!cst || !xst) {
    throw new Error('IG login: missing CST / X-SECURITY-TOKEN headers');
  }
  return { cst, xst, env: IG_ENV };
}

async function igGet(path, session, version) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-IG-API-KEY': config.IG_API_KEY,
      CST: session.cst,
      'X-SECURITY-TOKEN': session.xst,
      Accept: 'application/json; charset=UTF-8',
      Version: String(version),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IG GET ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function epicExists(session, epic) {
  try {
    await igGet(`/markets/${epic}`, session, 3);
    return true;
  } catch {
    return false;
  }
}

async function resolveEpicFromList(session, fallbacks, label) {
  for (const epic of fallbacks) {
    if (await epicExists(session, epic)) {
      console.log(`[ig] ${label} epic resolved via fallback list: ${epic}`);
      return epic;
    }
  }
  return null;
}

async function discoverGoldEpic(session) {
  const fromList = await resolveEpicFromList(session, GOLD_EPICS, 'gold');
  if (fromList) return fromList;
  // Last resort: search the markets catalog for "Spot Gold".
  try {
    const json = await igGet(`/markets?searchTerm=${encodeURIComponent('Spot Gold')}`, session, 1);
    const candidates = (json.markets || []).filter(m =>
      /gold/i.test(m.instrumentName || '') && !/silver|platinum|mining/i.test(m.instrumentName || '')
    );
    const tradeable = candidates.find(m => m.marketStatus === 'TRADEABLE') || candidates[0];
    if (tradeable?.epic) {
      console.log(`[ig] gold epic resolved via search: ${tradeable.epic} (${tradeable.instrumentName})`);
      return tradeable.epic;
    }
  } catch (err) {
    console.warn(`[ig] gold epic search failed: ${err.message}`);
  }
  throw new Error('IG: could not resolve a tradeable Spot Gold epic on this account');
}

async function discoverEurUsdEpic(session) {
  const fromList = await resolveEpicFromList(session, EURUSD_EPICS, 'EUR/USD');
  if (fromList) return fromList;
  console.warn('[ig] EUR/USD epic not found on account — DXY proxy will be unavailable');
  return null;
}

async function fetchCandles(session, epic, resolution, max) {
  const path = `/prices/${epic}?resolution=${resolution}&max=${max}`;
  const json = await igGet(path, session, 3);
  const prices = Array.isArray(json.prices) ? json.prices : [];
  return prices.map(igPriceToCandle).filter(c => c.close != null);
}

async function fetchCandlesSafe(session, epic, resolution, max, label) {
  try {
    const candles = await fetchCandles(session, epic, resolution, max);
    console.log(`[ig] ${label} ok (${candles.length} candles)`);
    return candles;
  } catch (err) {
    console.warn(`[ig] ${label} failed: ${err.message}`);
    return [];
  }
}

async function fetchMarketDetails(session, epic) {
  const json = await igGet(`/markets/${epic}`, session, 3);
  const snap = json.snapshot || {};
  const inst = json.instrument || {};
  const sf = deriveScalingFactor(inst, { epic, samplePrice: snap.bid });

  const bid = applyScalingFactor(snap.bid, sf);
  const offer = applyScalingFactor(snap.offer, sf);
  const high = applyScalingFactor(snap.high, sf);
  const low = applyScalingFactor(snap.low, sf);

  return {
    bid,
    offer,
    mid: mid(bid, offer),
    spread: bid != null && offer != null ? offer - bid : null,
    marketStatus: snap.marketStatus || 'UNKNOWN',
    high,
    low,
    netChange: snap.netChange != null ? Number(snap.netChange) : null,
    percentageChange: snap.percentageChange != null ? Number(snap.percentageChange) : null,
    updateTime: snap.updateTime,
    scalingFactor: sf,
    instrumentName: inst.name,
  };
}

async function fetchIGClientSentiment(session, marketId) {
  const json = await igGet(`/clientsentiment/${marketId}`, session, 1);
  const longPct = json.longPositionPercentage != null ? Number(json.longPositionPercentage) : null;
  const shortPct = json.shortPositionPercentage != null ? Number(json.shortPositionPercentage) : null;

  // When the market is closed IG returns 0/0 — that's not a real "balanced" reading.
  if (longPct === 0 && shortPct === 0) {
    return { longPct, shortPct, signal: 'unknown', note: 'Market closed — no live sentiment' };
  }

  let signal = 'neutral';
  if (longPct != null) {
    if (longPct >= 70) signal = 'contrarian-bearish';
    else if (longPct <= 30) signal = 'contrarian-bullish';
  }
  return { longPct, shortPct, signal };
}

function computeDxyProxyFromEurUsd(eurUsdCandles, scalingFactor = 1) {
  // EUR/USD is the dominant DXY component (~57% weight). USD strength ≈ inverse of EUR/USD.
  if (!eurUsdCandles.length) {
    return {
      ok: false, latestClose: null, change24h: null, trend: 'unknown', correlation: 'unknown',
      scalingFactor,
    };
  }
  const last = eurUsdCandles[eurUsdCandles.length - 1].close;
  const prev = eurUsdCandles.length >= 24 ? eurUsdCandles[eurUsdCandles.length - 24].close : eurUsdCandles[0].close;
  const eurChange = ((last - prev) / prev) * 100;
  const usdChange = -eurChange;
  let trend;
  if (Math.abs(usdChange) < 0.1) trend = 'flat';
  else trend = usdChange > 0 ? 'strengthening' : 'weakening';
  const correlation =
    trend === 'strengthening' ? 'bearish-for-gold' :
    trend === 'weakening' ? 'bullish-for-gold' :
    'neutral';
  return {
    ok: true,
    latestClose: last,
    change24h: usdChange,
    trend,
    correlation,
    scalingFactor,
    symbol: 'DXY (EUR/USD proxy)',
    last,
    change24hPct: usdChange,
    goldImpact: correlation,
  };
}

export async function fetchAllIGData() {
  const tStart = Date.now();
  console.log(`[ig] environment=${IG_ENV}`);
  const session = await igLogin();
  console.log(`[ig] login ok (${session.env}) in ${Date.now() - tStart}ms`);

  const [goldEpic, eurUsdEpic] = await Promise.all([
    discoverGoldEpic(session),
    discoverEurUsdEpic(session),
  ]);

  const [
    h1CandlesRaw,
    h4CandlesRaw,
    eurUsdCandlesRaw,
    goldMarket,
    eurUsdMarket,
    igSentiment,
  ] = await Promise.all([
    fetchCandlesSafe(session, goldEpic, 'HOUR', config.CANDLES_LOOKBACK || 200, 'XAU H1'),
    fetchCandlesSafe(session, goldEpic, 'HOUR_4', 100, 'XAU H4'),
    eurUsdEpic
      ? fetchCandlesSafe(session, eurUsdEpic, 'HOUR', 50, 'EUR/USD H1')
      : Promise.resolve([]),
    fetchMarketDetails(session, goldEpic),
    eurUsdEpic
      ? fetchMarketDetails(session, eurUsdEpic).catch(err => {
          console.warn(`[ig] EUR/USD market details failed: ${err.message}`);
          return null;
        })
      : Promise.resolve(null),
    fetchIGClientSentiment(session, 'GOLD').catch(err => {
      console.warn(`[ig] sentiment failed: ${err.message}`);
      return { longPct: null, shortPct: null, signal: 'unknown' };
    }),
  ]);

  // Apply each instrument's scalingFactor to its candles (raw IG prices are integer-compressed).
  const goldSF = goldMarket.scalingFactor || 1;
  const eurSF = eurUsdMarket?.scalingFactor || 1;
  const h1Candles = h1CandlesRaw.map(c => scaleCandle(c, goldSF));
  const h4Candles = h4CandlesRaw.map(c => scaleCandle(c, goldSF));
  const eurUsdCandles = eurUsdCandlesRaw.map(c => scaleCandle(c, eurSF));

  if (h1Candles.length < 50) {
    console.warn(
      `[ig] WARN: only ${h1Candles.length} H1 candles available (expected ≥50). ` +
      `IG demo and weekend windows have tight history quotas — proceeding with reduced data.`
    );
  }

  const goldSampleClose = h1Candles[h1Candles.length - 1]?.close;
  if (goldSampleClose != null) {
    if (goldSampleClose < 1000 || goldSampleClose > 10000) {
      throw new Error(`Gold price sanity check failed: ${goldSampleClose} (expected 1000-10000 range)`);
    }
    console.log(`[ig] gold scalingFactor=${goldSF} price=${goldSampleClose.toFixed(2)} ✓`);
    console.log(`[ig] gold price sanity: ${goldSampleClose.toFixed(2)} ✓`);
  } else {
    console.warn(`[ig] gold price sanity: skipped — no H1 candles`);
  }

  if (eurUsdEpic) {
    const eurSampleClose = eurUsdCandles[eurUsdCandles.length - 1]?.close;
    if (eurSampleClose != null) {
      if (eurSampleClose < 0.5 || eurSampleClose > 5) {
        console.warn(`[ig] EUR/USD scaling may be wrong: ${eurSampleClose} — check scalingFactor`);
      }
      console.log(`[ig] EUR/USD scalingFactor=${eurSF} price=${eurSampleClose.toFixed(5)} ✓`);
    }
  }

  console.log(`[ig] summary H1=${h1Candles.length} H4=${h4Candles.length} EUR/USD=${eurUsdCandles.length}`);
  console.log(`[ig] market ${goldEpic} mid=${goldMarket.mid?.toFixed(2)} spread=${goldMarket.spread?.toFixed(2)} status=${goldMarket.marketStatus}`);
  console.log(`[ig] sentiment long=${igSentiment.longPct}% short=${igSentiment.shortPct}% signal=${igSentiment.signal}`);

  const dxy = computeDxyProxyFromEurUsd(eurUsdCandles, eurSF);
  console.log(`[ig] dxy proxy latestClose=${dxy.latestClose?.toFixed(5)} change24h=${dxy.change24h?.toFixed(2)}% trend=${dxy.trend} scalingFactor=${dxy.scalingFactor}`);

  return {
    h1Candles,
    h4Candles,
    currentPrice: goldMarket.mid,
    spread: goldMarket.spread,
    dailyHigh: goldMarket.high,
    dailyLow: goldMarket.low,
    marketStatus: goldMarket.marketStatus,
    change24h: goldMarket.percentageChange,
    igSentiment,
    dxy,
    session,
  };
}
