import { config } from '../config.js';

const BASE_URL = config.IG_DEMO === false || config.IG_DEMO === 'false'
  ? 'https://api.ig.com/gateway/deal'
  : 'https://demo-api.ig.com/gateway/deal';

export const IG_ENV = BASE_URL.startsWith('https://api.ig.com') ? 'LIVE' : 'DEMO';

const GOLD_EPICS = [
  // AUD epics confirmed via market search on this IG Australia account
  'MT.D.GC.FWS2.IP',          // Gold ($100) — AUD-100 contract, primary
  'MT.D.GC.FWM2.IP',          // Gold ($33.20) — AUD-33.20 contract
  'CS.D.CFAGOLD.CAF.IP',      // Spot Gold (A$10 Contract)
  'CS.D.CFAGOLD.CFA.IP',      // Spot Gold (A$1 Contract)
  // Generic / USD-priced fallbacks (kept so non-AU accounts still work)
  'CS.D.CFDGOLD.CFD.IP',
  'IX.D.XAUUSD.MINI.IP',
  'CS.D.XAUUSD.CFD.IP',
  'CS.D.USCGC.TODAY.IP',      // Last resort — known scaling issues
];

const EURUSD_EPICS = [
  'CS.D.EURUSD.CFD.IP',       // Standard — scalingFactor lies but prices are real
  'CS.D.EURUSD.MINI.IP',      // Mini CFD
  'CS.D.EURUSD.TODAY.IP',     // Spread bet — needs divide by 10000
];

function parseSnapshotTime(s) {
  // IG returns "2026/04/25 02:00:00:000" — millis separated by colon, not dot
  const m = String(s || '').match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?::(\d{3}))?$/);
  if (!m) return new Date(s).toISOString();
  const [, y, mo, d, h, mi, se, ms = '000'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}.${ms}Z`;
}

function mid(bid, ask) {
  if (bid == null || ask == null) return null;
  return (Number(bid) + Number(ask)) / 2;
}

// Brute-force search for the divisor that yields a price in the plausible band
// for the asset class. Beats trusting IG's instrument.scalingFactor, which lies on CFD epics.
function findWorkingDivisor(rawPrice, assetType) {
  if (rawPrice == null || !Number.isFinite(rawPrice)) return null;
  const candidates = [1, 10, 100, 1000, 10000];
  for (const d of candidates) {
    const scaled = rawPrice / d;
    if (assetType === 'GOLD' && scaled >= 2000 && scaled <= 15000) return d;
    if (assetType === 'FX' && scaled >= 0.5 && scaled <= 5.0) return d;
  }
  return null;
}

function rescaleCandles(rawCandles, divisor) {
  if (!divisor || divisor === 1) return rawCandles;
  return rawCandles.map(c => ({
    ...c,
    open: c.open != null ? c.open / divisor : null,
    high: c.high != null ? c.high / divisor : null,
    low: c.low != null ? c.low / divisor : null,
    close: c.close != null ? c.close / divisor : null,
  }));
}

function rescaleMarketSnapshot(market, divisor) {
  if (!divisor || divisor === 1) return market;
  return {
    ...market,
    bid: market.bid != null ? market.bid / divisor : null,
    offer: market.offer != null ? market.offer / divisor : null,
    mid: market.mid != null ? market.mid / divisor : null,
    spread: market.spread != null ? market.spread / divisor : null,
    high: market.high != null ? market.high / divisor : null,
    low: market.low != null ? market.low / divisor : null,
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

async function fetchRawCandles(session, epic, resolution, max) {
  const path = `/prices/${epic}?resolution=${resolution}&max=${max}`;
  const json = await igGet(path, session, 3);
  const prices = Array.isArray(json.prices) ? json.prices : [];
  return prices.map(igPriceToCandle).filter(c => c.close != null);
}

async function fetchRawMarketDetails(session, epic) {
  const json = await igGet(`/markets/${epic}`, session, 3);
  const snap = json.snapshot || {};
  const inst = json.instrument || {};
  const bid = snap.bid != null ? Number(snap.bid) : null;
  const offer = snap.offer != null ? Number(snap.offer) : null;
  return {
    bid,
    offer,
    mid: mid(bid, offer),
    spread: bid != null && offer != null ? offer - bid : null,
    marketStatus: snap.marketStatus || 'UNKNOWN',
    high: snap.high != null ? Number(snap.high) : null,
    low: snap.low != null ? Number(snap.low) : null,
    netChange: snap.netChange != null ? Number(snap.netChange) : null,
    percentageChange: snap.percentageChange != null ? Number(snap.percentageChange) : null,
    updateTime: snap.updateTime,
    instrumentName: inst.name,
  };
}

async function fetchIGClientSentiment(session, marketId) {
  const json = await igGet(`/clientsentiment/${marketId}`, session, 1);
  const longPct = json.longPositionPercentage != null ? Number(json.longPositionPercentage) : null;
  const shortPct = json.shortPositionPercentage != null ? Number(json.shortPositionPercentage) : null;

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

// Search IG's market catalog for AUD gold instruments. Logs every result so the user can
// see what's available on the account. Returns the preferred epic ('Gold ($100)' if found),
// then any AUD gold fallback, or null if nothing matches.
async function discoverGoldEpic(session) {
  let data;
  try {
    data = await igGet(`/markets?searchTerm=${encodeURIComponent('gold')}&currencies=AUD`, session, 1);
  } catch (err) {
    console.warn(`[ig] gold market search failed: ${err.message}`);
    return null;
  }

  console.log('[ig] gold market search results:');
  if (Array.isArray(data?.markets)) {
    data.markets.forEach(m => {
      console.log(
        `  epic=${m.epic} name=${m.instrumentName} ` +
        `currency=${m.currency ?? m.instrumentCurrency ?? 'n/a'} ` +
        `streamingPricesAvailable=${m.streamingPricesAvailable}`
      );
    });
  } else {
    console.log('  (no markets array in response)');
  }

  // IG omits the `currency` field on the search response even when filtered with currencies=AUD.
  // Trust the server-side filter and instead exclude obvious non-contract names (mining stocks
  // and ETFs land in the same result set).
  const isContract = m => {
    const n = m.instrumentName || '';
    if (/\b(Inc|PLC|Corp|Ltd|Limited|Pty|AG|NL|SA)\b/i.test(n)) return false;
    if (/ETF/i.test(n)) return false;
    return /gold/i.test(n);
  };
  const candidates = (data.markets || []).filter(isContract);

  const preferred = candidates.find(m => /Gold\s*\(\$?100\)/.test(m.instrumentName));
  const fallback = candidates.find(m => /^Gold\s*\(/.test(m.instrumentName))
    || candidates.find(m => /A\$/.test(m.instrumentName))
    || candidates[0];

  return preferred?.epic || fallback?.epic || null;
}

// Resolve a gold epic via cross-validation: candles and snapshot must each scale to a
// plausible price AND agree within 10%. Catches the USCGC.TODAY.IP quirk where candle
// (4847) and snapshot (1404) come back in different unit conventions on the same epic.
async function resolveGoldEpic(session) {
  const discovered = await discoverGoldEpic(session);
  if (discovered) {
    console.log(`[ig] gold epic from discovery: ${discovered} (will be tried first)`);
  }
  const candidates = [...new Set([
    ...(discovered ? [discovered] : []),
    ...GOLD_EPICS,
  ])];

  for (const epic of candidates) {
    try {
      const [h1Raw, marketRaw] = await Promise.all([
        fetchRawCandles(session, epic, 'HOUR', config.CANDLES_LOOKBACK || 200).catch(() => null),
        fetchRawMarketDetails(session, epic).catch(() => null),
      ]);

      if (!h1Raw?.length || !marketRaw) {
        console.log(`[ig] gold epic ${epic} probe failed — no data, trying next`);
        continue;
      }

      const lastCandle = h1Raw[h1Raw.length - 1].close;
      const snapshotMid = marketRaw.mid;
      const candleDivisor = findWorkingDivisor(lastCandle, 'GOLD');
      const snapshotDivisor = findWorkingDivisor(snapshotMid, 'GOLD');

      if (!candleDivisor && !snapshotDivisor) {
        console.log(`[ig] gold epic ${epic} — neither candle (${lastCandle}) nor snapshot (${snapshotMid}) produce plausible gold price, trying next`);
        continue;
      }

      const scaledCandle = lastCandle / (candleDivisor || 1);
      const scaledSnapshot = snapshotMid / (snapshotDivisor || 1);
      const gap = Math.abs(scaledCandle - scaledSnapshot) / Math.max(scaledCandle, scaledSnapshot);

      if (gap > 0.10) {
        console.warn(
          `[ig] gold epic ${epic} INCONSISTENT — candle=${scaledCandle.toFixed(2)} (÷${candleDivisor}) ` +
          `vs snapshot=${scaledSnapshot.toFixed(2)} (÷${snapshotDivisor}) gap=${(gap * 100).toFixed(1)}% — trying next`
        );
        continue;
      }

      const h4Raw = await fetchRawCandles(session, epic, 'HOUR_4', 100).catch(err => {
        console.warn(`[ig] gold epic ${epic}: H4 fetch failed (${err.message}) — continuing with H1 only`);
        return [];
      });

      const h1Candles = rescaleCandles(h1Raw, candleDivisor || 1);
      const h4Candles = rescaleCandles(h4Raw, candleDivisor || 1);
      const market = rescaleMarketSnapshot(marketRaw, snapshotDivisor || 1);

      console.log(
        `[ig] gold epic resolved: ${epic} candle=${scaledCandle.toFixed(2)} ` +
        `snapshot=${scaledSnapshot.toFixed(2)} gap=${(gap * 100).toFixed(1)}% ✓`
      );

      return {
        epic,
        candleDivisor: candleDivisor || 1,
        snapshotDivisor: snapshotDivisor || 1,
        h1Candles,
        h4Candles,
        market,
      };
    } catch (err) {
      console.log(`[ig] gold epic ${epic} probe failed: ${err.message}, trying next`);
    }
  }

  console.error('[ig] NO gold epic resolved — all failed validation');
  return null;
}

// Same cross-validation for EUR/USD with FX plausibility band 0.5–5.0 and tighter 5% gap.
async function resolveEurUsdEpic(session) {
  for (const epic of EURUSD_EPICS) {
    try {
      const [h1Raw, marketRaw] = await Promise.all([
        fetchRawCandles(session, epic, 'HOUR', 50).catch(() => null),
        fetchRawMarketDetails(session, epic).catch(() => null),
      ]);

      if (!h1Raw?.length || !marketRaw) {
        console.log(`[ig] EUR/USD epic ${epic} probe failed — no data, trying next`);
        continue;
      }

      const lastCandle = h1Raw[h1Raw.length - 1].close;
      const snapshotMid = marketRaw.mid;
      const candleDivisor = findWorkingDivisor(lastCandle, 'FX');
      const snapshotDivisor = findWorkingDivisor(snapshotMid, 'FX');

      if (!candleDivisor && !snapshotDivisor) {
        console.log(`[ig] EUR/USD epic ${epic} — neither candle (${lastCandle}) nor snapshot (${snapshotMid}) produce plausible FX price, trying next`);
        continue;
      }

      const scaledCandle = lastCandle / (candleDivisor || 1);
      const scaledSnapshot = snapshotMid / (snapshotDivisor || 1);
      const gap = Math.abs(scaledCandle - scaledSnapshot) / Math.max(scaledCandle, scaledSnapshot);

      if (gap > 0.05) {
        console.warn(
          `[ig] EUR/USD epic ${epic} INCONSISTENT — candle=${scaledCandle.toFixed(5)} (÷${candleDivisor}) ` +
          `vs snapshot=${scaledSnapshot.toFixed(5)} (÷${snapshotDivisor}) gap=${(gap * 100).toFixed(1)}% — trying next`
        );
        continue;
      }

      const h1Candles = rescaleCandles(h1Raw, candleDivisor || 1);
      const market = rescaleMarketSnapshot(marketRaw, snapshotDivisor || 1);

      console.log(
        `[ig] EUR/USD epic resolved: ${epic} candle=${scaledCandle.toFixed(5)} ` +
        `snapshot=${scaledSnapshot.toFixed(5)} gap=${(gap * 100).toFixed(1)}% ✓`
      );

      return {
        epic,
        candleDivisor: candleDivisor || 1,
        snapshotDivisor: snapshotDivisor || 1,
        h1Candles,
        market,
      };
    } catch (err) {
      console.log(`[ig] EUR/USD epic ${epic} probe failed: ${err.message}, trying next`);
    }
  }

  console.error('[ig] NO EUR/USD epic resolved — all failed validation');
  return null;
}

function computeDxyProxyFromEurUsd(eurUsdCandles, divisor = 1) {
  // EUR/USD is the dominant DXY component (~57% weight). USD strength ≈ inverse of EUR/USD.
  if (!eurUsdCandles.length) {
    return {
      ok: false, latestClose: null, change24h: null, trend: 'unknown', correlation: 'unknown',
      scalingFactor: divisor,
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
    scalingFactor: divisor,
    symbol: 'DXY (EUR/USD proxy)',
    last,
    change24hPct: usdChange,
    goldImpact: correlation,
  };
}

// Public M15 fetcher used by src/refinement/m15.js. Same scaling/IG conventions as the
// internal H1/H4 fetch in fetchAllIGData, but exposed so the M15 refinement step can run
// without redoing epic discovery.
export async function fetchIGCandles(session, epic, resolution, max, divisor = 1) {
  const raw = await fetchRawCandles(session, epic, resolution, max);
  return rescaleCandles(raw, divisor || 1);
}

function emptyIGData(errMsg) {
  return {
    h1Candles: [],
    h4Candles: [],
    currentPrice: null,
    spread: null,
    dailyHigh: null,
    dailyLow: null,
    marketStatus: 'OFFLINE',
    change24h: null,
    igSentiment: { longPct: 0, shortPct: 0, signal: 'unknown' },
    dxy: { latestClose: null, change24h: null, trend: 'unknown', correlation: 'unknown' },
    session: null,
    error: errMsg,
  };
}

export async function fetchAllIGData() {
  const tStart = Date.now();
  console.log(`[ig] environment=${IG_ENV}`);
  let session;
  try {
    session = await igLogin();
  } catch (loginErr) {
    console.error(`[ig] login failed: ${loginErr.message} — returning empty IG data`);
    return emptyIGData(loginErr.message);
  }
  console.log(`[ig] login ok (${session.env}) in ${Date.now() - tStart}ms`);

  try {
    const [gold, eur, igSentiment] = await Promise.all([
      resolveGoldEpic(session),
      resolveEurUsdEpic(session),
      fetchIGClientSentiment(session, 'GOLD').catch(err => {
        console.warn(`[ig] sentiment failed: ${err.message}`);
        return { longPct: null, shortPct: null, signal: 'unknown' };
      }),
    ]);

    if (!gold) {
      const msg = 'No working gold epic found across fallback list';
      console.error(`[ig] ${msg}`);
      return emptyIGData(msg);
    }

    if (gold.h1Candles.length < 50) {
      console.warn(
        `[ig] WARN: only ${gold.h1Candles.length} H1 candles available (expected ≥50). ` +
        `IG demo and weekend windows have tight history quotas — proceeding with reduced data.`
      );
    }

    const dxy = computeDxyProxyFromEurUsd(eur?.h1Candles || [], eur?.candleDivisor || 1);

    console.log(`[ig] summary H1=${gold.h1Candles.length} H4=${gold.h4Candles.length} EUR/USD=${eur?.h1Candles.length ?? 0}`);
    console.log(`[ig] gold market ${gold.epic} mid=${gold.market.mid?.toFixed(2)} spread=${gold.market.spread?.toFixed(2)} status=${gold.market.marketStatus}`);
    console.log(`[ig] sentiment long=${igSentiment.longPct}% short=${igSentiment.shortPct}% signal=${igSentiment.signal}`);
    console.log(`[ig] dxy proxy latestClose=${dxy.latestClose?.toFixed(5)} change24h=${dxy.change24h?.toFixed(2)}% trend=${dxy.trend} divisor=${dxy.scalingFactor}`);

    return {
      h1Candles: gold.h1Candles,
      h4Candles: gold.h4Candles,
      currentPrice: gold.market.mid,
      spread: gold.market.spread,
      dailyHigh: gold.market.high,
      dailyLow: gold.market.low,
      marketStatus: gold.market.marketStatus,
      change24h: gold.market.percentageChange,
      igSentiment,
      dxy,
      session,
      // Additive: surface the resolved gold epic + scaling so M15 refinement and the
      // executor can reuse them without re-running discovery.
      goldEpic: gold.epic,
      goldDivisor: gold.candleDivisor,
    };
  } catch (err) {
    console.error(`[ig] data fetch failed after login: ${err.message} — returning empty IG data`);
    return emptyIGData(err.message);
  }
}
