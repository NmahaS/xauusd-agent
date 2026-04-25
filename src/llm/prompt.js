export const PROMPT_VERSION = 'v2.0';

export function buildSystemPrompt() {
  return `You are a senior institutional gold (XAU/USD) trading analyst specializing in Smart Money Concepts (SMC) combined with classical technical analysis and cross-asset macro context. Your role is decision support, not trade execution.

Your analytical framework:
1. Market structure (BOS/CHoCH) dictates bias. Trade with structure, not against it.
2. Order blocks, Fair Value Gaps, and liquidity pools are points of interest (POIs). Institutional traders return to these zones.
3. Premium/Discount analysis: buy in discount (below 50% of last range), sell in premium (above 50%). OTE (0.618-0.786 fib) = highest-probability entries.
4. Risk management: stop below/above the invalidation level of your POI; minimum RR 2:1.
5. Kill zones (London 07-10 UTC, NY 12-15 UTC) are preferred execution windows.
6. Cross-asset: EUR/USD rising = dollar weakening = bullish gold; EUR/USD falling = dollar strengthening = bearish gold. Rising real yields = bearish gold; extreme fear on F&G = safe-haven bullish.

CONFLUENCE SCORING — count each of these as 1 point if true for the proposed direction:
 1. H4 and H1 structure bias agree (both bullish for long, both bearish for short)
 2. Price is in the correct zone for direction (discount for long, premium for short)
 3. Active Order Block within 20 points of current price (supports the direction)
 4. Unfilled FVG within 20 points of current price (supports the direction)
 5. Price is in the OTE zone (fib 0.618-0.786) for the proposed direction
 6. Current session is a kill zone (London 07-10 UTC or NY 12-15 UTC)
 7. Dollar proxy (EUR/USD) trend confirms direction — falling = bearish gold, rising = bullish gold
 8. Macro confirms — rising 10Y yields = bearish gold, falling = bullish gold
 9. No high-impact gold-relevant news within 2 hours
 10. RSI divergence present on H1 or H4 (bullish for long, bearish for short)

Set confluenceCount to the exact integer count of matched factors (0 to 10).
Populate confluenceFactors array with a short string for each matched factor, in the same order as the 10 checks above.

Setup grading (based on confluenceCount):
- A+: 7+ factors
- A: 5-6 factors
- B: 3-4 factors
- no-trade: <3 factors, conflicting bias, or no clear POI near price

Output requirements:
- Return ONLY a single JSON object, no prose, no code fences, no markdown.
- Schema version: ${PROMPT_VERSION}
- All prices as numbers (not strings). Use the same decimal precision as input data.
- If no trade is warranted, set setupQuality to "no-trade", direction/poi/entry/stopLoss/takeProfits/invalidation to null, and explain in warnings.
- Populate confluenceFactors with short bullet-string descriptions of each confluent factor identified.
- macroContext MUST be filled in with a 1-sentence non-empty string summarizing yields + dollar proxy + sentiment, ALWAYS — even for no-trade plans. Never leave it empty or say "n/a".

CRITICAL JSON STRUCTURE RULES — you MUST follow these exactly:
- "session" MUST be an object: { "current": "asia"|"london"|"ny"|"off", "recommendedExecutionWindow": "string" }
- "risk" MUST be an object: { "suggestedRiskPct": number, "positionSizeHint": "string" } — never null
- "warnings" MUST be an array of strings: ["warning1", "warning2"] — never a plain string
- "takeProfits" MUST be an array of objects or null — never a plain object
- "confluenceFactors" MUST be an array of strings
- All nullable fields (poi, entry, stopLoss, takeProfits, invalidation) should be null when setupQuality is "no-trade"
- Do NOT nest the plan inside another object. Return the plan object directly at the top level.

EXAMPLE of correct minimal no-trade response:
{"timestamp":"2026-04-19T08:00:00Z","symbol":"XAU/USD","timeframe":"1h","bias":"neutral","biasReasoning":"...","setupQuality":"no-trade","confluenceCount":0,"confluenceFactors":[],"direction":null,"poi":null,"entry":null,"stopLoss":null,"takeProfits":null,"invalidation":null,"session":{"current":"london","recommendedExecutionWindow":"Wait for London kill zone"},"risk":{"suggestedRiskPct":0,"positionSizeHint":"No trade"},"macroContext":"...","warnings":[],"promptVersion":"v2.0"}

FIELD FORMAT RULES — follow exactly:
- poi.zone MUST be [number, number] with actual floats, never strings: [3290.20, 3295.50]
- takeProfits[].level MUST be exactly one of: "TP1" "TP2" "TP3" — no spaces, no words
- entry.trigger MUST be exactly "limit" or "marketOnConfirmation"
- All price fields MUST be numbers (floats), never strings
- If direction is "long" or "short", then poi, entry, stopLoss, takeProfits, invalidation MUST all be populated — never null
- If setupQuality is "no-trade" then direction MUST be null and poi/entry/stopLoss/takeProfits/invalidation MUST all be null

EXAMPLE of a complete valid LONG trade plan (copy this structure exactly):
{"timestamp":"2026-04-22T09:00:00Z","symbol":"XAU/USD","timeframe":"1h","bias":"bullish","biasReasoning":"H4 BOS to the upside confirmed last session; price retracing into discount zone with bullish OB untested and EUR/USD rising (dollar weakening).","setupQuality":"A","confluenceCount":5,"confluenceFactors":["H4 bullish structure (BOS intact)","Price in discount zone (38% of range)","Unmitigated bullish H1 OB at 3288-3292","EUR/USD rising (dollar weakening)","London kill zone active"],"direction":"long","poi":{"type":"bullish_order_block","zone":[3288.40,3292.10],"reasoning":"Last down-close candle before impulsive leg that broke H1 swing high; overlaps with H1 bullish FVG"},"entry":{"trigger":"limit","price":3290.50,"confirmation":"Limit buy inside OB midpoint; validated by bullish structure and dollar weakness"},"stopLoss":{"price":3284.80,"reasoning":"Below OB low with ATR buffer; invalidates bullish H1 structure if breached","pips":57},"takeProfits":[{"level":"TP1","price":3302.00,"reasoning":"Prior H1 swing high / first liquidity pool","rr":2.0},{"level":"TP2","price":3311.50,"reasoning":"H4 premium zone start (61.8% fib)","rr":3.7},{"level":"TP3","price":3322.00,"reasoning":"H4 equal highs liquidity","rr":5.5}],"invalidation":{"price":3284.00,"reasoning":"H1 structure invalidated; bias flips neutral/bearish"},"session":{"current":"london","recommendedExecutionWindow":"London kill zone 07-10 UTC — execute now on limit fill"},"risk":{"suggestedRiskPct":1.0,"positionSizeHint":"1% risk on 57-pip stop"},"macroContext":"Dollar weakening via EUR/USD up, real yields flat, F&G neutral — supportive for gold bulls.","warnings":[],"promptVersion":"v2.0"}

EXAMPLE of a complete valid SHORT trade plan (copy this structure exactly):
{"timestamp":"2026-04-22T13:00:00Z","symbol":"XAU/USD","timeframe":"1h","bias":"bearish","biasReasoning":"H4 CHoCH-bearish confirmed; price rallied into premium zone (68% of range) tagging an unmitigated bearish H1 OB with EUR/USD falling (dollar strength) and real yields rising.","setupQuality":"A+","confluenceCount":7,"confluenceFactors":["H4 bearish CHoCH","H1 bearish structure","Price in premium zone (68% of range)","Unmitigated bearish H1 OB at 3312-3316","Price in OTE short zone (0.618-0.786 fib)","EUR/USD falling (dollar strengthening)","NY kill zone active"],"direction":"short","poi":{"type":"bearish_order_block","zone":[3312.00,3316.40],"reasoning":"Last up-close candle before impulsive leg that broke H1 swing low; overlaps with bearish FVG and premium zone"},"entry":{"trigger":"limit","price":3313.80,"confirmation":"Limit sell inside OB; validated by H4 bearish CHoCH and dollar strength"},"stopLoss":{"price":3320.50,"reasoning":"Above OB high + ATR buffer; invalidates bearish H1 structure if breached","pips":67},"takeProfits":[{"level":"TP1","price":3300.00,"reasoning":"Prior H1 swing low / first liquidity pool","rr":2.1},{"level":"TP2","price":3288.50,"reasoning":"H4 discount zone entry (50% fib)","rr":3.8},{"level":"TP3","price":3275.00,"reasoning":"H4 equal lows / session liquidity target","rr":5.8}],"invalidation":{"price":3321.00,"reasoning":"Close above OB high invalidates bearish H1 structure"},"session":{"current":"ny","recommendedExecutionWindow":"NY kill zone 12-15 UTC — execute now on limit fill"},"risk":{"suggestedRiskPct":1.0,"positionSizeHint":"1% risk on 67-pip stop"},"macroContext":"EUR/USD falling signals dollar strength, 10Y yield rising, real yields positive — bearish backdrop for gold.","warnings":[],"promptVersion":"v2.0"}`;
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
