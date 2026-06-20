// Rebuild the RAG trade DB from real Hyperliquid fills.
//
// Use when the RAG history was lost (e.g. a Railway deploy before the /data
// volume existed). Only OUTCOME + P&L are recoverable from fills — the SMC
// context recorded at signal time (session, tier, confluence, ATR, biases) is
// NOT in the fill data, so those columns stay null. Rebuilt rows are therefore
// good for stats/history (getStats, /memory, /performance) but weak for
// similarity matching.
//
// Idempotent: rows live in a dedicated `rebuilt_<orderId>` id namespace and use
// INSERT OR REPLACE, so re-running refreshes them without duplicating and without
// touching real pipeline-recorded rows.

import { getHLAllFills } from '../broker/hyperliquid.js';
import { saveTrade } from './tradeDB.js';

export async function rebuildRAGFromFills(coin = process.env.HL_COIN || 'PAXG') {
  // getHLAllFills returns MAPPED fills: { orderId, direction, price, size, fee, time, closedPnl, ... }
  const fills = await getHLAllFills(coin);

  // A close fill carries the realized P&L. Group partial fills of the same
  // closing order into one logical trade (mirrors the dashboard's grouping).
  const closes = fills.filter(f => Math.abs(f.closedPnl || 0) > 0.001);
  const groups = new Map();
  for (const f of closes) {
    const key = String(f.orderId);
    let g = groups.get(key);
    if (!g) {
      g = { orderId: f.orderId, time: f.time, direction: f.direction, size: 0, notional: 0, pnl: 0, fee: 0 };
      groups.set(key, g);
    }
    const size = parseFloat(f.size) || 0;
    g.size     += size;
    g.notional += size * (parseFloat(f.price) || 0);
    g.pnl      += parseFloat(f.closedPnl) || 0;
    g.fee      += parseFloat(f.fee) || 0;
    if (new Date(f.time) < new Date(g.time)) g.time = f.time; // earliest fill of the close
  }

  let imported = 0;
  for (const g of groups.values()) {
    const exitPrice = g.size > 0 ? parseFloat((g.notional / g.size).toFixed(2)) : null;
    // Derive entry from realized P&L: long pnl=(exit-entry)*size, short pnl=(entry-exit)*size.
    let entryPrice = null;
    if (g.size > 0 && exitPrice != null) {
      const raw = g.direction === 'long'
        ? exitPrice - g.pnl / g.size
        : exitPrice + g.pnl / g.size;
      entryPrice = parseFloat(raw.toFixed(2));
    }
    const outcome = g.pnl > 0 ? 'WIN' : (g.pnl < 0 ? 'LOSS' : 'BREAKEVEN');

    try {
      saveTrade({
        orderId: `rebuilt_${g.orderId}`,
        openTime: g.time,        // real open time unknown — use the close fill time
        closeTime: g.time,
        session: null,
        inKillZone: null,
        direction: g.direction,
        entryPrice,
        exitPrice,
        h4Bias: null, h1Bias: null, m15Bias: null, m15Event: null,
        tier: null, confluence: null, quality: null, consensus: null,
        atr: null, slDistance: null, riskPct: null,
        outcome,
        rr: null,
        pnl: parseFloat(g.pnl.toFixed(4)),
        fees: parseFloat(g.fee.toFixed(4)),
        netPnl: parseFloat((g.pnl - g.fee).toFixed(4)),
        isExecuted: 1,
        blockReason: null,
        wouldHaveOutcome: null,
        wouldHaveRR: null,
        priceAtSignal: null,
        priceAfter15m: null,
        priceAfter1h: null,
        priceAfter4h: null,
      });
      imported++;
    } catch (e) {
      console.warn('[rag] skip order', g.orderId, '-', e.message);
    }
  }

  console.log('[rag] rebuilt', imported, 'trades from', closes.length, 'close fills');
  return imported;
}
