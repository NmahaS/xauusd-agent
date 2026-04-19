export const PROMPT_VERSION = 'v2.0';

export function buildSystemPrompt() {
  return `You are a senior institutional gold (XAU/USD) trading analyst specializing in Smart Money Concepts (SMC) combined with classical technical analysis and cross-asset macro context. Your role is decision support, not trade execution.

Your analytical framework:
1. Market structure (BOS/CHoCH) dictates bias. Trade with structure, not against it.
2. Order blocks, Fair Value Gaps, and liquidity pools are points of interest (POIs). Institutional traders return to these zones.
3. Premium/Discount analysis: buy in discount (below 50% of last range), sell in premium (above 50%). OTE (0.618-0.786 fib) = highest-probability entries.
4. Confluence is king: every A+ setup should have 4+ confluent factors (structure, POI, P/D zone, session timing, DXY direction, macro backdrop, sentiment).
5. Risk management: stop below/above the invalidation level of your POI; minimum RR 2:1.
6. Kill zones (London 07-10 UTC, NY 12-15 UTC) are preferred execution windows.
7. Cross-asset: DXY strengthening is bearish for gold; falling real yields are bullish; extreme fear on F&G is safe-haven bullish.

Setup grading:
- A+: 5+ confluences, aligned with H4 bias, in kill zone, no high-impact news within 2h
- A: 4 confluences, broadly aligned
- B: 3 confluences, marginal — small size only
- no-trade: <3 confluences, conflicting bias, news imminent, or no clear POI near price

Output requirements:
- Return ONLY a single JSON object, no prose, no code fences, no markdown.
- Schema version: ${PROMPT_VERSION}
- All prices as numbers (not strings). Use the same decimal precision as input data.
- If no trade is warranted, set setupQuality to "no-trade", direction/poi/entry/stopLoss/takeProfits/invalidation to null, and explain in warnings.
- Populate confluenceFactors with short bullet-string descriptions of each confluent factor identified.
- macroContext should be 1-2 sentences summarizing the cross-asset and macro backdrop.

CRITICAL JSON STRUCTURE RULES — you MUST follow these exactly:
- "session" MUST be an object: { "current": "asia"|"london"|"ny"|"off", "recommendedExecutionWindow": "string" }
- "risk" MUST be an object: { "suggestedRiskPct": number, "positionSizeHint": "string" } — never null
- "warnings" MUST be an array of strings: ["warning1", "warning2"] — never a plain string
- "takeProfits" MUST be an array of objects or null — never a plain object
- "confluenceFactors" MUST be an array of strings
- All nullable fields (poi, entry, stopLoss, takeProfits, invalidation) should be null when setupQuality is "no-trade"
- Do NOT nest the plan inside another object. Return the plan object directly at the top level.

EXAMPLE of correct minimal no-trade response:
{"timestamp":"2026-04-19T08:00:00Z","symbol":"XAU/USD","timeframe":"1h","bias":"neutral","biasReasoning":"...","setupQuality":"no-trade","confluenceCount":0,"confluenceFactors":[],"direction":null,"poi":null,"entry":null,"stopLoss":null,"takeProfits":null,"invalidation":null,"session":{"current":"london","recommendedExecutionWindow":"Wait for London kill zone"},"risk":{"suggestedRiskPct":0,"positionSizeHint":"No trade"},"macroContext":"...","warnings":[],"promptVersion":"v2.0"}`;
}

function candleSummary(candles, tf, limit = 30) {
  if (!Array.isArray(candles) || candles.length === 0) return `${tf}: no candles`;
  const recent = candles.slice(-limit);
  const lines = recent.map(c =>
    `  ${c.time} O=${c.open} H=${c.high} L=${c.low} C=${c.close}`
  );
  return `${tf} last ${recent.length} candles:\n${lines.join('\n')}`;
}

function fmt(v, d = 2) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  return typeof v === 'number' ? v.toFixed(d) : String(v);
}

function pct(v) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export function buildUserPrompt(ctx) {
  const {
    symbol, timestamp, executionTf, biasTf,
    h1Candles, h4Candles,
    h1Indicators, h4Indicators,
    smcH1, smcH4,
    session,
    dxy, metals, fred, sentiment, calendar,
  } = ctx;

  const section1 = [
    `### SECTION 1: PRICE STRUCTURE & INDICATORS`,
    ``,
    `Symbol: ${symbol}  |  Now (UTC): ${timestamp}  |  Exec TF: ${executionTf}  |  Bias TF: ${biasTf}`,
    ``,
    `-- H4 bias --`,
    `Trend: ${h4Indicators?.trend ?? 'n/a'}  |  EMA20=${fmt(h4Indicators?.ema20)}  EMA50=${fmt(h4Indicators?.ema50)}  EMA200=${fmt(h4Indicators?.ema200)}`,
    `RSI14=${fmt(h4Indicators?.rsi, 1)}  ATR14=${fmt(h4Indicators?.atr)}  MACD hist=${fmt(h4Indicators?.macd?.histogram, 3)}`,
    `Divergence: bullish=${h4Indicators?.divergence?.bullish} bearish=${h4Indicators?.divergence?.bearish}`,
    `H4 SMC bias: ${smcH4?.structure?.bias}  last event: ${smcH4?.structure?.lastEvent ?? 'none'} @ ${fmt(smcH4?.structure?.brokenLevel)}`,
    `H4 active OBs: ${(smcH4?.orderBlocks || []).map(o => `${o.type}[${fmt(o.low)}-${fmt(o.high)}]`).join(', ') || 'none'}`,
    `H4 unfilled FVGs: ${(smcH4?.fvgs || []).filter(f => !f.filled).slice(-5).map(f => `${f.type}[${fmt(f.bottom)}-${fmt(f.top)}]`).join(', ') || 'none'}`,
    `H4 P/D zone: ${smcH4?.pd?.zone} (${fmt(smcH4?.pd?.positionPct, 1)}% of range ${fmt(smcH4?.pd?.low)}-${fmt(smcH4?.pd?.high)})`,
    ``,
    `-- H1 execution --`,
    `Last close: ${fmt(h1Indicators?.lastClose)}  |  Trend: ${h1Indicators?.trend}  |  ATR14=${fmt(h1Indicators?.atr)}`,
    `EMA20=${fmt(h1Indicators?.ema20)}  EMA50=${fmt(h1Indicators?.ema50)}  EMA200=${fmt(h1Indicators?.ema200)}`,
    `RSI14=${fmt(h1Indicators?.rsi, 1)}  MACD hist=${fmt(h1Indicators?.macd?.histogram, 3)}`,
    `Divergence: bullish=${h1Indicators?.divergence?.bullish} bearish=${h1Indicators?.divergence?.bearish}`,
    `H1 SMC bias: ${smcH1?.structure?.bias}  last event: ${smcH1?.structure?.lastEvent ?? 'none'} @ ${fmt(smcH1?.structure?.brokenLevel)}`,
    `H1 active OBs (top 3 by proximity): ${(smcH1?.orderBlocks || []).map(o => `${o.type}[${fmt(o.low)}-${fmt(o.high)}]`).join(', ') || 'none'}`,
    `H1 unfilled FVGs: ${(smcH1?.fvgs || []).filter(f => !f.filled).slice(-5).map(f => `${f.type}[${fmt(f.bottom)}-${fmt(f.top)}]`).join(', ') || 'none'}`,
    `H1 liquidity EQH: ${(smcH1?.liquidity?.eqh || []).map(l => `${fmt(l.level)}${l.swept ? '(swept)' : ''}`).join(', ') || 'none'}`,
    `H1 liquidity EQL: ${(smcH1?.liquidity?.eql || []).map(l => `${fmt(l.level)}${l.swept ? '(swept)' : ''}`).join(', ') || 'none'}`,
    `H1 P/D: ${smcH1?.pd?.zone} (${fmt(smcH1?.pd?.positionPct, 1)}% of ${fmt(smcH1?.pd?.low)}-${fmt(smcH1?.pd?.high)})`,
    `H1 OTE long zone: [${fmt(smcH1?.pd?.ote?.long?.[0])}, ${fmt(smcH1?.pd?.ote?.long?.[1])}]  OTE short zone: [${fmt(smcH1?.pd?.ote?.short?.[0])}, ${fmt(smcH1?.pd?.ote?.short?.[1])}]`,
    ``,
    `Session: ${session?.current}  kill zone: ${session?.killZone ?? 'none'}  window: ${session?.recommendedWindow}`,
    ``,
    candleSummary(h1Candles, 'H1', 24),
    ``,
    candleSummary(h4Candles, 'H4', 12),
  ].join('\n');

  const section2 = [
    `### SECTION 2: CROSS-ASSET`,
    ``,
    `${dxy?.symbol ?? 'DXY'}: last=${fmt(dxy?.last, 5)}  24h=${pct(dxy?.change24hPct)}  trend=${dxy?.trend}  gold impact=${dxy?.goldImpact}`,
    `Spot metals: Au=${fmt(metals?.gold)}  Ag=${fmt(metals?.silver, 3)}  Pt=${fmt(metals?.platinum)} (source: ${metals?.source})`,
    `Au/Ag ratio: ${fmt(metals?.auAg, 1)} — ${metals?.auAgSignal}`,
    `Au/Pt ratio: ${fmt(metals?.auPt, 2)}`,
    `Spot vs chart gap: ${fmt(metals?.spotVsChart)} (${pct(metals?.spotVsChartPct)})`,
  ].join('\n');

  const section3 = [
    `### SECTION 3: MACRO`,
    ``,
    `US 10Y yield: ${fmt(fred?.tenYearYield, 3)}%  trend=${fred?.yieldTrend}`,
    `Fed funds rate: ${fmt(fred?.fedRate, 2)}%`,
    `Breakeven inflation (10Y): ${fmt(fred?.breakeven, 2)}%`,
    `Real yield (10Y-breakeven): ${fmt(fred?.realYield, 2)}% → ${fred?.goldImpact}`,
    `Fear & Greed: ${fmt(sentiment?.value, 0)} (${sentiment?.classification}) 7d trend=${sentiment?.trend} → ${sentiment?.goldImpact}`,
  ].join('\n');

  const events = (calendar?.events || []).slice(0, 10);
  const section4 = [
    `### SECTION 4: UPCOMING ECONOMIC CALENDAR (next 24h, high/medium impact)`,
    ``,
    events.length === 0
      ? 'No high/medium impact events in next 24h.'
      : events.map(e =>
          `  +${e.minutesAway}m  ${e.country}  ${e.title}  (${e.impact}${e.goldRelevant ? ', GOLD-RELEVANT' : ''})  fcst=${e.forecast || 'n/a'} prev=${e.previous || 'n/a'}`
        ).join('\n'),
    ``,
    (calendar?.warnings || []).length > 0
      ? `AUTO-WARNINGS:\n${calendar.warnings.map(w => `  ⚠ ${w}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');

  const footer = [
    ``,
    `### YOUR TASK`,
    `Produce the trading plan JSON per schema ${PROMPT_VERSION}. Required top-level keys: timestamp, symbol, timeframe, bias, biasReasoning, setupQuality, confluenceCount, confluenceFactors, direction, poi, entry, stopLoss, takeProfits, invalidation, session, risk, macroContext, warnings, promptVersion.`,
    `If no trade: setupQuality="no-trade", direction/poi/entry/stopLoss/takeProfits/invalidation=null.`,
    `Return ONLY valid JSON. No markdown. No code fences. No explanation outside the JSON.`,
  ].join('\n');

  return [section1, '', section2, '', section3, '', section4, footer].join('\n');
}
