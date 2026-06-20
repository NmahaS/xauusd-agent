import { config, configIsFull } from './config.js';
import { dataPath } from './utils/dataDir.js';
import { fetchAllHLData } from './data/hyperliquid.js';
import { fetchFredMacro as fetchMacroData } from './data/fred.js';
import { fetchSentiment } from './data/sentiment.js';
import { fetchCalendar as fetchEconomicCalendar } from './data/calendar.js';

import { computeClassicalIndicators } from './indicators/classical.js';
import { detectSession, computeSessionLevels } from './indicators/session.js';

import { analyzeStructure } from './smc/structure.js';
import { detectFVGs } from './smc/fvg.js';
import { detectOrderBlocks } from './smc/orderBlocks.js';
import { detectLiquidity } from './smc/liquidity.js';
import { computePremiumDiscount } from './smc/premiumDiscount.js';
import { identifyKeyLevels } from './smc/keyLevels.js';
import { getTimeframeAlignment } from './risk/manager.js';

import { generatePlan } from './llm/client.js';
import { computeConfluence } from './plan/confluence.js';
import { validateAndCorrectPlanSLTP } from './plan/validator.js';
import { savePlan, updateReadmeLatestPlan } from './plan/writer.js';
import { resolveOpenTrades } from './plan/outcomeTracker.js';
import { updateDailySummary } from './plan/tracker.js';
import { formatPlanForTelegram } from './plan/formatter.js';
import { sendTelegramMessage } from './telegram/notify.js';

import { refineEntry } from './refinement/m15.js';
import { executeIfApproved } from './broker/executor.js';

// Layer 1: Macro
import { getWeeklyMacroState } from './macro/macroState.js';
// Layer 2: Flow
import { computeVolumeProfile, getVolumeProfileSignal } from './flow/volumeProfile.js';
import { computeVWAP, getVWAPSignal } from './flow/vwap.js';
import { detectRegime } from './flow/regimeDetector.js';
// Three-layer consensus
import { computeThreeLayerConsensus } from './analysis/threeLayerConsensus.js';

function time() {
  return Date.now();
}

function smcForTimeframe(candles, n) {
  const structure = analyzeStructure(candles, n);
  const fvgs = detectFVGs(candles);
  const orderBlocks = detectOrderBlocks(candles, n);
  const liquidity = detectLiquidity(candles, n);
  const pd = computePremiumDiscount(candles, n);
  return { structure, fvgs, orderBlocks, liquidity, pd };
}

function splitByType(arr) {
  return {
    bullish: (arr || []).filter(o => o.type === 'bullish'),
    bearish: (arr || []).filter(o => o.type === 'bearish'),
  };
}

function buildCrossAssetWarnings({ dxy, fred, sentiment, h1Count, h4Count }) {
  const warnings = [];
  if (!dxy?.ok) warnings.push('EUR/USD dollar proxy unavailable — cross-asset context reduced');
  if (!fred?.ok) warnings.push('FRED macro data unavailable — yields/real-rate missing');
  if (!sentiment?.ok) warnings.push('Fear & Greed unavailable');
  if (h1Count != null && h1Count < 50) {
    warnings.push(`Limited history (${h1Count} H1 / ${h4Count} H4 candles) — SMC and indicators degraded`);
  }
  return warnings;
}

// Full pipeline: LLM analysis + three-layer consensus + execution.
async function runFullPipeline() {
  if (!configIsFull) {
    throw new Error(
      'Pipeline config incomplete — HL, ANTHROPIC, and DEEPSEEK credentials are required. See [config] warnings above.'
    );
  }

  const tTotal = time();
  const runTimestamp = new Date().toISOString();

  console.log(`\n=== XAUUSD Agent run @ ${runTimestamp} ===`);
  console.log(
    `symbol=${config.SYMBOL} bias=4h context=1h exec=15min ` +
    `dryRun=${config.DRY_RUN} autoTrade=${config.AUTO_TRADE} dryExecute=${config.DRY_EXECUTE}`
  );

  // Phase 1: parallel fetch — Hyperliquid has no quota, always fresh
  const tFetch = time();
  const [hlData, macro, altSentiment, calendar, weeklyMacro] = await Promise.all([
    fetchAllHLData(),
    fetchMacroData(config.FRED_API_KEY),
    fetchSentiment(),
    fetchEconomicCalendar(),
    getWeeklyMacroState().catch(err => {
      console.warn(`[pipeline] weekly macro failed: ${err.message}`);
      return null;
    }),
  ]);

  const {
    h1Candles, h4Candles, m15Candles, currentPrice, spread, marketStatus, igSentiment, dxy,
    dailyHigh, dailyLow, funding, fundingAnnualized, openInterest, oraclePrice,
  } = hlData;
  console.log(`[pipeline] fetch phase done in ${time() - tFetch}ms`);

  // Trailing-stop maintenance — runs every cycle BEFORE signal analysis so open winners keep
  // ratcheting even on no-signal / hold runs. Live mode only; needs just the current price.
  if (process.env.AUTO_TRADE === 'true' && process.env.DRY_EXECUTE !== 'true' && process.env.DRY_RUN !== 'true') {
    try {
      const { updateTrailingStop } = await import('./broker/trailing.js');
      await updateTrailingStop(process.env.HL_COIN || 'PAXG', { currentPrice });
    } catch (e) {
      console.warn('[trail] error:', e.message);
    }
  }

  if (h1Candles.length === 0) {
    console.error('[pipeline] no gold data from Hyperliquid — sending alert and skipping');
    const alert =
      `⚠️ <b>Gold data unavailable</b>\n` +
      `Hyperliquid API failed to return XAU candles.\n` +
      `Will retry next run automatically.`;
    try { await sendTelegramMessage(alert); }
    catch (e) { console.error(`[pipeline] alert send failed: ${e.message}`); }
    return { plan: null, telegramText: alert, skipped: true };
  }

  if (h4Candles.length === 0) {
    console.warn('[pipeline] no H4 candles — H4 SMC will be empty, continuing with H1 only');
  }
  if (h1Candles.length < 50 || h4Candles.length < 50) {
    console.warn(`[pipeline] reduced history: H1=${h1Candles.length} H4=${h4Candles.length}`);
  }

  const isSynthetic = m15Candles[0]?.synthetic === true;
  console.log(`[pipeline] M15: ${m15Candles.length} candles${isSynthetic ? ' (synthetic)' : ''}`);

  // Resolve open trades from prior plans before computing indicators
  await resolveOpenTrades(h1Candles).catch(err =>
    console.warn(`[outcome] resolution error: ${err.message}`)
  );

  // RAG: resolve theoretical outcomes for any blocked signals still pending
  import('./plan/outcomeTracker.js').then(m =>
    m.resolveBlockedSignals(hlData).catch(err =>
      console.warn(`[rag] resolveBlockedSignals error: ${err.message}`)
    )
  ).catch(() => {});

  // Phase 2: indicators + SMC (H4=bias, H1=context, M15=primary signal)
  const tCompute = time();
  const h1Indicators = computeClassicalIndicators(h1Candles);
  const h4Indicators = computeClassicalIndicators(h4Candles);
  const m15Indicators = m15Candles.length >= 14 ? computeClassicalIndicators(m15Candles) : null;
  const smcH1 = smcForTimeframe(h1Candles, 5);
  const smcH4 = smcForTimeframe(h4Candles, 3);
  const smcM15 = m15Candles.length >= 10 ? smcForTimeframe(m15Candles, 3) : null;
  const keyLevels = identifyKeyLevels(h4Candles, h1Candles, m15Candles, currentPrice);
  const session = detectSession();
  const sessionLevels = computeSessionLevels(h1Candles);

  // Layer 2: flow analysis
  const volumeProfileRaw = computeVolumeProfile(h1Candles, 'week');
  const vpSignal = getVolumeProfileSignal(currentPrice, volumeProfileRaw);
  const dailyVWAP = computeVWAP(h1Candles, 'day');
  const weeklyVWAP = computeVWAP(h1Candles, 'week');
  const vwapSignal = getVWAPSignal(currentPrice, dailyVWAP, weeklyVWAP);
  const regime = detectRegime(h1Candles, h4Candles, h1Indicators);
  if (volumeProfileRaw) {
    console.log(`[volume-profile] POC=${vpSignal.poc} HVN=[${vpSignal.nearestHVN}] VA=${vpSignal.valueAreaLow}-${vpSignal.valueAreaHigh} signal=${vpSignal.signal}`);
  }
  console.log(`[pipeline] compute phase done in ${time() - tCompute}ms`);

  // Build RAG historical context (before LLM call)
  let ragContext = { contextString: '', analysis: { hasData: false } };
  try {
    const { buildHistoricalContext } = await import('./memory/context.js');
    ragContext = await buildHistoricalContext({
      session,
      proposedDirection: null,
      threeLayer: { tier: null },
      confluenceCount: null,
      m15: { structure: smcM15?.structure, indicators: m15Indicators },
      h4: { structure: smcH4?.structure },
    });
    console.log('[pipeline] RAG context ready:', ragContext.analysis.hasData ? 'has data' : 'no data');
  } catch (err) {
    console.warn('[pipeline] RAG failed:', err.message);
  }

  // Perplexity gate: top of hour OR high-impact news within 4h
  const isTopOfHour = new Date().getUTCMinutes() < 15;
  const hasUpcomingNews = (calendar?.events || []).some(e =>
    (e.goldRelevant || String(e.impact || '').toLowerCase().includes('high')) &&
    typeof e.minutesAway === 'number' && e.minutesAway < 240
  );
  const usePerplexity = isTopOfHour || hasUpcomingNews;
  if (!usePerplexity) {
    console.log('[pipeline] skipping Perplexity — no upcoming news and not top of hour');
  }

  // Phase 3: build context + call LLM consensus
  // H1 EMA position vs current price — drives the EMA momentum-override tiering: counter-structure
  // trades the LLM flags when price sits on the opposite side of BOTH H1 EMAs from H1 structure.
  // Computed once here and shared by the 3-layer engine and the risk manager (context.h1Emas).
  const _h1Ema20 = h1Indicators?.ema20;
  const _h1Ema50 = h1Indicators?.ema50;
  const h1Emas = (currentPrice != null && _h1Ema20 != null && _h1Ema50 != null)
    ? {
        ema20: _h1Ema20,
        ema50: _h1Ema50,
        aboveEma20: currentPrice > _h1Ema20,
        aboveEma50: currentPrice > _h1Ema50,
        aboveBoth: currentPrice > _h1Ema20 && currentPrice > _h1Ema50,
        belowBoth: currentPrice < _h1Ema20 && currentPrice < _h1Ema50,
        distFromEma20: +(currentPrice - _h1Ema20).toFixed(2),
      }
    : null;

  const ctx = {
    symbol: config.SYMBOL,
    timestamp: runTimestamp,
    executionTf: config.EXECUTION_TF,
    biasTf: config.BIAS_TF,
    h1Candles, h4Candles, m15Candles, h1Indicators, h4Indicators, m15Indicators, smcH1, smcH4, smcM15,
    h1Emas,
    session, sessionLevels, dxy, currentPrice, spread, dailyHigh, dailyLow,
    marketStatus, igSentiment, fred: macro, sentiment: altSentiment, calendar,
    // HL-specific
    funding: { rate: funding, annualized: fundingAnnualized, signal: funding > 0 ? 'longs_paying' : 'shorts_paying' },
    openInterest,
    oraclePrice,
    // Layer 1 + 2 context
    weeklyMacro, volumeProfile: vpSignal, vwap: vwapSignal, regime,
    // Perplexity gate
    usePerplexity,
    // RAG historical context (consumed by prompt builder)
    ragContextString: ragContext.contextString,
    // Pre-identified key levels (Principle 6)
    keyLevels,
  };

  const tLlm = time();
  let { plan, ok: llmOk } = await generatePlan(ctx);
  console.log(`[pipeline] LLM phase done in ${time() - tLlm}ms (ok=${llmOk})`);

  // Daily candle open (24h rolling, matches the data module's open24h) for the daily-candle
  // confluence factor applied to the final plan below.
  const dailyOpen = h1Candles.slice(-24)[0]?.open ?? currentPrice;

  // Canonical context passed to both confluence and 3-layer consensus
  const threeLayerCtx = {
    currentPrice,
    h1Emas,
    h4: {
      structure: smcH4.structure,
      candles: h4Candles,
      indicators: h4Indicators,
      pd: smcH4.pd,
      bias: smcH4.structure?.bias,
      orderBlocks: splitByType(smcH4.orderBlocks),
      fvgs: splitByType(smcH4.fvgs),
    },
    h1: {
      structure: smcH1.structure,
      indicators: h1Indicators,
      pd: smcH1.pd,
      orderBlocks: splitByType(smcH1.orderBlocks),
      fvgs: splitByType(smcH1.fvgs),
      liquidity: smcH1.liquidity,
    },
    m15: smcM15 ? {
      structure: smcM15.structure,
      indicators: m15Indicators,
      orderBlocks: splitByType(smcM15.orderBlocks),
      fvgs: splitByType(smcM15.fvgs),
      liquidity: smcM15.liquidity,
      pd: smcM15.pd,
    } : null,
    session,
    dxy,
    macro,
    fred: macro,
    sentiment: altSentiment,
    calendar,
    igSentiment,
    weeklyMacro,
    volumeProfile: vpSignal,
    vwap: vwapSignal,
    regime,
    funding: { rate: funding, annualized: fundingAnnualized },
  };

  // Augment LLM confluence with deterministic checks (includes VWAP, funding, consensus)
  const detConf = computeConfluence({ ...threeLayerCtx, consensus: plan.consensus });
  if (detConf.count > (plan.confluenceCount || 0)) {
    console.log(`[confluence] deterministic=${detConf.count} > llm=${plan.confluenceCount} — upgrading`);
    plan.confluenceCount = detConf.count;
    plan.confluenceFactors = detConf.factors;
  } else {
    console.log(`[confluence] llm=${plan.confluenceCount} >= deterministic=${detConf.count} — keeping llm`);
  }

  // Daily candle direction confirms trade direction (red for short, green for long).
  // Applied here on the final plan (not inside computeConfluence, which early-returns when
  // H4≠M15) so it also lifts counter-H4 setups toward the H1-opposition override threshold.
  if (plan.direction && dailyOpen != null) {
    const dailyDir = currentPrice > dailyOpen ? 'bullish' : 'bearish';
    const dailyMatches =
      (plan.direction === 'long' && dailyDir === 'bullish') ||
      (plan.direction === 'short' && dailyDir === 'bearish');
    const factor = `Daily candle ${dailyDir} confirms ${plan.direction}`;
    if (dailyMatches && !(plan.confluenceFactors || []).includes(factor)) {
      plan.confluenceFactors = [...(plan.confluenceFactors || []), factor];
      plan.confluenceCount = (plan.confluenceCount || 0) + 1;
      console.log(`[confluence] +1 daily candle ${dailyDir} confirms ${plan.direction} → ${plan.confluenceCount}`);
    }
  }

  // Three-layer consensus (post-LLM)
  const threeLayer = await computeThreeLayerConsensus({ ...threeLayerCtx, plan }).catch(err => {
    console.warn(`[3layer] consensus failed: ${err.message}`);
    return null;
  });

  // Flat risk advertised on the plan to match execution (the executor always sizes to
  // DEFAULT_RISK_PCT). No tier/quality boost — 1% risk, 2R target, every trade.
  if (plan.risk) {
    plan.risk.suggestedRiskPct = config.DEFAULT_RISK_PCT;
    plan.risk.positionSizeHint = `${config.DEFAULT_RISK_PCT}% risk (flat per trade)`;
  }

  // Step A: M15 entry refinement — informational only, never gates execution
  const m15Structure = smcM15?.structure ?? null;
  let m15 = {
    status: 'N/A',
    reason: 'no directional plan',
    structureBias: m15Structure?.bias ?? null,
    lastEvent: m15Structure?.lastEvent ?? null,
  };
  if (plan?.direction && plan?.poi?.zone) {
    const refinement = refineEntry(plan, m15Candles, currentPrice);
    m15 = {
      status: refinement.status,
      reason: refinement.reason,
      structureBias: m15Structure?.bias ?? null,
      lastEvent: m15Structure?.lastEvent ?? null,
    };
    if (refinement.refined) {
      plan = refinement.plan;
      console.log(`[m15] ${refinement.status}: entry=${plan.entry.price.toFixed(2)} SL=${plan.stopLoss.price.toFixed(2)} (${refinement.reason})`);
    } else {
      console.log(`[m15] ${refinement.status}: ${refinement.reason}`);
    }
  } else {
    console.log(`[m15] N/A — no directional plan`);
  }
  plan.m15 = m15;

  // Merge warnings
  const extraWarnings = [
    ...(calendar?.warnings || []),
    ...buildCrossAssetWarnings({
      dxy, fred: macro, sentiment: altSentiment,
      h1Count: h1Candles.length, h4Count: h4Candles.length,
    }),
  ];
  const mergedPlan = {
    ...plan,
    warnings: [...new Set([...(plan.warnings || []), ...extraWarnings])],
  };
  mergedPlan.threeLayer = threeLayer ?? null;

  // Validate + correct SL/TP if the LLM put them on the wrong side of entry. Runs on the
  // final (post-M15-refinement) plan so Telegram, the saved plan, RAG, and the executor all
  // use the same corrected levels. The executor keeps its own guard as a backstop.
  const sltpValidation = validateAndCorrectPlanSLTP(mergedPlan, ctx);
  if (sltpValidation.corrected) {
    console.warn('[pipeline] plan SL/TP auto-corrected:', sltpValidation.reason);
    mergedPlan.warnings = [
      '⚠️ LLM produced invalid SL/TP — auto-corrected by system',
      ...(mergedPlan.warnings || []),
    ];
  }

  // Safety sweep: attach SL/TP to any open position left naked by a GTC entry that
  // filled between runs (the resting-taker model can fill outside a pipeline cycle, and
  // a "hold"/no-signal run would otherwise never protect it). Live mode only.
  if (process.env.AUTO_TRADE === 'true' && process.env.DRY_EXECUTE !== 'true' && process.env.DRY_RUN !== 'true') {
    try {
      const { protectNakedPositions } = await import('./broker/executor.js');
      const prot = await protectNakedPositions(ctx);
      if (prot.protected > 0) console.log(`[pipeline] protected ${prot.protected} naked position(s) ✅`);
    } catch (err) {
      console.warn('[pipeline] naked-position sweep failed (non-fatal):', err.message);
    }
  }

  // Step B: Auto-execution — execute immediately at market price, no POI waiting
  let execution = { executed: false, reason: 'N/A' };
  if (mergedPlan.direction) {
    if (process.env.AUTO_TRADE !== 'true') {
      execution = { executed: false, reason: 'Auto-trade disabled — manual signal' };
      console.log('[executor] AUTO_TRADE=false — signal only, no order placed');
    } else {
      console.log(`[pipeline] market order — executing immediately regardless of M15 status`);
      execution = await executeIfApproved(mergedPlan, ctx);
    }
  }
  mergedPlan.execution = {
    autoTradeEnabled: process.env.AUTO_TRADE === 'true',
    dryExecute: process.env.DRY_EXECUTE === 'true',
    m15Status: mergedPlan.m15?.status || 'N/A',
    tier: threeLayer?.tier ?? null,
    tierLabel: threeLayer?.tierLabel ?? null,
    executed: execution.executed,
    reason: execution.reason,
    orderId: execution.trade?.orderId || null,
    entry: execution.trade?.entry || null,
    size: execution.trade?.size || null,
    riskAmount: execution.trade?.riskAmount || null,
    riskPct: execution.trade?.riskPct || null,
    timestamp: execution.executed ? new Date().toISOString() : null,
  };
  console.log('[pipeline] execution merged:', JSON.stringify({
    executed: mergedPlan.execution.executed,
    orderId: mergedPlan.execution.orderId,
    entry: mergedPlan.execution.entry,
    fillSize: mergedPlan.execution.size,
    reason: mergedPlan.execution.reason,
  }, null, 2));

  // Write plan to file so dashboard can read it across processes
  try {
    const fsMod   = await import('fs');
    const cacheFile = dataPath('last-plan.json');
    fsMod.default.writeFileSync(cacheFile, JSON.stringify({
      ...mergedPlan,
      _cachedAt:     new Date().toISOString(),
      _atr:          m15Indicators?.atr                                        || 0,
      _currentPrice: currentPrice                                               || 0,
      _session:      session?.current                                           || 'unknown',
      _regime:       typeof regime === 'string' ? regime : (regime?.regime     || 'unknown'),
    }));
    console.log('[pipeline] plan saved to data/last-plan.json ✅ bias:',
                mergedPlan.bias, 'direction:', mergedPlan.direction);
  } catch (e) {
    console.warn('[pipeline] plan cache write failed:', e.message);
  }

  // RAG: persist ALL directional signals — executed or blocked (additive, non-blocking)
  if (mergedPlan.direction) {
    try {
      const { saveTrade } = await import('./memory/tradeDB.js');
      const isExecuted = execution.executed === true;
      const fillEntry = isExecuted ? (execution.trade?.entry ?? currentPrice) : currentPrice;
      const slPrice = mergedPlan.stopLoss?.price;
      saveTrade({
        orderId: isExecuted ? String(execution.trade.orderId) : `blocked_${Date.now()}`,
        openTime: new Date().toISOString(),
        closeTime: null,
        session: session?.current ?? null,
        inKillZone: session?.killZone ? 1 : 0,
        direction: mergedPlan.direction ?? null,
        entryPrice: fillEntry ?? null,
        exitPrice: null,
        h4Bias: smcH4?.structure?.bias ?? null,
        h1Bias: smcH1?.structure?.bias ?? null,
        m15Bias: smcM15?.structure?.bias ?? null,
        m15Event: smcM15?.structure?.lastEvent ?? null,
        tier: threeLayer?.tier ?? null,
        confluence: mergedPlan.confluenceCount ?? null,
        quality: mergedPlan.setupQuality ?? null,
        consensus: mergedPlan.consensus?.agreement ?? null,
        atr: m15Indicators?.atr ?? null,
        slDistance: (fillEntry != null && slPrice != null) ? Math.abs(fillEntry - slPrice) : null,
        riskPct: mergedPlan.risk?.suggestedRiskPct ?? null,
        isExecuted: isExecuted ? 1 : 0,
        blockReason: isExecuted ? null : (execution.reason || 'unknown'),
        outcome: isExecuted ? 'OPEN' : 'BLOCKED',
        rr: null,
        pnl: null,
        fees: null,
        netPnl: null,
        priceAtSignal: currentPrice ?? null,
        priceAfter15m: null,
        priceAfter1h: null,
        priceAfter4h: null,
        wouldHaveOutcome: null,
        wouldHaveRR: null,
      });
      console.log(`[rag] saved ${isExecuted ? 'executed' : 'blocked'} signal to memory`);
    } catch (err) {
      console.warn('[pipeline] RAG saveTrade failed:', err.message);
    }
  }

  // Phase 4: persist + notify
  const tWrite = time();
  let dailySummary = null;
  if (!config.DRY_RUN) {
    try {
      await savePlan(mergedPlan);
      await updateReadmeLatestPlan(mergedPlan);
      dailySummary = await updateDailySummary(runTimestamp);
    } catch (err) {
      console.warn(`[pipeline] write phase error: ${err.message}`);
    }
  } else {
    console.log('[pipeline] DRY_RUN — skipping file writes');
    dailySummary = await updateDailySummary(runTimestamp, { save: false }).catch(() => null);
  }
  console.log(`[pipeline] write phase done in ${time() - tWrite}ms`);

  const tNotify = time();
  const h4Bias = threeLayerCtx?.h4?.structure?.bias;
  const tfDirection = mergedPlan.direction ?? (
    h4Bias === 'bearish' ? 'short' :
    h4Bias === 'bullish' ? 'long' :
    null
  );
  console.log('[tf] using direction:', tfDirection,
    '(plan:', mergedPlan.direction, 'h4:', h4Bias + ')');
  const tfAlignment = tfDirection
    ? getTimeframeAlignment(threeLayerCtx, tfDirection, mergedPlan)
    : { score: 0 };
  const telegramText = formatPlanForTelegram(mergedPlan, {
    dxy, sentiment: altSentiment, fred: macro, calendar, session,
    igSentiment, currentPrice, spread, marketStatus, dailySummary,
    funding, fundingAnnualized, openInterest, oraclePrice,
    m15Indicators, keyLevels, tfAlignment,
  });
  console.log(`[telegram] SENDING NOW (bias=${mergedPlan.bias} setup=${mergedPlan.setupQuality} dryRun=${config.DRY_RUN})`);
  await sendTelegramMessage(telegramText);
  console.log(`[pipeline] notify phase done in ${time() - tNotify}ms`);

  console.log(`=== run complete in ${time() - tTotal}ms ===\n`);
  return { plan: mergedPlan, telegramText };
}

let pipelineRunning = false;
let lastRunTime = 0;
const MIN_RUN_INTERVAL_MS = 60 * 1000; // minimum 60s between runs

export async function runPipeline() {
  const now = Date.now();
  if (pipelineRunning) {
    console.warn('[pipeline] already running — skipping (prevents duplicate orders)');
    return null;
  }
  if (now - lastRunTime < MIN_RUN_INTERVAL_MS) {
    console.warn(`[pipeline] too soon — last run ${Math.round((now - lastRunTime) / 1000)}s ago (min 60s)`);
    return null;
  }

  pipelineRunning = true;
  lastRunTime = now;
  try {
    return await runFullPipeline();
  } finally {
    pipelineRunning = false;
  }
}
