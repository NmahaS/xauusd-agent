// M15 entry refinement. The H4/H1 LLM signal gives a POI zone (M15 OB or FVG) — this
// module checks whether price has entered that zone and an M15 CHoCH or engulfing has fired.
// Callers must supply already-fetched m15Candles; no API calls inside this module.
import { detectSwings } from '../smc/swings.js';
import { analyzeStructure } from '../smc/structure.js';

const PROXIMITY_PTS = 3;          // "in zone" tolerance in price units (tighter for M15)
const ATR_PERIOD = 14;
const SL_ATR_MULT = 0.2;          // SL = M15 OB extreme ± 0.2 × M15 ATR

function computeATR(candles, period = ATR_PERIOD) {
  if (!Array.isArray(candles) || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  const slice = trs.slice(-period);
  return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : 0;
}

function inZone(price, zone, padPts = PROXIMITY_PTS) {
  if (!Array.isArray(zone) || zone.length !== 2) return false;
  const [a, b] = zone;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return price >= lo - padPts && price <= hi + padPts;
}

function isBullishEngulfing(prev, curr, zoneLow, zoneHigh) {
  if (!prev || !curr) return false;
  const insideZone = curr.close >= zoneLow - PROXIMITY_PTS && curr.close <= zoneHigh + PROXIMITY_PTS;
  return insideZone && curr.close > prev.high && curr.open < prev.low;
}

function isBearishEngulfing(prev, curr, zoneLow, zoneHigh) {
  if (!prev || !curr) return false;
  const insideZone = curr.close >= zoneLow - PROXIMITY_PTS && curr.close <= zoneHigh + PROXIMITY_PTS;
  return insideZone && curr.close < prev.low && curr.open > prev.high;
}

function findM15Confirmation(direction, m15Candles, zoneLow, zoneHigh) {
  if (!m15Candles || m15Candles.length < 5) {
    return { confirmed: false, reason: 'M15 history too short', kind: null };
  }

  const last = m15Candles[m15Candles.length - 1];
  const prev = m15Candles[m15Candles.length - 2];

  // Engulfing inside the POI
  if (direction === 'long' && isBullishEngulfing(prev, last, zoneLow, zoneHigh)) {
    return { confirmed: true, kind: 'bullish-engulfing', candle: last };
  }
  if (direction === 'short' && isBearishEngulfing(prev, last, zoneLow, zoneHigh)) {
    return { confirmed: true, kind: 'bearish-engulfing', candle: last };
  }

  // CHoCH inside the POI: re-run structure on M15 with n=3
  const struct = analyzeStructure(m15Candles, 3);
  if (struct?.lastEvent && struct?.eventCandle) {
    const evtPrice = struct.eventCandle.price;
    const inZoneAtEvent = evtPrice >= zoneLow - PROXIMITY_PTS && evtPrice <= zoneHigh + PROXIMITY_PTS;
    if (direction === 'long' && struct.lastEvent === 'CHoCH-bullish' && inZoneAtEvent) {
      return { confirmed: true, kind: 'CHoCH-bullish', candle: struct.eventCandle };
    }
    if (direction === 'short' && struct.lastEvent === 'CHoCH-bearish' && inZoneAtEvent) {
      return { confirmed: true, kind: 'CHoCH-bearish', candle: struct.eventCandle };
    }
  }

  return { confirmed: false, reason: 'No M15 trigger inside POI yet', kind: null };
}

function recomputePlanWithRefinedEntry(plan, refinedEntry, refinedSL, kind) {
  const slDist = Math.abs(refinedEntry - refinedSL);
  if (slDist <= 0) return null;

  const tps = (plan.takeProfits || []).map(tp => ({
    ...tp,
    rr: parseFloat((Math.abs(tp.price - refinedEntry) / slDist).toFixed(2)),
  }));

  return {
    ...plan,
    entry: {
      ...plan.entry,
      price: parseFloat(refinedEntry.toFixed(2)),
      trigger: 'marketOnConfirmation',
      confirmation: `M15 ${kind} inside POI`,
    },
    stopLoss: {
      ...plan.stopLoss,
      price: parseFloat(refinedSL.toFixed(2)),
      pips: parseFloat(slDist.toFixed(2)),
      reasoning: `${plan.stopLoss?.reasoning || 'M15 POI extreme'} + 0.2 × M15 ATR buffer`,
    },
    takeProfits: tps,
  };
}

// m15Candles must be pre-fetched by the caller. currentPrice is the latest bid/close.
export function refineEntry(plan, m15Candles, currentPrice) {
  if (!plan?.direction || !plan?.poi?.zone) {
    return { refined: false, status: 'N/A', reason: 'missing direction/POI', plan };
  }

  if (!Array.isArray(m15Candles) || m15Candles.length === 0) {
    return { refined: false, status: 'N/A', reason: 'no M15 candles supplied', plan };
  }

  const price = currentPrice ?? m15Candles[m15Candles.length - 1]?.close;
  if (price == null) {
    return { refined: false, status: 'N/A', reason: 'no current price', plan };
  }

  const [zLo, zHi] = [
    Math.min(plan.poi.zone[0], plan.poi.zone[1]),
    Math.max(plan.poi.zone[0], plan.poi.zone[1]),
  ];

  // Phase 1: is price at the M15 POI?
  if (!inZone(price, [zLo, zHi])) {
    return {
      refined: false,
      status: 'WAITING',
      reason: `Price ${price.toFixed(2)} not at M15 POI [${zLo.toFixed(2)}-${zHi.toFixed(2)}] yet`,
      plan,
    };
  }

  // Phase 2: M15 confirmation signal
  const conf = findM15Confirmation(plan.direction, m15Candles, zLo, zHi);
  if (!conf.confirmed) {
    return {
      refined: false,
      status: 'PENDING',
      reason: conf.reason,
      plan,
    };
  }

  // Phase 3: tighten entry/SL using M15 ATR
  const m15Atr = computeATR(m15Candles, ATR_PERIOD);
  const refinedEntry = conf.candle.close ?? price;
  const refinedSL = plan.direction === 'long'
    ? zLo - SL_ATR_MULT * m15Atr
    : zHi + SL_ATR_MULT * m15Atr;

  const refinedPlan = recomputePlanWithRefinedEntry(plan, refinedEntry, refinedSL, conf.kind);
  if (!refinedPlan) {
    return { refined: false, status: 'PENDING', reason: 'invalid refined SL distance', plan };
  }

  return {
    refined: true,
    status: 'CONFIRMED',
    reason: `${conf.kind} on M15 inside POI`,
    plan: refinedPlan,
  };
}
