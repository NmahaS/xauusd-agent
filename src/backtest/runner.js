import fs from 'node:fs/promises';
import path from 'node:path';

import { computeClassicalIndicators } from '../indicators/classical.js';
import { detectSession } from '../indicators/session.js';
import { analyzeStructure } from '../smc/structure.js';
import { detectFVGs } from '../smc/fvg.js';
import { detectOrderBlocks } from '../smc/orderBlocks.js';
import { detectLiquidity } from '../smc/liquidity.js';
import { computePremiumDiscount } from '../smc/premiumDiscount.js';
import { computeConfluence } from '../plan/confluence.js';

const RESULTS_DIR = path.resolve('backtest/results');
const SIGNALS_FILE = path.join(RESULTS_DIR, 'signals.json');

const WINDOW = 300;          // sliding window size — bounds compute per step
const WARMUP = 100;          // need at least this many candles before first signal
const FUTURE_BARS = 24;      // outcome lookahead
const ATR_SL_MULT = 0.5;     // SL = OB edge ± 0.5×ATR

function smcForTimeframe(candles, n) {
  return {
    structure: analyzeStructure(candles, n),
    fvgs: detectFVGs(candles),
    orderBlocks: detectOrderBlocks(candles, n),
    liquidity: detectLiquidity(candles, n),
    pd: computePremiumDiscount(candles, n),
  };
}

function alignH4UpTo(h4Candles, asOfTime) {
  // Include only H4 candles whose 4-hour bar has fully closed at asOfTime.
  const asOf = new Date(asOfTime).getTime();
  const out = [];
  for (const c of h4Candles) {
    const t = new Date(c.time).getTime();
    if (t + 4 * 3600 * 1000 <= asOf) out.push(c);
    else break;
  }
  return out;
}

function dayOfWeekUtc(timeStr) {
  return new Date(timeStr).toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'UTC' });
}

function nearestZoneOf(zones, currentPrice, type) {
  const filtered = (zones || []).filter(z => z.type === type);
  if (!filtered.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const z of filtered) {
    const lo = z.low ?? z.bottom;
    const hi = z.high ?? z.top;
    if (lo == null || hi == null) continue;
    const mid = (lo + hi) / 2;
    const d = Math.abs(currentPrice - mid);
    if (d < bestDist) { bestDist = d; best = { ...z, mid, low: lo, high: hi, distance: d }; }
  }
  return best;
}

// Build entry/SL/TPs deterministically from SMC outputs.
// Returns null if any required component is missing.
function buildPlan(direction, smcH1, smcH4, currentPrice, atr) {
  // Prefer OB; fall back to FVG
  let poiKind = 'order_block';
  let poi = nearestZoneOf(smcH1.orderBlocks, currentPrice, direction === 'long' ? 'bullish' : 'bearish');
  if (!poi) {
    const fvgs = (smcH1.fvgs || []).filter(f => !f.filled);
    poi = nearestZoneOf(fvgs, currentPrice, direction === 'long' ? 'bullish' : 'bearish');
    poiKind = 'fair_value_gap';
  }
  if (!poi) return null;

  const entry = (poi.low + poi.high) / 2;
  const slPad = ATR_SL_MULT * atr;
  const sl = direction === 'long' ? poi.low - slPad : poi.high + slPad;

  // TP1: nearest opposite-side liquidity pool
  const liq = smcH1.liquidity || {};
  const tp1Pool = direction === 'long'
    ? (liq.eqh || []).filter(p => p.level > entry).sort((a, b) => a.level - b.level)[0]
    : (liq.eql || []).filter(p => p.level < entry).sort((a, b) => b.level - a.level)[0];

  // TP2: equilibrium of H4 PD range (midpoint)
  const h4pd = smcH4.pd?.ok ? smcH4.pd : smcH1.pd?.ok ? smcH1.pd : null;
  const tp2Price = h4pd?.mid ?? null;

  // TP3: opposite swing extreme of H4 PD range
  const tp3Price = h4pd ? (direction === 'long' ? h4pd.high : h4pd.low) : null;

  const tps = [];
  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return null;

  function rrFor(price) {
    return Math.abs(price - entry) / slDist;
  }

  // For long, TPs must be > entry. For short, TPs must be < entry. Filter and require monotonicity.
  function tpValid(price) {
    if (price == null || !Number.isFinite(price)) return false;
    if (direction === 'long') return price > entry;
    return price < entry;
  }

  if (tp1Pool && tpValid(tp1Pool.level)) {
    tps.push({ level: 'TP1', price: tp1Pool.level, rr: rrFor(tp1Pool.level), reasoning: 'nearest liquidity pool' });
  }
  if (tpValid(tp2Price)) {
    tps.push({ level: 'TP2', price: tp2Price, rr: rrFor(tp2Price), reasoning: 'H4 range equilibrium' });
  }
  if (tpValid(tp3Price)) {
    tps.push({ level: 'TP3', price: tp3Price, rr: rrFor(tp3Price), reasoning: 'H4 opposite swing extreme' });
  }

  // Sort and dedupe TPs in trade direction
  tps.sort((a, b) => direction === 'long' ? a.price - b.price : b.price - a.price);

  if (tps.length === 0) return null;
  // Need at least the minimum RR on TP1 to count as a setup
  if (tps[0].rr < 1.5) return null;

  return {
    poi: { type: `${direction === 'long' ? 'bullish' : 'bearish'}_${poiKind}`, zone: [poi.low, poi.high] },
    entry,
    sl,
    slDist,
    tps,
  };
}

// Simulate outcome over the next 24 H1 candles.
// SL-first ordering: a same-candle SL+TP collision counts as LOSS (matches outcomeTracker.js).
function simulateOutcome(plan, direction, futureCandles) {
  const { entry, sl, tps } = plan;
  if (!tps.length) return { outcome: 'EXPIRED', actualRR: 0, holdingHours: 0 };

  const tp1 = tps[0]?.price ?? null;
  const tp2 = tps[1]?.price ?? null;
  const tp3 = tps[2]?.price ?? null;

  const isLong = direction === 'long';

  for (let i = 0; i < futureCandles.length; i++) {
    const c = futureCandles[i];
    const slHit = isLong ? c.low <= sl : c.high >= sl;
    if (slHit) {
      return { outcome: 'LOSS', actualRR: -1, holdingHours: i + 1 };
    }
    if (tp3 != null && (isLong ? c.high >= tp3 : c.low <= tp3)) {
      return { outcome: 'WIN_TP3', actualRR: tps[2].rr, holdingHours: i + 1 };
    }
    if (tp2 != null && (isLong ? c.high >= tp2 : c.low <= tp2)) {
      return { outcome: 'WIN_TP2', actualRR: tps[1].rr, holdingHours: i + 1 };
    }
    if (tp1 != null && (isLong ? c.high >= tp1 : c.low <= tp1)) {
      return { outcome: 'WIN_TP1', actualRR: tps[0].rr, holdingHours: i + 1 };
    }
  }
  return { outcome: 'EXPIRED', actualRR: 0, holdingHours: futureCandles.length };
}

export async function runBacktest(h1Candles, h4Candles) {
  await fs.mkdir(RESULTS_DIR, { recursive: true });

  if (h1Candles.length < WARMUP + FUTURE_BARS + 10) {
    console.warn(`[backtest] insufficient history: ${h1Candles.length} candles (need ≥${WARMUP + FUTURE_BARS + 10})`);
    await fs.writeFile(SIGNALS_FILE, '[]');
    return [];
  }

  console.log(`[backtest] walking forward ${h1Candles.length} candles (window=${WINDOW}, warmup=${WARMUP}, future=${FUTURE_BARS})`);

  const signals = [];
  const start = WARMUP;
  const end = h1Candles.length - FUTURE_BARS;
  const tStart = Date.now();

  for (let i = start; i < end; i++) {
    if ((i - start) % 500 === 0) {
      const pct = (((i - start) / (end - start)) * 100).toFixed(1);
      console.log(`[backtest] progress: ${i - start}/${end - start} (${pct}%) signals=${signals.length}`);
    }

    const winStart = Math.max(0, i - WINDOW + 1);
    const h1Window = h1Candles.slice(winStart, i + 1);
    if (h1Window.length < 50) continue;

    const candle = h1Candles[i];
    const h4Window = alignH4UpTo(h4Candles, candle.time);
    if (h4Window.length < 30) continue;

    let h1Indicators, h4Indicators;
    try {
      h1Indicators = computeClassicalIndicators(h1Window);
      h4Indicators = computeClassicalIndicators(h4Window);
    } catch {
      continue;
    }
    if (!h1Indicators?.ok || !h4Indicators?.ok || h1Indicators.atr == null) continue;

    const smcH1 = smcForTimeframe(h1Window, 5);
    const smcH4 = smcForTimeframe(h4Window, 3);
    const session = detectSession(new Date(candle.time));

    const ctx = { h1Indicators, h4Indicators, smcH1, smcH4, session };
    const conf = computeConfluence(ctx);

    if (conf.grade === 'no-trade' || !conf.direction) {
      signals.push({
        timestamp: candle.time,
        skipped: true,
        skipReason: conf.factors[0] ?? 'no qualifying factors',
        confluenceCount: conf.count,
        confluenceFactors: conf.factors,
        outcome: 'SKIPPED',
        actualRR: 0,
      });
      continue;
    }

    const plan = buildPlan(conf.direction, smcH1, smcH4, h1Indicators.lastClose, h1Indicators.atr);
    if (!plan) {
      signals.push({
        timestamp: candle.time,
        skipped: true,
        skipReason: 'no plan buildable (missing OB/FVG/liquidity or RR<1.5)',
        confluenceCount: conf.count,
        confluenceFactors: conf.factors,
        outcome: 'SKIPPED',
        actualRR: 0,
      });
      continue;
    }

    const future = h1Candles.slice(i + 1, i + 1 + FUTURE_BARS);
    const result = simulateOutcome(plan, conf.direction, future);

    signals.push({
      timestamp: candle.time,
      direction: conf.direction,
      quality: conf.grade,
      confluenceCount: conf.count,
      confluenceFactors: conf.factors,
      session: session.current,
      dayOfWeek: dayOfWeekUtc(candle.time),
      entry: round(plan.entry),
      sl: round(plan.sl),
      tp1: plan.tps[0]?.price != null ? round(plan.tps[0].price) : null,
      tp2: plan.tps[1]?.price != null ? round(plan.tps[1].price) : null,
      tp3: plan.tps[2]?.price != null ? round(plan.tps[2].price) : null,
      slPips: round(plan.slDist),
      outcome: result.outcome,
      actualRR: round(result.actualRR),
      holdingHours: result.holdingHours,
      h4Bias: smcH4.structure?.bias,
      h1Bias: smcH1.structure?.bias,
    });
  }

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`[backtest] walk-forward done in ${elapsed}s — ${signals.length} signals`);

  await fs.writeFile(SIGNALS_FILE, JSON.stringify(signals, null, 2));
  console.log(`[backtest] saved signals to ${SIGNALS_FILE}`);
  return signals;
}

function round(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return v;
  return Math.round(v * 10 ** d) / 10 ** d;
}
