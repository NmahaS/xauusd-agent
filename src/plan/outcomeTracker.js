import fs from 'node:fs/promises';
import path from 'node:path';
import { updateTradeOutcome } from '../memory/tradeDB.js';

const PLANS_DIR = path.resolve('plans');
const EXPIRY_HOURS = 24;

function r(v, d = 2) {
  return Math.round(v * 10 ** d) / 10 ** d;
}

// "2026-04-19 08:00:00" or ISO string → Date (UTC)
function toDate(timeStr) {
  if (!timeStr) return null;
  if (timeStr.includes('T')) return new Date(timeStr);
  return new Date(timeStr.replace(' ', 'T') + 'Z');
}

async function loadOpenTradePlans() {
  const now = new Date();
  const dates = [
    new Date(now - 86_400_000).toISOString().slice(0, 10),
    now.toISOString().slice(0, 10),
  ];

  const result = [];
  for (const date of dates) {
    const dir = path.join(PLANS_DIR, date);
    try {
      const files = (await fs.readdir(dir)).filter(f => /^\d{2}\.json$/.test(f));
      for (const file of files) {
        try {
          const raw = await fs.readFile(path.join(dir, file), 'utf8');
          const plan = JSON.parse(raw);
          if (!plan.direction) continue;
          const st = plan.outcome?.status;
          if (st && st !== 'open') continue; // already resolved
          result.push({ plan, filePath: path.join(dir, file) });
        } catch {}
      }
    } catch {}
  }
  return result;
}

function resolveOutcome(plan, h1Candles) {
  const planTime = new Date(plan.timestamp);
  const now = new Date();
  const hoursElapsed = (now - planTime) / 3_600_000;

  // Candles strictly after plan timestamp
  const after = h1Candles.filter(c => toDate(c.time) > planTime);

  if (after.length === 0) {
    if (hoursElapsed > EXPIRY_HOURS) {
      return {
        status: 'expired',
        resolvedAt: now.toISOString(),
        resolvedCandle: null,
        exitPrice: null,
        tp1Hit: false, tp2Hit: false, tp3Hit: false, slHit: false,
        actualRR: 0, pnlPips: 0, holdingHours: Math.round(hoursElapsed),
        maxFavorableExcursion: 0, maxAdverseExcursion: 0,
      };
    }
    return null; // still open, no candle data yet
  }

  const isLong = plan.direction === 'long';
  const entry = plan.entry?.price;
  const slPrice = plan.stopLoss?.price;
  const tps = (plan.takeProfits ?? []).map(t => t.price);
  const tpRRs = (plan.takeProfits ?? []).map(t => t.rr);

  if (entry == null || slPrice == null) return null;

  const slDist = Math.abs(entry - slPrice);

  let tp1Hit = false, tp2Hit = false, tp3Hit = false, slHit = false;
  let resolvedCandle = null;
  let mfe = 0, mae = 0;

  for (const c of after) {
    // MFE/MAE (from entry, in trade direction)
    if (isLong) {
      mfe = Math.max(mfe, c.high - entry);
      mae = Math.max(mae, entry - c.low);
    } else {
      mfe = Math.max(mfe, entry - c.low);
      mae = Math.max(mae, c.high - entry);
    }

    // SL checked FIRST — same-candle TP hit does not override SL
    const slTriggered = isLong ? c.low <= slPrice : c.high >= slPrice;
    if (slTriggered) {
      slHit = true;
      resolvedCandle = c.time;
      break;
    }

    // TP checks in order (each requires the previous)
    if (tps[0] != null && !tp1Hit) {
      if (isLong ? c.high >= tps[0] : c.low <= tps[0]) tp1Hit = true;
    }
    if (tp1Hit && tps[1] != null && !tp2Hit) {
      if (isLong ? c.high >= tps[1] : c.low <= tps[1]) tp2Hit = true;
    }
    if (tp2Hit && tps[2] != null && !tp3Hit) {
      if (isLong ? c.high >= tps[2] : c.low <= tps[2]) {
        tp3Hit = true;
        resolvedCandle = c.time;
        break;
      }
    }
  }

  // Determine status and exit
  let status, exitPrice, actualRR;

  if (slHit) {
    if (tp1Hit) {
      // TP1 was hit on a prior candle; SL hit later → partial win
      status = 'partial_win';
      exitPrice = r(tps[0]);
      actualRR = r(tpRRs[0] ?? (Math.abs(tps[0] - entry) / slDist));
    } else {
      status = 'loss';
      exitPrice = r(slPrice);
      actualRR = -1.0;
    }
  } else if (tp3Hit) {
    status = 'win';
    exitPrice = r(tps[2]);
    actualRR = r(tpRRs[2] ?? (Math.abs(tps[2] - entry) / slDist));
  } else if (tp2Hit) {
    status = 'win';
    exitPrice = r(tps[1]);
    actualRR = r(tpRRs[1] ?? (Math.abs(tps[1] - entry) / slDist));
  } else if (tp1Hit) {
    status = 'win';
    exitPrice = r(tps[0]);
    actualRR = r(tpRRs[0] ?? (Math.abs(tps[0] - entry) / slDist));
  } else if (hoursElapsed > EXPIRY_HOURS) {
    status = 'expired';
    exitPrice = null;
    actualRR = 0;
  } else {
    return null; // still open
  }

  const resolvedTime = resolvedCandle
    ? toDate(resolvedCandle).toISOString()
    : now.toISOString();

  const pnlPips = exitPrice != null
    ? r(isLong ? exitPrice - entry : entry - exitPrice)
    : 0;

  const holdingHours = resolvedCandle
    ? Math.round((toDate(resolvedCandle) - planTime) / 3_600_000)
    : Math.round(hoursElapsed);

  return {
    status,
    resolvedAt: resolvedTime,
    resolvedCandle: resolvedCandle ?? null,
    exitPrice,
    tp1Hit,
    tp2Hit,
    tp3Hit,
    slHit,
    actualRR,
    pnlPips,
    holdingHours,
    maxFavorableExcursion: r(mfe),
    maxAdverseExcursion: r(mae),
  };
}

export async function resolveOpenTrades(h1Candles) {
  const openTrades = await loadOpenTradePlans();
  if (openTrades.length === 0) {
    console.log('[outcome] 0 open trades to check');
    return 0;
  }

  console.log(`[outcome] checking ${openTrades.length} open trade(s)`);
  let resolved = 0;

  for (const { plan, filePath } of openTrades) {
    if (!plan.execution?.executed) {
      const label = `${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`;
      console.log(`[outcome] skipping ${label} — not executed on exchange`);
      continue;
    }
    const outcome = resolveOutcome(plan, h1Candles);
    if (!outcome) continue;

    await fs.writeFile(filePath, JSON.stringify({ ...plan, outcome }, null, 2), 'utf8');
    const label = `${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`;
    console.log(`[outcome] ${label}: ${outcome.status} actualRR=${outcome.actualRR}`);

    // RAG: mirror outcome to trade memory DB (additive)
    try {
      const orderId = plan.execution?.orderId;
      if (orderId) {
        const mapped =
          outcome.status === 'win' ? 'WIN' :
          outcome.status === 'partial_win' ? 'WIN' :
          outcome.status === 'loss' ? 'LOSS' :
          outcome.status === 'expired' ? 'BREAKEVEN' : null;
        if (mapped) {
          const entry = plan.entry?.price ?? null;
          const exitPx = outcome.exitPrice;
          const size = plan.execution?.size ?? 0;
          const pnl = (entry != null && exitPx != null && size)
            ? (plan.direction === 'long' ? (exitPx - entry) : (entry - exitPx)) * size
            : null;
          updateTradeOutcome(String(orderId), {
            outcome: mapped,
            closeTime: outcome.resolvedAt ?? new Date().toISOString(),
            exitPrice: exitPx,
            rr: outcome.actualRR ?? null,
            pnl,
            fees: null,
            netPnl: pnl,
          });
        }
      }
    } catch (err) {
      console.warn('[outcome] RAG update failed:', err.message);
    }

    resolved++;
  }

  console.log(`[outcome] resolved ${resolved}/${openTrades.length}`);
  return resolved;
}

export async function resolveBlockedSignals(hlData) {
  try {
    const { getDB } = await import('../memory/tradeDB.js');
    const db = getDB();

    const blocked = db.prepare(`
      SELECT * FROM trades
      WHERE isExecuted = 0
        AND outcome = 'BLOCKED'
        AND wouldHaveOutcome IS NULL
        AND openTime > datetime('now', '-4 hours')
        AND direction IS NOT NULL
        AND entryPrice IS NOT NULL
    `).all();

    console.log(`[rag] resolving ${blocked.length} blocked signals`);
    if (blocked.length === 0) return;

    const m15Candles = hlData?.m15Candles || [];

    for (const signal of blocked) {
      const signalTime = new Date(signal.openTime).getTime();
      const minutesSince = (Date.now() - signalTime) / 60000;

      if (minutesSince < 60) continue; // need at least 1h of data

      const candlesAfter = m15Candles.filter(c =>
        new Date(c.time).getTime() > signalTime
      );
      if (candlesAfter.length === 0) continue;

      const priceAfter15m = candlesAfter[0]?.close ?? null;
      const priceAfter1h  = candlesAfter[3]?.close ?? null;
      const priceAfter4h  = candlesAfter[15]?.close ?? null;

      const atr = signal.atr || 8;
      const slDist = signal.slDistance || atr;
      const tpDist = slDist * 2;
      const entry = signal.entryPrice;
      const dir = signal.direction;

      const slPrice = dir === 'long' ? entry - slDist : entry + slDist;
      const tpPrice = dir === 'long' ? entry + tpDist : entry - tpDist;

      let wouldHaveOutcome = 'UNKNOWN';
      let wouldHaveRR = 0;

      for (const candle of candlesAfter.slice(0, 16)) {
        if (dir === 'long') {
          if (candle.low <= slPrice)  { wouldHaveOutcome = 'LOSS'; wouldHaveRR = -1; break; }
          if (candle.high >= tpPrice) { wouldHaveOutcome = 'WIN';  wouldHaveRR = 2;  break; }
        } else {
          if (candle.high >= slPrice) { wouldHaveOutcome = 'LOSS'; wouldHaveRR = -1; break; }
          if (candle.low <= tpPrice)  { wouldHaveOutcome = 'WIN';  wouldHaveRR = 2;  break; }
        }
      }

      db.prepare(`
        UPDATE trades SET
          wouldHaveOutcome = ?,
          wouldHaveRR = ?,
          priceAfter15m = ?,
          priceAfter1h = ?,
          priceAfter4h = ?,
          updatedAt = datetime('now')
        WHERE id = ?
      `).run(wouldHaveOutcome, wouldHaveRR, priceAfter15m, priceAfter1h, priceAfter4h, signal.id);

      console.log(`[rag] resolved blocked signal ${signal.id}:`,
        dir, 'entry:', entry, 'wouldHave:', wouldHaveOutcome,
        'blockReason:', signal.blockReason
      );
    }
  } catch (err) {
    console.warn('[rag] resolveBlockedSignals failed:', err.message);
  }
}
