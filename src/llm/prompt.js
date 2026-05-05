import { config } from '../config.js';

export const PROMPT_VERSION = 'v4.0';

export function buildSystemPrompt() {
  const symbol = config.SYMBOL;
  return `You are a senior institutional gold (${symbol}) trading analyst specializing in Smart Money Concepts (SMC) combined with classical technical analysis and cross-asset macro context. Your role is decision support, not trade execution.

CONTEXT: You analyze XAU/USDC perpetual on Hyperliquid DEX. Prices are in USD (not AUD — Hyperliquid uses USDC). Current gold price range: ~$2300-3500 USD. Reason about levels, OBs, FVGs, and stops in USD terms. The market is open 24/7 — no session closures.

Funding rate is an additional signal: high positive funding (>0.01%/hr) = crowded longs = mild bearish contrarian signal. High negative funding = crowded shorts = mild bullish contrarian signal. Near zero = balanced.

THREE-LAYER ANALYTICAL FRAMEWORK — assess all three before concluding:
Layer 1 MACRO (weekly): COT positioning, DXY/EUR-USD weekly trend, real yields. This is the highest-timeframe filter. A macro-bearish week means only look for shorts or stay flat.
Layer 2 FLOW (daily): Volume Profile, VWAP, market regime. Confirms where institutions are positioned and whether the market structure is tradeable (trending vs ranging).
Layer 3 TECHNICAL (H4 bias → H1 context → M15 signal): SMC structure (BOS/CHoCH), order blocks, FVGs, liquidity. M15 is the PRIMARY execution timeframe — identify M15 OBs and FVGs as POIs, use M15 CHoCH/BOS for entry confirmation, size stops to M15 ATR.

A trade requires alignment across layers. If macro is bearish but chart is bullish, that is Tier 3 (technical-only signal, no auto-execute) at best. When all three align, that is Tier 1 or Tier 2. Always state which tier applies and why in your biasReasoning.

TIMEFRAME HIERARCHY:
- H4 = directional bias filter. H4 BOS/CHoCH determines whether you look for longs or shorts.
- H1 = structural context. H1 levels (OBs, FVGs, P/D zone) confirm the H4 bias and provide the macro POI range.
- M15 = primary signal and entry. Use M15 OBs (within 8pts) and M15 FVGs (within 8pts) as the actual POI. A M15 CHoCH or bullish/bearish engulfing inside the M15 POI is the entry trigger. Stop is M15 OB extreme ± 0.2×M15 ATR.

Your technical framework:
1. Market structure (BOS/CHoCH) dictates bias at each TF. H4 defines direction; M15 confirms entry timing.
2. M15 Order Blocks and FVGs are the POIs — set poi.zone from M15 levels, not H1.
3. Premium/Discount analysis on H1: buy in discount (below 50% of H1 range), sell in premium. OTE (0.618-0.786 fib) = highest-probability M15 entry area.
4. Risk management: stop at M15 OB extreme + 0.2×M15 ATR; minimum RR 2:1.
5. Kill zones (London 07-10 UTC, NY 12-15 UTC) are preferred execution windows.
6. Cross-asset: EUR/USD rising = dollar weakening = bullish gold; EUR/USD falling = dollar strengthening = bearish gold. Rising real yields = bearish gold; extreme fear on F&G = safe-haven bullish.

CONFLUENCE SCORING — count each of these as 1 point if true for the proposed direction:
 1. H4 and M15 structure bias agree (H4 = directional filter, M15 = signal confirmation)
 2. H1 bias also supports direction (H1 context agrees)
 3. M15 active Order Block within 8 points of current price (primary entry POI)
 4. M15 unfilled FVG within 8 points of current price (imbalance target)
 5. M15 CHoCH or BOS in the proposed direction (recent M15 structure event)
 6. H1 P/D zone correct for direction (discount for long, premium for short)
 7. H1 Order Block at or near current price (within 20 points, adds context confirmation)
 8. Current session is a kill zone (London 07-10 UTC or NY 12-15 UTC)
 9. Dollar proxy (EUR/USD) confirms direction — rising = bullish gold, falling = bearish gold
 10. Macro confirms — real yields falling = bullish gold, rising = bearish gold
 11. No high-impact gold-relevant news within 2 hours
 12. RSI divergence on M15 or H1 (bullish for long, bearish for short)

Set confluenceCount to the exact integer count of matched factors (0 to 12).
Populate confluenceFactors array with a short string for each matched factor, in the same order as the 12 checks above.

Setup grading (based on confluenceCount):
- A+: 8+ factors
- A: 6-7 factors
- B: 4-5 factors
- no-trade: <4 factors, conflicting bias, or no M15 POI within 8pts of current price

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
{"timestamp":"2026-04-19T08:00:00Z","symbol":"${symbol}","timeframe":"15min","bias":"neutral","biasReasoning":"...","setupQuality":"no-trade","confluenceCount":0,"confluenceFactors":[],"direction":null,"poi":null,"entry":null,"stopLoss":null,"takeProfits":null,"invalidation":null,"session":{"current":"london","recommendedExecutionWindow":"Wait for London kill zone"},"risk":{"suggestedRiskPct":0,"positionSizeHint":"No trade"},"macroContext":"...","warnings":[],"promptVersion":"v4.0"}

FIELD FORMAT RULES — follow exactly:
- poi.zone MUST be [number, number] with actual floats, never strings: [2720.20, 2725.50]
- takeProfits[].level MUST be exactly one of: "TP1" "TP2" "TP3" — no spaces, no words
- entry.trigger MUST be exactly "limit" or "marketOnConfirmation"
- All price fields MUST be numbers (floats), never strings
- If direction is "long" or "short", then poi, entry, stopLoss, takeProfits, invalidation MUST all be populated — never null
- If setupQuality is "no-trade" then direction MUST be null and poi/entry/stopLoss/takeProfits/invalidation MUST all be null

EXAMPLE of a complete valid LONG trade plan (copy this structure exactly; prices in USD):
{"timestamp":"2026-04-22T09:00:00Z","symbol":"${symbol}","timeframe":"15min","bias":"bullish","biasReasoning":"H4 BOS to the upside confirmed last session; XAU/USDC retracing into discount zone with bullish OB untested and EUR/USD rising (dollar weakening).","setupQuality":"A","confluenceCount":5,"confluenceFactors":["H4 bullish structure (BOS intact)","Price in discount zone (38% of range)","Unmitigated bullish H1 OB at 3216-3220","EUR/USD rising (dollar weakening)","London kill zone active"],"direction":"long","poi":{"type":"bullish_order_block","zone":[3216.40,3220.10],"reasoning":"Last down-close candle before impulsive leg that broke H1 swing high; overlaps with H1 bullish FVG"},"entry":{"trigger":"limit","price":3218.50,"confirmation":"Limit buy inside OB midpoint; validated by bullish structure and dollar weakness"},"stopLoss":{"price":3210.80,"reasoning":"Below OB low with ATR buffer; invalidates bullish H1 structure if breached","pips":77},"takeProfits":[{"level":"TP1","price":3234.00,"reasoning":"Prior H1 swing high / first liquidity pool","rr":2.0},{"level":"TP2","price":3247.50,"reasoning":"H4 premium zone start (61.8% fib)","rr":3.8},{"level":"TP3","price":3262.00,"reasoning":"H4 equal highs liquidity","rr":5.6}],"invalidation":{"price":3210.00,"reasoning":"H1 structure invalidated; bias flips neutral/bearish"},"session":{"current":"london","recommendedExecutionWindow":"London kill zone 07-10 UTC — execute now on limit fill"},"risk":{"suggestedRiskPct":1.0,"positionSizeHint":"1% risk on 77-pip stop"},"macroContext":"Dollar weakening via EUR/USD up, real yields flat, F&G neutral — supportive for gold bulls.","warnings":[],"promptVersion":"v4.0"}`;
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
    symbol, timestamp,
    h1Candles, h4Candles, m15Candles,
    h1Indicators, h4Indicators, m15Indicators,
    smcH1, smcH4, smcM15,
    session,
    dxy, fred, sentiment, calendar,
    weeklyMacro, volumeProfile, vwap, regime,
    currentPrice, funding, openInterest, oraclePrice,
  } = ctx;

  const section1 = [
    `### SECTION 1: PRICE STRUCTURE & INDICATORS`,
    ``,
    `Symbol: ${symbol}  |  Now (UTC): ${timestamp}  |  Bias: H4  |  Context: H1  |  Signal+Entry: M15`,
    ``,
    `-- H4 BIAS (directional filter) --`,
    `Trend: ${h4Indicators?.trend ?? 'n/a'}  |  EMA20=${fmt(h4Indicators?.ema20)}  EMA50=${fmt(h4Indicators?.ema50)}  EMA200=${fmt(h4Indicators?.ema200)}`,
    `RSI14=${fmt(h4Indicators?.rsi, 1)}  ATR14=${fmt(h4Indicators?.atr)}  MACD hist=${fmt(h4Indicators?.macd?.histogram, 3)}`,
    `H4 SMC bias: ${smcH4?.structure?.bias}  last event: ${smcH4?.structure?.lastEvent ?? 'none'} @ ${fmt(smcH4?.structure?.brokenLevel)}`,
    `H4 active OBs: ${(smcH4?.orderBlocks || []).map(o => `${o.type}[${fmt(o.low)}-${fmt(o.high)}]`).join(', ') || 'none'}`,
    `H4 unfilled FVGs: ${(smcH4?.fvgs || []).filter(f => !f.filled).slice(-5).map(f => `${f.type}[${fmt(f.bottom)}-${fmt(f.top)}]`).join(', ') || 'none'}`,
    `H4 P/D zone: ${smcH4?.pd?.zone} (${fmt(smcH4?.pd?.positionPct, 1)}% of range ${fmt(smcH4?.pd?.low)}-${fmt(smcH4?.pd?.high)})`,
    ``,
    `-- H1 CONTEXT (structural confirmation) --`,
    `Last close: ${fmt(h1Indicators?.lastClose)}  |  Trend: ${h1Indicators?.trend}  |  ATR14=${fmt(h1Indicators?.atr)}`,
    `EMA20=${fmt(h1Indicators?.ema20)}  EMA50=${fmt(h1Indicators?.ema50)}  EMA200=${fmt(h1Indicators?.ema200)}`,
    `RSI14=${fmt(h1Indicators?.rsi, 1)}  MACD hist=${fmt(h1Indicators?.macd?.histogram, 3)}  Divergence: bull=${h1Indicators?.divergence?.bullish} bear=${h1Indicators?.divergence?.bearish}`,
    `H1 SMC bias: ${smcH1?.structure?.bias}  last event: ${smcH1?.structure?.lastEvent ?? 'none'} @ ${fmt(smcH1?.structure?.brokenLevel)}`,
    `H1 active OBs: ${(smcH1?.orderBlocks || []).map(o => `${o.type}[${fmt(o.low)}-${fmt(o.high)}]`).join(', ') || 'none'}`,
    `H1 unfilled FVGs: ${(smcH1?.fvgs || []).filter(f => !f.filled).slice(-5).map(f => `${f.type}[${fmt(f.bottom)}-${fmt(f.top)}]`).join(', ') || 'none'}`,
    `H1 P/D: ${smcH1?.pd?.zone} (${fmt(smcH1?.pd?.positionPct, 1)}% of ${fmt(smcH1?.pd?.low)}-${fmt(smcH1?.pd?.high)})`,
    `H1 OTE long: [${fmt(smcH1?.pd?.ote?.long?.[0])}, ${fmt(smcH1?.pd?.ote?.long?.[1])}]  OTE short: [${fmt(smcH1?.pd?.ote?.short?.[0])}, ${fmt(smcH1?.pd?.ote?.short?.[1])}]`,
    `H1 liquidity EQH: ${(smcH1?.liquidity?.eqh || []).map(l => `${fmt(l.level)}${l.swept ? '(swept)' : ''}`).join(', ') || 'none'}`,
    `H1 liquidity EQL: ${(smcH1?.liquidity?.eql || []).map(l => `${fmt(l.level)}${l.swept ? '(swept)' : ''}`).join(', ') || 'none'}`,
    ``,
    `-- M15 PRIMARY SIGNAL (set poi.zone from M15 levels) --`,
    smcM15
      ? [
          `M15 last close: ${fmt(m15Indicators?.lastClose)}  |  ATR14=${fmt(m15Indicators?.atr)}`,
          `EMA20=${fmt(m15Indicators?.ema20)}  EMA50=${fmt(m15Indicators?.ema50)}  RSI14=${fmt(m15Indicators?.rsi, 1)}  MACD hist=${fmt(m15Indicators?.macd?.histogram, 3)}`,
          `M15 RSI divergence: bull=${m15Indicators?.divergence?.bullish} bear=${m15Indicators?.divergence?.bearish}`,
          `M15 SMC bias: ${smcM15?.structure?.bias}  last event: ${smcM15?.structure?.lastEvent ?? 'none'} @ ${fmt(smcM15?.structure?.brokenLevel)}`,
          `M15 active OBs: ${(smcM15?.orderBlocks || []).map(o => `${o.type}[${fmt(o.low)}-${fmt(o.high)}]`).join(', ') || 'none'}`,
          `M15 unfilled FVGs: ${(smcM15?.fvgs || []).filter(f => !f.filled).slice(-8).map(f => `${f.type}[${fmt(f.bottom)}-${fmt(f.top)}]`).join(', ') || 'none'}`,
          `M15 P/D: ${smcM15?.pd?.zone} (${fmt(smcM15?.pd?.positionPct, 1)}% of ${fmt(smcM15?.pd?.low)}-${fmt(smcM15?.pd?.high)})`,
        ].join('\n')
      : `M15: no data available this run`,
    ``,
    `Session: ${session?.current}  kill zone: ${session?.killZone ?? 'none'}  window: ${session?.recommendedWindow}`,
    ``,
    candleSummary(m15Candles?.length ? m15Candles : h1Candles, m15Candles?.length ? 'M15' : 'H1 (M15 unavailable)', 32),
    ``,
    candleSummary(h4Candles, 'H4', 10),
  ].join('\n');

  const fundingRate = funding?.rate ?? 0;
  const fundingAnn = funding?.annualized ?? 0;
  const section2 = [
    `### SECTION 2: CROSS-ASSET & HYPERLIQUID MARKET`,
    ``,
    `─── EUR/USD (Dollar Proxy) ───`,
    `EUR/USD: last=${fmt(dxy?.last, 5)}  24h=${pct(dxy?.change24hPct)}  trend=${dxy?.trend}  gold impact=${dxy?.goldImpact}`,
    ``,
    `─── HYPERLIQUID MARKET ───`,
    `Mark price: $${fmt(currentPrice)}`,
    `Oracle price: $${fmt(oraclePrice)}`,
    `Funding rate: ${fundingRate > 0 ? '+' : ''}${(fundingRate * 100).toFixed(4)}%/hr  (${fundingAnn.toFixed(1)}% annualized)`,
    `Signal: ${funding?.signal ?? 'unknown'}`,
    `Open interest: ${fmt(openInterest, 1)} XAU`,
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

  const section5 = [
    `### LAYER 1: WEEKLY MACRO`,
    ``,
    `Weekly bias: ${weeklyMacro?.weeklyBias ?? 'unknown'}`,
    weeklyMacro?.cot?.cotSignal ? `COT: ${weeklyMacro.cot.cotSignal}` : `COT: unavailable`,
    `Weekly DXY (EUR/USD) trend: ${weeklyMacro?.weeklyMacro?.weeklyDXYTrend ?? 'unknown'} → ${weeklyMacro?.weeklyMacro?.weeklyDXYBias ?? 'unknown'}`,
    `Weekly yield trend: ${weeklyMacro?.weeklyMacro?.weeklyYieldTrend ?? 'unknown'} → ${weeklyMacro?.weeklyMacro?.weeklyYieldBias ?? 'neutral'}`,
    `Macro factors: ${weeklyMacro?.factors?.join(' | ') || 'none'}`,
    `Summary: ${weeklyMacro?.summary ?? 'unavailable'}`,
  ].join('\n');

  const section6 = [
    `### LAYER 2: FLOW`,
    ``,
    `Market regime: ${regime?.regime ?? 'unknown'} (SMC effective: ${regime?.smc_effective ?? 'unknown'})`,
    `Regime reasoning: ${regime?.reasoning ?? 'n/a'}`,
    ``,
    `Volume Profile (weekly):`,
    `  Signal: ${volumeProfile?.signal ?? 'unknown'} — ${volumeProfile?.description ?? 'n/a'}`,
    `  POC: ${volumeProfile?.poc ?? 'n/a'} | VA: ${volumeProfile?.valueAreaLow ?? 'n/a'}–${volumeProfile?.valueAreaHigh ?? 'n/a'}`,
    `  Nearest HVN: ${volumeProfile?.nearestHVN ?? 'n/a'} | Nearest LVN: ${volumeProfile?.nearestLVN ?? 'n/a'}`,
    ``,
    `VWAP:`,
    `  Daily VWAP: ${vwap?.dailyVWAP ?? 'n/a'} | Weekly VWAP: ${vwap?.weeklyVWAP ?? 'n/a'}`,
    `  Signals: ${vwap?.signals?.join(' | ') || 'n/a'}`,
    `  Institutional bias: ${vwap?.institutionalBias ?? 'unknown'}`,
  ].join('\n');

  const footer = [
    ``,
    `### YOUR TASK`,
    `Produce the trading plan JSON per schema ${PROMPT_VERSION}. Required top-level keys: timestamp, symbol, timeframe, bias, biasReasoning, setupQuality, confluenceCount, confluenceFactors, direction, poi, entry, stopLoss, takeProfits, invalidation, session, risk, macroContext, warnings, promptVersion.`,
    `If no trade: setupQuality="no-trade", direction/poi/entry/stopLoss/takeProfits/invalidation=null.`,
    `Return ONLY valid JSON. No markdown. No code fences. No explanation outside the JSON.`,
  ].join('\n');

  return [section5, '', section6, '', section1, '', section2, '', section3, '', section4, footer].join('\n');
}
