import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('backtest/data');
const H1_FILE = path.join(DATA_DIR, 'paxg_h1_raw.json');
const H4_FILE = path.join(DATA_DIR, 'paxg_h4_raw.json');

const COIN = process.env.HL_COIN || 'PAXG';
const HL_BASE = 'https://api.hyperliquid.xyz';

// Hyperliquid paginates candles — fetch in 200-bar chunks.
async function fetchHLCandlesWithPagination(coin, interval, startTime, endTime) {
  const allCandles = [];
  const chunkMs = {
    '1h':  200 * 1  * 60 * 60 * 1000,   // 200 hours per request
    '4h':  200 * 4  * 60 * 60 * 1000,   // 800 hours per request
  }[interval] ?? 200 * 60 * 60 * 1000;

  let currentStart = startTime;
  let chunkNum = 0;

  while (currentStart < endTime) {
    const currentEnd = Math.min(currentStart + chunkMs, endTime);
    chunkNum++;

    try {
      const res = await fetch(`${HL_BASE}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval, startTime: currentStart, endTime: currentEnd },
        }),
      });

      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const candles = data.map(c => ({
          time:   new Date(c.t).toISOString(),
          open:   parseFloat(c.o),
          high:   parseFloat(c.h),
          low:    parseFloat(c.l),
          close:  parseFloat(c.c),
          volume: parseFloat(c.v),
        }));
        allCandles.push(...candles);
        console.log(`[backtest] chunk ${chunkNum}: +${candles.length} ${interval} candles up to ${new Date(currentEnd).toISOString().slice(0, 10)}`);
      } else {
        console.log(`[backtest] chunk ${chunkNum}: 0 ${interval} candles — reached end of history`);
      }

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.warn(`[backtest] chunk ${chunkNum} ${interval} failed: ${err.message}`);
    }

    currentStart = currentEnd;
  }

  // Deduplicate by timestamp and sort chronologically.
  const unique = [...new Map(allCandles.map(c => [c.time, c])).values()]
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  return unique;
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
      console.log(`[backtest] cache hit — H1=${h1.candles.length} H4=${h4.candles.length} coin=${h1.coin ?? COIN}`);
      return { h1: h1.candles, h4: h4.candles, epic: h1.coin ?? COIN, cached: true };
    }
  }

  const endTime = Date.now();
  const startTime = endTime - (365 * 24 * 60 * 60 * 1000); // 1 year back

  console.log('[backtest] fetching PAXG historical data from Hyperliquid...');
  console.log(`[backtest] period: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}`);

  const [h1Candles, h4Candles] = await Promise.all([
    fetchHLCandlesWithPagination(COIN, '1h', startTime, endTime),
    fetchHLCandlesWithPagination(COIN, '4h', startTime, endTime),
  ]);

  console.log(`[backtest] H1: ${h1Candles.length} candles`);
  console.log(`[backtest] H4: ${h4Candles.length} candles`);
  if (h1Candles.length > 0) {
    console.log(`[backtest] period: ${h1Candles[0].time} → ${h1Candles[h1Candles.length - 1].time}`);
  }

  const meta = { coin: COIN, fetchedAt: new Date().toISOString(), source: 'hyperliquid' };
  await fs.writeFile(H1_FILE, JSON.stringify({ ...meta, candles: h1Candles }, null, 2));
  await fs.writeFile(H4_FILE, JSON.stringify({ ...meta, candles: h4Candles }, null, 2));
  console.log(`[backtest] saved to ${H1_FILE} and ${H4_FILE}`);

  return { h1: h1Candles, h4: h4Candles, epic: COIN, cached: false };
}
