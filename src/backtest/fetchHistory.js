import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const BASE_URL = config.IG_DEMO === false || config.IG_DEMO === 'false'
  ? 'https://api.ig.com/gateway/deal'
  : 'https://demo-api.ig.com/gateway/deal';

const DATA_DIR = path.resolve('backtest/data');
const H1_FILE = path.join(DATA_DIR, 'xauaud_h1_raw.json');
const H4_FILE = path.join(DATA_DIR, 'xauaud_h4_raw.json');

// Same logic as src/data/ig.js — kept inline so this script is self-contained.
function parseSnapshotTime(s) {
  const m = String(s || '').match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?::(\d{3}))?$/);
  if (!m) return new Date(s).toISOString();
  const [, y, mo, d, h, mi, se, ms = '000'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}.${ms}Z`;
}
function mid(b, a) { return b == null || a == null ? null : (Number(b) + Number(a)) / 2; }
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
function findWorkingDivisor(rawPrice, assetType) {
  if (rawPrice == null || !Number.isFinite(rawPrice)) return null;
  for (const d of [1, 10, 100, 1000, 10000]) {
    const s = rawPrice / d;
    if (assetType === 'GOLD' && s >= 2000 && s <= 15000) return d;
  }
  return null;
}
function rescaleCandles(rows, divisor) {
  if (!divisor || divisor === 1) return rows;
  return rows.map(c => ({
    ...c,
    open: c.open == null ? null : c.open / divisor,
    high: c.high == null ? null : c.high / divisor,
    low: c.low == null ? null : c.low / divisor,
    close: c.close == null ? null : c.close / divisor,
  }));
}

async function igLogin() {
  const res = await fetch(`${BASE_URL}/session`, {
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
  const cst = res.headers.get('cst');
  const xst = res.headers.get('x-security-token');
  if (!cst || !xst) throw new Error('IG login: missing CST / X-SECURITY-TOKEN');
  return { cst, xst };
}

async function igGet(path, session, version) {
  const res = await fetch(`${BASE_URL}${path}`, {
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

// IG's date param wants "yyyy-MM-dd'T'HH:mm:ss" without millis or 'Z'. Strip the rest of the ISO.
function igDateFmt(d) {
  return d.toISOString().slice(0, 19);
}

async function fetchDateRange(session, epic, resolution, fromDate, toDate) {
  const path = `/prices/${epic}?resolution=${resolution}` +
               `&from=${encodeURIComponent(igDateFmt(fromDate))}` +
               `&to=${encodeURIComponent(igDateFmt(toDate))}` +
               `&pageSize=0`;
  const json = await igGet(path, session, 3);
  const prices = Array.isArray(json.prices) ? json.prices.map(igPriceToCandle).filter(c => c.close != null) : [];
  const allowance = json.metadata?.allowance ?? null;
  return { prices, allowance };
}

// Walk backward in 30-day chunks. Stop when a chunk returns 0 candles (no more history)
// or when we've fetched `targetCandles` rows (whichever first). Total cost is roughly
// chunks × candles_per_chunk against IG's weekly allowance — caller should monitor.
async function fetchHistoricalRange(session, epic, resolution, label, {
  chunkDays = 30,
  maxChunks = 12,
  targetCandles = Infinity,
} = {}) {
  const seen = new Map();
  const now = new Date();
  let chunkEnd = now;

  for (let i = 0; i < maxChunks; i++) {
    const chunkStart = new Date(chunkEnd.getTime() - chunkDays * 24 * 3600 * 1000);
    let res;
    try {
      res = await fetchDateRange(session, epic, resolution, chunkStart, chunkEnd);
    } catch (err) {
      console.warn(`[backtest] ${label} chunk ${i + 1} (${igDateFmt(chunkStart)} → ${igDateFmt(chunkEnd)}) failed: ${err.message} — stopping`);
      break;
    }
    if (res.allowance) {
      console.log(`[backtest] IG allowance: ${res.allowance.remainingAllowance ?? '?'}/${res.allowance.totalAllowance ?? '?'}`);
    }
    let added = 0;
    for (const c of res.prices) {
      if (!seen.has(c.time)) { seen.set(c.time, c); added++; }
    }
    console.log(`[backtest] ${label} chunk ${i + 1} ${igDateFmt(chunkStart)} → ${igDateFmt(chunkEnd)}: +${added} new (got ${res.prices.length}, total unique ${seen.size})`);
    if (res.prices.length === 0) {
      console.log(`[backtest] ${label} chunk ${i + 1} returned 0 — no more history available`);
      break;
    }
    if (seen.size >= targetCandles) break;
    chunkEnd = chunkStart;
  }

  return Array.from(seen.values()).sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function resolveGoldEpic(session) {
  // Hard-coded preference: AUD futures from the discovery results we already validated.
  const candidates = [
    'MT.D.GC.FWS2.IP',          // Gold ($100) — AUD-100 futures
    'MT.D.GC.FWM2.IP',          // Gold ($33.20)
    'CS.D.CFAGOLD.CAF.IP',      // Spot Gold (A$10)
    'CS.D.CFAGOLD.CFA.IP',      // Spot Gold (A$1)
  ];
  for (const epic of candidates) {
    try {
      await igGet(`/markets/${epic}`, session, 3);
      console.log(`[backtest] using gold epic: ${epic}`);
      return epic;
    } catch {
      console.log(`[backtest] gold epic ${epic} not available, trying next`);
    }
  }
  throw new Error('No usable gold epic found');
}

function deriveDivisorFromCandles(candles, assetType) {
  if (!candles.length) return 1;
  const sample = candles[Math.floor(candles.length / 2)].close;
  return findWorkingDivisor(sample, assetType) ?? 1;
}

async function maybeReadCache(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.candles) && parsed.candles.length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function fetchHistory({ force = false } = {}) {
  await fs.mkdir(DATA_DIR, { recursive: true });

  if (!force) {
    const h1 = await maybeReadCache(H1_FILE);
    const h4 = await maybeReadCache(H4_FILE);
    if (h1 && h4) {
      console.log(`[backtest] cache hit — H1=${h1.candles.length} H4=${h4.candles.length} epic=${h1.epic}`);
      return { h1: h1.candles, h4: h4.candles, epic: h1.epic, cached: true };
    }
  }

  const session = await igLogin();
  console.log('[backtest] IG login ok');

  const epic = await resolveGoldEpic(session);

  console.log(`[backtest] fetching H1 candles via 30-day date-range chunks (max 12 chunks ≈ 1y)…`);
  const h1Raw = await fetchHistoricalRange(session, epic, 'HOUR', 'H1', { chunkDays: 30, maxChunks: 12 });
  const h1Divisor = deriveDivisorFromCandles(h1Raw, 'GOLD');
  const h1Candles = rescaleCandles(h1Raw, h1Divisor);
  console.log(`[backtest] H1 divisor=${h1Divisor}, total=${h1Candles.length}`);

  console.log(`[backtest] fetching H4 candles via 90-day chunks (max 6 chunks ≈ 1.5y)…`);
  const h4Raw = await fetchHistoricalRange(session, epic, 'HOUR_4', 'H4', { chunkDays: 90, maxChunks: 6 });
  const h4Divisor = deriveDivisorFromCandles(h4Raw, 'GOLD');
  const h4Candles = rescaleCandles(h4Raw, h4Divisor);
  console.log(`[backtest] H4 divisor=${h4Divisor}, total=${h4Candles.length}`);

  if (h1Candles.length > 0) {
    const from = h1Candles[0].time;
    const to = h1Candles[h1Candles.length - 1].time;
    console.log(`[backtest] fetched H1=${h1Candles.length} candles from ${from} to ${to}`);
  }
  if (h4Candles.length > 0) {
    const from = h4Candles[0].time;
    const to = h4Candles[h4Candles.length - 1].time;
    console.log(`[backtest] fetched H4=${h4Candles.length} candles from ${from} to ${to}`);
  }

  await fs.writeFile(H1_FILE, JSON.stringify({ epic, divisor: h1Divisor, fetchedAt: new Date().toISOString(), candles: h1Candles }, null, 2));
  await fs.writeFile(H4_FILE, JSON.stringify({ epic, divisor: h4Divisor, fetchedAt: new Date().toISOString(), candles: h4Candles }, null, 2));
  console.log(`[backtest] cached to ${H1_FILE} and ${H4_FILE}`);

  return { h1: h1Candles, h4: h4Candles, epic, cached: false };
}
