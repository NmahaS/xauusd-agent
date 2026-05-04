// Deterministic mirror of the 12 LLM confluence checks defined in src/llm/prompt.js.
// M15 is the primary signal TF; H1 is context; H4 is the bias filter.
// Used by the backtest (no LLM in the loop) and for sanity-checking live plans.
//
// Checks 9 (news) and 10 (macro) are no-ops when context fields are absent.
// Grade thresholds: A+:8+, A:6-7, B:4-5, no-trade:<4.

const M15_PROXIMITY_PTS = 8;   // M15 OB/FVG within 8 price units
const H1_PROXIMITY_PTS = 20;   // H1 OB context check within 20 price units

function nearestZone(zones, currentPrice) {
  if (!Array.isArray(zones) || zones.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const z of zones) {
    const lo = z.low ?? z.bottom;
    const hi = z.high ?? z.top;
    if (lo == null || hi == null) continue;
    const mid = (lo + hi) / 2;
    const d = Math.abs(currentPrice - mid);
    if (d < bestDist) { bestDist = d; best = { ...z, mid, low: lo, high: hi, distance: d }; }
  }
  return best;
}

export function computeConfluence(ctx) {
  const factors = [];
  const out = { count: 0, factors, grade: 'no-trade', direction: null };

  const h4Bias = ctx.smcH4?.structure?.bias;
  const m15Bias = ctx.smcM15?.structure?.bias;
  const h1Bias = ctx.smcH1?.structure?.bias;

  // Check 1: H4 and M15 bias agree (H4 = trend filter, M15 = signal)
  let direction = null;
  if (h4Bias === 'bullish' && m15Bias === 'bullish') direction = 'long';
  else if (h4Bias === 'bearish' && m15Bias === 'bearish') direction = 'short';

  if (!direction) {
    factors.push(`bias conflict (h4=${h4Bias} m15=${m15Bias})`);
    return out;
  }
  out.direction = direction;
  factors.push(`H4+M15 bias agree (${direction})`);
  out.count++;

  const currentPrice = ctx.m15Indicators?.lastClose ?? ctx.h1Indicators?.lastClose;
  if (currentPrice == null) return out;

  // Check 2: H1 supports direction (H1 context agrees)
  if (h1Bias === (direction === 'long' ? 'bullish' : 'bearish')) {
    factors.push(`H1 bias confirms direction (${h1Bias})`);
    out.count++;
  }

  // Check 3: M15 active OB within 8pts (primary entry POI)
  const m15OBs = (ctx.smcM15?.orderBlocks || []).filter(o =>
    direction === 'long' ? o.type === 'bullish' : o.type === 'bearish'
  );
  const nearM15OB = nearestZone(m15OBs, currentPrice);
  if (nearM15OB && nearM15OB.distance <= M15_PROXIMITY_PTS) {
    factors.push(`M15 ${nearM15OB.type} OB within 8pts [${nearM15OB.low.toFixed(2)}-${nearM15OB.high.toFixed(2)}]`);
    out.count++;
  }

  // Check 4: M15 unfilled FVG within 8pts
  const m15FVGs = (ctx.smcM15?.fvgs || []).filter(f => !f.filled && (
    direction === 'long' ? f.type === 'bullish' : f.type === 'bearish'
  ));
  const nearM15FVG = nearestZone(m15FVGs, currentPrice);
  if (nearM15FVG && nearM15FVG.distance <= M15_PROXIMITY_PTS) {
    factors.push(`M15 unfilled ${nearM15FVG.type} FVG within 8pts [${nearM15FVG.low.toFixed(2)}-${nearM15FVG.high.toFixed(2)}]`);
    out.count++;
  }

  // Check 5: M15 CHoCH or BOS confirms direction
  const m15Struct = ctx.smcM15?.structure;
  if (m15Struct?.lastEvent) {
    const eventMatchesLong = m15Struct.lastEvent.includes('bullish');
    const eventMatchesShort = m15Struct.lastEvent.includes('bearish');
    if ((direction === 'long' && eventMatchesLong) || (direction === 'short' && eventMatchesShort)) {
      factors.push(`M15 ${m15Struct.lastEvent} confirms direction`);
      out.count++;
    }
  }

  // Check 6: H1 PD zone correct for direction (context)
  const pd = ctx.smcH1?.pd;
  if (pd?.ok) {
    if ((direction === 'long' && pd.zone === 'discount') ||
        (direction === 'short' && pd.zone === 'premium')) {
      factors.push(`H1 price in ${pd.zone} zone (${pd.positionPct?.toFixed(1)}%)`);
      out.count++;
    }
  }

  // Check 7: H1 OB supports direction (context)
  const h1OBs = (ctx.smcH1?.orderBlocks || []).filter(o =>
    direction === 'long' ? o.type === 'bullish' : o.type === 'bearish'
  );
  const nearH1OB = nearestZone(h1OBs, currentPrice);
  if (nearH1OB && nearH1OB.distance <= H1_PROXIMITY_PTS) {
    factors.push(`H1 ${nearH1OB.type} OB within 20pts [${nearH1OB.low.toFixed(2)}-${nearH1OB.high.toFixed(2)}]`);
    out.count++;
  }

  // Check 8: kill zone active
  if (ctx.session?.inKillZone) {
    factors.push(`${ctx.session.killZone} active`);
    out.count++;
  }

  // Check 9: DXY confirms (live only)
  if (ctx.dxy?.ok && ctx.dxy.trend) {
    if ((direction === 'long' && ctx.dxy.trend === 'weakening') ||
        (direction === 'short' && ctx.dxy.trend === 'strengthening')) {
      factors.push(`DXY proxy ${ctx.dxy.trend} confirms direction`);
      out.count++;
    }
  }

  // Check 10: macro yields confirm (live only)
  if (ctx.fred?.ok && ctx.fred.yieldTrend) {
    if ((direction === 'long' && ctx.fred.yieldTrend === 'falling') ||
        (direction === 'short' && ctx.fred.yieldTrend === 'rising')) {
      factors.push(`10Y yield ${ctx.fred.yieldTrend} confirms direction`);
      out.count++;
    }
  }

  // Check 11: no high-impact gold news within 2h (live only)
  if (Array.isArray(ctx.calendar?.events)) {
    const imminent = ctx.calendar.events.find(e => e.goldRelevant && e.minutesAway != null && e.minutesAway <= 120);
    if (!imminent) {
      factors.push('No imminent gold-relevant news');
      out.count++;
    }
  }

  // Check 12: RSI divergence on M15 or H1
  const m15Div = ctx.m15Indicators?.divergence;
  const h1Div = ctx.h1Indicators?.divergence;
  const hasBullishDiv = m15Div?.bullish || h1Div?.bullish;
  const hasBearishDiv = m15Div?.bearish || h1Div?.bearish;
  if ((direction === 'long' && hasBullishDiv) || (direction === 'short' && hasBearishDiv)) {
    factors.push(`RSI ${direction === 'long' ? 'bullish' : 'bearish'} divergence (M15/H1)`);
    out.count++;
  }

  // Require at least one M15 POI (OB or FVG) within range for grade > no-trade
  const hasM15POI = (nearM15OB && nearM15OB.distance <= M15_PROXIMITY_PTS) ||
                    (nearM15FVG && nearM15FVG.distance <= M15_PROXIMITY_PTS);
  if (!hasM15POI) {
    out.grade = 'no-trade';
    return out;
  }

  if (out.count >= 8) out.grade = 'A+';
  else if (out.count >= 6) out.grade = 'A';
  else if (out.count >= 4) out.grade = 'B';
  else out.grade = 'no-trade';

  return out;
}
