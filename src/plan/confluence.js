// Deterministic mirror of the 10 LLM confluence checks defined in src/llm/prompt.js.
// Used by the backtest (no LLM in the loop) and available for sanity-checking live plans.
//
// Three checks (#7 DXY, #8 macro yields, #9 news) are no-ops when the corresponding
// context fields are absent — they evaluate to false. In a backtest run that means the
// max evaluable score is 7. Grade thresholds are kept absolute (A+:5+, A:4, B:3) so
// a B-graded backtest signal is comparable to a B-graded live plan in spirit.

function bothBiasAgree(h4, h1) {
  if (!h4 || !h1) return null;
  if (h4 === 'bullish' && h1 === 'bullish') return 'long';
  if (h4 === 'bearish' && h1 === 'bearish') return 'short';
  return null;
}

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
  const h1Bias = ctx.smcH1?.structure?.bias;
  const direction = bothBiasAgree(h4Bias, h1Bias);
  if (!direction) {
    factors.push(`bias conflict (h4=${h4Bias} h1=${h1Bias})`);
    return out;
  }
  out.direction = direction;
  factors.push(`H4+H1 bias agree (${direction})`);
  out.count++;

  const currentPrice = ctx.h1Indicators?.lastClose;
  const atr = ctx.h1Indicators?.atr;
  if (currentPrice == null || atr == null) {
    out.factors = factors;
    return out;
  }
  const proximity = Math.max(0.5 * atr, 1); // floor at 1 unit so tiny-ATR doesn't block all OBs

  // Check 2: H1 PD zone matches direction (discount for long, premium for short)
  const pd = ctx.smcH1?.pd;
  if (pd?.ok) {
    if ((direction === 'long' && pd.zone === 'discount') ||
        (direction === 'short' && pd.zone === 'premium')) {
      factors.push(`Price in ${pd.zone} zone (${pd.positionPct?.toFixed(1)}%)`);
      out.count++;
    }
  }

  // Check 3: active OB of correct type within proximity of current price
  const obs = (ctx.smcH1?.orderBlocks || []).filter(o =>
    direction === 'long' ? o.type === 'bullish' : o.type === 'bearish'
  );
  const nearOB = nearestZone(obs, currentPrice);
  if (nearOB && nearOB.distance <= proximity) {
    factors.push(`${nearOB.type} OB within ${(0.5).toFixed(1)}×ATR (zone ${nearOB.low.toFixed(2)}-${nearOB.high.toFixed(2)})`);
    out.count++;
  }

  // Check 4: unfilled FVG within proximity
  const fvgs = (ctx.smcH1?.fvgs || []).filter(f => !f.filled && (
    direction === 'long' ? f.type === 'bullish' : f.type === 'bearish'
  ));
  const nearFVG = nearestZone(fvgs, currentPrice);
  if (nearFVG && nearFVG.distance <= proximity) {
    factors.push(`Unfilled ${nearFVG.type} FVG within 0.5×ATR (zone ${nearFVG.low.toFixed(2)}-${nearFVG.high.toFixed(2)})`);
    out.count++;
  }

  // Check 5: price in OTE zone for direction
  const ote = pd?.ote?.[direction];
  if (Array.isArray(ote) && ote.length === 2) {
    const [lo, hi] = ote;
    if (currentPrice >= Math.min(lo, hi) && currentPrice <= Math.max(lo, hi)) {
      factors.push(`Price in OTE ${direction} zone`);
      out.count++;
    }
  }

  // Check 6: kill zone active
  if (ctx.session?.inKillZone) {
    factors.push(`${ctx.session.killZone} active`);
    out.count++;
  }

  // Check 7: DXY proxy confirms (live only — backtest leaves blank)
  if (ctx.dxy?.ok && ctx.dxy.trend) {
    if ((direction === 'long' && ctx.dxy.trend === 'weakening') ||
        (direction === 'short' && ctx.dxy.trend === 'strengthening')) {
      factors.push(`DXY proxy ${ctx.dxy.trend} confirms direction`);
      out.count++;
    }
  }

  // Check 8: macro yields confirm (live only)
  if (ctx.fred?.ok && ctx.fred.yieldTrend) {
    if ((direction === 'long' && ctx.fred.yieldTrend === 'falling') ||
        (direction === 'short' && ctx.fred.yieldTrend === 'rising')) {
      factors.push(`10Y yield ${ctx.fred.yieldTrend} confirms direction`);
      out.count++;
    }
  }

  // Check 9: no high-impact gold news within 2h (live only)
  if (Array.isArray(ctx.calendar?.events)) {
    const imminent = ctx.calendar.events.find(e => e.goldRelevant && e.minutesAway != null && e.minutesAway <= 120);
    if (!imminent) {
      factors.push('No imminent gold-relevant news');
      out.count++;
    }
  }

  // Check 10: RSI divergence matches direction
  const div = ctx.h1Indicators?.divergence;
  if (div) {
    if ((direction === 'long' && div.bullish) || (direction === 'short' && div.bearish)) {
      factors.push(`RSI ${direction === 'long' ? 'bullish' : 'bearish'} divergence`);
      out.count++;
    }
  }

  // Need at minimum a POI (OB or FVG) near price for grade > no-trade
  const hasPOI = (nearOB && nearOB.distance <= proximity) || (nearFVG && nearFVG.distance <= proximity);
  if (!hasPOI) {
    out.grade = 'no-trade';
    return out;
  }

  if (out.count >= 5) out.grade = 'A+';
  else if (out.count >= 4) out.grade = 'A';
  else if (out.count >= 3) out.grade = 'B';
  else out.grade = 'no-trade';

  return out;
}
