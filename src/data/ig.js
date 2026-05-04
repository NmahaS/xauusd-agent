import { config } from '../config.js';
import { loadCache, saveCache, appendToCache, isCacheReady } from './candleCache.js';

const BASE_URL = config.IG_DEMO === false || config.IG_DEMO === 'false'
  ? 'https://api.ig.com/gateway/deal'
  : 'https://demo-api.ig.com/gateway/deal';

export const IG_ENV = BASE_URL.startsWith('https://api.ig.com') ? 'LIVE' : 'DEMO';

const GOLD_EPICS = [
  'MT.D.GC.FWS2.IP',          // Gold ($100) JUN-26 — confirmed working on this account
  'MT.D.GC.FWM2.IP',          // Gold ($33.20) JUN-26
  'CS.D.CFAGOLD.CFA.IP',      // Spot Gold (A$1 Contract)
  'CS.D.CFAGOLD.CAF.IP',      // Spot Gold (A$10 Contract)
  'CS.D.CFDGOLD.CFD.IP',      // Standard CFD
  'IX.D.SUNGOLD.CFD.IP',      // Weekend Spot Gold
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
    expiry: inst.expiry ?? null,
    expiryLastDealingDate: inst.expiryDetails?.lastDealingDate ?? null,
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

  const tradeable = (data?.markets || []).filter(m => m.streamingPricesAvailable);
  console.log(`[ig] found ${data?.markets?.length || 0} gold markets, ${tradeable.length} tradeable`);
  tradeable.slice(0, 5).forEach(m => {
    console.log(`  [ig] tradeable: ${m.epic} — ${m.instrumentName}`);
  });

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

const GAP_TOLERANCE = 0.20; // 20% — covers AUD futures candle/snapshot convention differences

function checkContractExpiry(marketRaw) {
  if (!marketRaw) return;
  const { expiry, expiryLastDealingDate, instrumentName } = marketRaw;
  if (expiry) {
    console.log(`[ig] contract expiry: ${expiry}${instrumentName ? ` (${instrumentName})` : ''} last dealing: ${expiryLastDealingDate ?? 'unknown'}`);
  }
  if (expiryLastDealingDate) {
    const daysLeft = (new Date(expiryLastDealingDate) - Date.now()) / 86_400_000;
    if (daysLeft < 7) {
      console.warn(`[ig] ⚠️ CONTRACT EXPIRING IN ${daysLeft.toFixed(0)} DAYS — watch for rollover to next quarter`);
    }
  }
}

// Snapshot-only mode: triggered when candle quota is exhausted. Returns current price from
// the live market snapshot so the pipeline can at least alert with a valid price.
async function resolveGoldEpicSnapshotOnly(session, epics) {
  console.log('[ig] quota exhausted — trying snapshot-only mode (current price only, no candles)');
  for (const epic of epics) {
    try {
      const marketRaw = await fetchRawMarketDetails(session, epic).catch(() => null);
      if (!marketRaw?.mid) continue;
      const divisor = findWorkingDivisor(marketRaw.mid, 'GOLD');
      if (!divisor) continue;
      const scaledPrice = marketRaw.mid / divisor;
      console.log(`[ig] SNAPSHOT-ONLY: ${epic} price=${scaledPrice.toFixed(2)} status=${marketRaw.marketStatus}`);
      checkContractExpiry(marketRaw);
      return {
        epic,
        candleDivisor: divisor,
        snapshotDivisor: divisor,
        h1Candles: [],
        h4Candles: [],
        market: rescaleMarketSnapshot(marketRaw, divisor),
        snapshotOnly: true,
      };
    } catch {}
  }
  return null;
}

// Last-resort epic resolution: requests only 20 candles and ignores snapshot entirely.
// Called when the main loop exhausts all candidates (quota hit, snapshot mismatch, etc.)
async function resolveGoldEpicLastResort(session) {
  console.log('[ig] trying last-resort fallback — ignoring snapshot, using candle price only');
  for (const epic of GOLD_EPICS) {
    try {
      console.log(`[ig] last-resort trying: ${epic}`);
      const h1Raw = await fetchRawCandles(session, epic, 'HOUR', 20).catch(() => null);
      if (!h1Raw?.length) {
        console.log(`[ig] last-resort ${epic}: no candles`);
        continue;
      }
      const lastClose = h1Raw[h1Raw.length - 1].close;
      const divisor = findWorkingDivisor(lastClose, 'GOLD');
      if (!divisor) {
        console.log(`[ig] last-resort ${epic}: no valid divisor for price ${lastClose}`);
        continue;
      }
      const scaledPrice = lastClose / divisor;
      console.log(`[ig] last-resort ${epic}: candle price=${scaledPrice.toFixed(2)} divisor=${divisor}`);
      console.warn(`[ig] LAST RESORT: using ${epic} candle-only price=${scaledPrice.toFixed(2)} (snapshot unavailable/mismatched)`);
      return {
        epic,
        candleDivisor: divisor,
        snapshotDivisor: divisor,
        h1Candles: rescaleCandles(h1Raw, divisor),
        h4Candles: [],
        market: {
          mid: scaledPrice,
          bid: null,
          offer: null,
          spread: 1.0,
          high: scaledPrice * 1.005,
          low: scaledPrice * 0.995,
          marketStatus: 'TRADEABLE',
          percentageChange: 0,
          warningNote: 'Last-resort: candle price only, snapshot skipped',
        },
        lastResort: true,
      };
    } catch (err) {
      console.log(`[ig] last-resort ${epic} failed: ${err.message}`);
    }
  }
  return null;
}

// Resolve a gold epic via cross-validation: candles must scale to a plausible gold price;
// if a live snapshot is available, it must agree within GAP_TOLERANCE. If the snapshot is
// unavailable (market closed, futures contract off-hours), candle price is used directly.
// If every epic fails the gap check but at least one had plausible candle data, that best
// candidate is used with a warning. If all else fails, resolveGoldEpicLastResort is tried.
async function resolveGoldEpic(session) {
  const discovered = await discoverGoldEpic(session);
  if (discovered) {
    console.log(`[ig] gold epic from discovery: ${discovered} (will be tried first)`);
  }
  const candidates = [...new Set([
    ...(discovered ? [discovered] : []),
    ...GOLD_EPICS,
  ])];

  // Tracks the first epic with a plausible candle price, used as gap-check fallback.
  let fallbackCandidate = null;

  for (const epic of candidates) {
    console.log(`[ig] trying epic: ${epic}...`);
    try {
      let h1FetchErr = null;
      const [h1Raw, marketRaw] = await Promise.all([
        fetchIGCandlesCached(epic, 'HOUR', config.CANDLES_LOOKBACK || 200, session).catch(err => {
          h1FetchErr = err;
          return null;
        }),
        fetchRawMarketDetails(session, epic).catch(() => null),
      ]);

      if (!h1Raw?.length) {
        const errMsg = h1FetchErr ? h1FetchErr.message.slice(0, 120) : 'empty prices array';
        console.log(`[ig] epic ${epic} result: FAILED ✗ reason: ${errMsg}`);
        if (h1FetchErr?.message?.includes('exceeded-account-historical-data-allowance')) {
          console.error('[ig] IG historical data quota exhausted — quota resets weekly');
          const snapOnly = await resolveGoldEpicSnapshotOnly(session, candidates);
          if (snapOnly) return snapOnly;
          break;
        }
        continue;
      }

      const lastCandle = h1Raw[h1Raw.length - 1].close;
      const candleDivisor = findWorkingDivisor(lastCandle, 'GOLD');

      if (!candleDivisor) {
        console.log(`[ig] epic ${epic} result: FAILED ✗ reason: candle (${lastCandle}) outside plausible gold range`);
        continue;
      }

      const scaledCandle = lastCandle / candleDivisor;

      // Save first plausible candle for gap-check fallback
      if (!fallbackCandidate) {
        fallbackCandidate = { epic, h1Raw, marketRaw, candleDivisor, scaledCandle };
      }

      // If snapshot unavailable (market closed / futures off-hours), skip gap check
      const snapshotMid = marketRaw?.mid ?? null;
      if (snapshotMid == null) {
        console.log(`[ig] candle=${scaledCandle.toFixed(2)} snapshot=unavailable`);
        console.log(`[ig] epic ${epic} result: PASSED ✓ reason: snapshot unavailable, using candle price`);
        const h4Raw = await fetchIGCandlesCached(epic, 'HOUR_4', 200, session).catch(() => []);
        const market = marketRaw
          ? { ...rescaleMarketSnapshot(marketRaw, candleDivisor), mid: scaledCandle }
          : { mid: scaledCandle, marketStatus: 'CLOSED', bid: null, offer: null, spread: null };
        checkContractExpiry(marketRaw);
        return {
          epic,
          candleDivisor,
          snapshotDivisor: candleDivisor,
          h1Candles: rescaleCandles(h1Raw, candleDivisor),
          h4Candles: rescaleCandles(h4Raw, candleDivisor),
          market,
        };
      }

      const snapshotDivisor = findWorkingDivisor(snapshotMid, 'GOLD');
      const scaledSnapshot = snapshotDivisor ? snapshotMid / snapshotDivisor : null;

      if (scaledSnapshot == null) {
        console.log(`[ig] candle=${scaledCandle.toFixed(2)} snapshot=${snapshotMid}`);
        console.log(`[ig] epic ${epic} result: FAILED ✗ reason: snapshot (${snapshotMid}) outside plausible gold range`);
        continue;
      }

      const gap = Math.abs(scaledCandle - scaledSnapshot) / Math.max(scaledCandle, scaledSnapshot);
      const withinTolerance = gap <= GAP_TOLERANCE;
      console.log(`[ig] candle=${scaledCandle.toFixed(2)} snapshot=${scaledSnapshot.toFixed(2)} gap=${(gap * 100).toFixed(1)}%`);
      console.log(
        `[ig] epic ${epic} result: ${withinTolerance ? 'PASSED ✓' : 'FAILED ✗'} ` +
        `reason: ${withinTolerance ? `within ${GAP_TOLERANCE * 100}% tolerance` : `gap ${(gap * 100).toFixed(1)}% > ${GAP_TOLERANCE * 100}% tolerance`}`
      );

      if (!withinTolerance) continue;

      const h4Raw = await fetchIGCandlesCached(epic, 'HOUR_4', 200, session).catch(err => {
        console.warn(`[ig] ${epic}: H4 fetch failed (${err.message}) — continuing with H1 only`);
        return [];
      });

      checkContractExpiry(marketRaw);
      return {
        epic,
        candleDivisor,
        snapshotDivisor,
        h1Candles: rescaleCandles(h1Raw, candleDivisor),
        h4Candles: rescaleCandles(h4Raw, candleDivisor),
        market: rescaleMarketSnapshot(marketRaw, snapshotDivisor),
      };
    } catch (err) {
      console.log(`[ig] epic ${epic} result: FAILED ✗ reason: ${err.message.slice(0, 120)}`);
    }
  }

  // Gap-check fallback: all epics passed candle plausibility but failed snapshot gap
  if (fallbackCandidate) {
    const { epic, h1Raw, marketRaw, candleDivisor, scaledCandle } = fallbackCandidate;
    console.warn(`[ig] FALLBACK: using ${epic} candle price despite snapshot gap — snapshot may be stale`);
    const h4Raw = await fetchIGCandlesCached(epic, 'HOUR_4', 200, session).catch(() => []);
    const market = marketRaw
      ? { ...rescaleMarketSnapshot(marketRaw, candleDivisor), mid: scaledCandle }
      : { mid: scaledCandle, marketStatus: 'CLOSED', bid: null, offer: null, spread: null };
    market.warningNote = 'Using candle price — snapshot gap too wide';
    console.log(`[ig] FALLBACK: ${epic} candle price ${scaledCandle.toFixed(2)} (plausible AUD range ✓)`);
    checkContractExpiry(marketRaw);
    return {
      epic,
      candleDivisor,
      snapshotDivisor: candleDivisor,
      h1Candles: rescaleCandles(h1Raw, candleDivisor),
      h4Candles: rescaleCandles(h4Raw, candleDivisor),
      market,
    };
  }

  // Last resort: smaller candle window, ignore snapshot entirely
  const lastResort = await resolveGoldEpicLastResort(session);
  if (lastResort) return lastResort;

  console.error('[ig] ALL gold epics failed including last resort');
  return null;
}

// Same cross-validation for EUR/USD with FX plausibility band 0.5–5.0 and tighter 5% gap.
async function resolveEurUsdEpic(session) {
  for (const epic of EURUSD_EPICS) {
    try {
      const [h1Raw, marketRaw] = await Promise.all([
        fetchIGCandlesCached(epic, 'HOUR', 50, session).catch(() => null),
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

// Cache-aware candle fetcher. On cold start (cache < 10 candles) fetches full history once.
// On hot runs fetches only 2 candles and merges into cache — 99% fewer API calls per week.
// On quota hit during hot run, returns existing cache rather than failing the pipeline.
export async function fetchIGCandlesCached(epic, resolution, maxCount = 200, session) {
  const cacheReady = isCacheReady(epic, resolution);

  if (!cacheReady) {
    console.log(`[ig] COLD START ${epic} ${resolution} — fetching ${maxCount} candles`);
    try {
      const candles = await fetchIGCandles(session, epic, resolution, maxCount);
      saveCache(epic, resolution, candles);
      console.log(`[ig] cold start complete: ${candles.length} candles cached`);
      return candles;
    } catch (err) {
      console.error(`[ig] cold start failed: ${err.message}`);
      const stale = loadCache(epic, resolution);
      if (stale?.length > 0) {
        console.warn(`[ig] using stale cache (${stale.length} candles)`);
        return stale;
      }
      throw err;
    }
  }

  console.log(`[ig] HOT RUN ${epic} ${resolution} — fetching 2 candles to update cache`);
  try {
    const latest = await fetchIGCandles(session, epic, resolution, 2);
    const updated = appendToCache(epic, resolution, latest);
    console.log(`[ig] cache updated: ${updated.length} total candles`);
    return updated;
  } catch (err) {
    const isQuota = err.message.toLowerCase().includes('quota') ||
                    err.message.toLowerCase().includes('allowance') ||
                    err.message.includes('429');

    if (isQuota) {
      console.warn(`[ig] QUOTA HIT during hot run — returning cached data`);
      const cached = loadCache(epic, resolution);
      if (cached?.length > 0) {
        console.log(`[ig] using ${cached.length} cached candles (quota safe)`);
        return cached;
      }
    }

    console.warn(`[ig] hot run failed: ${err.message} — returning cache`);
    const cached = loadCache(epic, resolution);
    if (cached?.length > 0) return cached;
    throw err;
  }
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

    if (gold.snapshotOnly) {
      console.warn('[ig] SNAPSHOT-ONLY mode — no candles available (quota exhausted). Returning price only.');
    } else if (gold.h1Candles.length < 50) {
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
      snapshotOnly: gold.snapshotOnly ?? false,
    };
  } catch (err) {
    console.error(`[ig] data fetch failed after login: ${err.message} — returning empty IG data`);
    return emptyIGData(err.message);
  }
}
