// Single source of truth for weekly REALIZED P&L.
// Used by the Telegram weekly-goal tracker (weeklyGoal.js), the Monday
// auto-transfer, and the dashboard (/api/dashboard) so they never drift apart.
//
// Method (matches Hyperliquid's own "realized PnL"):
//   net = sum(closedPnl) - sum(fee)
// closedPnl is 0 on opening fills and only nonzero on closes, so summing it
// across the window's fills = realized P&L. Do NOT filter by isClose, and do
// NOT add unrealized P&L of an open runner — the weekly goal is realized only.

import { getHLAllFills } from '../broker/hyperliquid.js';

// Monday 00:00 UTC of the week containing `now`.
export function weekStartUTC(now = new Date()) {
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysFromMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart;
}

// Pure: realized P&L for fills whose time ∈ [startMs, endMs).
// endMs defaults to Infinity (i.e. "up to now"). This is the one place the
// gross/fees/win/loss math lives — every weekly figure derives from it.
export function computePnlForRange(fills, startMs, endMs = Infinity) {
  const windowFills = (fills || []).filter(f => {
    const t = new Date(f.time).getTime();
    return t >= startMs && t < endMs;
  });

  // closedPnl is 0 on opens, only nonzero on closes — sum all of them.
  const gross = windowFills.reduce((s, f) => s + (f.closedPnl || 0), 0);
  const fees  = windowFills.reduce((s, f) => s + (f.fee || 0), 0);
  const net   = gross - fees;

  // Count actual closing trades for win/loss stats.
  const closes = windowFills.filter(f => Math.abs(f.closedPnl || 0) > 0.001);
  const wins   = closes.filter(f => f.closedPnl > 0).length;
  const losses = closes.filter(f => f.closedPnl < 0).length;

  return {
    net:    parseFloat(net.toFixed(2)),
    gross:  parseFloat(gross.toFixed(2)),
    fees:   parseFloat(fees.toFixed(2)),
    wins,
    losses,
    trades: closes.length,
  };
}

// CURRENT week: Monday 00:00 UTC → now. Lets the dashboard reuse its existing
// `fills` (no second API call) while sharing the exact math.
export function computeWeeklyPnl(fills, now = new Date()) {
  const weekStart = weekStartUTC(now);
  return {
    ...computePnlForRange(fills, weekStart.getTime()),
    weekStart: weekStart.toISOString().slice(0, 10),
  };
}

// PREVIOUS week: last Monday 00:00 UTC → this Monday 00:00 UTC (exclusive).
export function computePreviousWeekPnl(fills, now = new Date()) {
  const thisMonday = weekStartUTC(now);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  return {
    ...computePnlForRange(fills, lastMonday.getTime(), thisMonday.getTime()),
    weekStart: lastMonday.toISOString().slice(0, 10),
    weekEnd:   thisMonday.toISOString().slice(0, 10),
    weekRange: lastMonday.toISOString().slice(0, 10) + ' → ' +
               thisMonday.toISOString().slice(0, 10),
  };
}

export async function getWeeklyPnl(coin = process.env.HL_COIN || 'PAXG') {
  const fills = await getHLAllFills(coin);
  return computeWeeklyPnl(fills);
}

export async function getPreviousWeekPnl(coin = process.env.HL_COIN || 'PAXG') {
  const fills = await getHLAllFills(coin);
  return computePreviousWeekPnl(fills);
}
