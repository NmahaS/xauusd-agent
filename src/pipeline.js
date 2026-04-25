import { config, configIsFull } from './config.js';
import { fetchXauBothTimeframes } from './data/twelvedata.js';
import { fetchDxy } from './data/dxy.js';
import { fetchMetals } from './data/metals.js';
import { fetchFredMacro } from './data/fred.js';
import { fetchSentiment } from './data/sentiment.js';
import { fetchCalendar } from './data/calendar.js';

import { computeClassicalIndicators } from './indicators/classical.js';
import { detectSession, computeSessionLevels } from './indicators/session.js';

import { analyzeStructure } from './smc/structure.js';
import { detectFVGs } from './smc/fvg.js';
import { detectOrderBlocks } from './smc/orderBlocks.js';
import { detectLiquidity } from './smc/liquidity.js';
import { computePremiumDiscount } from './smc/premiumDiscount.js';

import { generatePlan } from './llm/client.js';
import { savePlan, updateReadmeLatestPlan } from './plan/writer.js';
import { resolveOpenTrades } from './plan/outcomeTracker.js';
import { updateDailySummary } from './plan/tracker.js';
import { formatPlanForTelegram } from './plan/formatter.js';
import { sendTelegramMessage } from './telegram/notify.js';

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

function buildCrossAssetWarnings({ dxy, metals, fred, sentiment }) {
  const warnings = [];
  if (!dxy?.ok) warnings.push('DXY data unavailable — cross-asset context reduced');
  if (!metals?.ok) warnings.push('Spot metals unavailable — Au/Ag & Au/Pt ratios missing');
  if (!fred?.ok) warnings.push('FRED macro data unavailable — yields/real-rate missing');
  if (!sentiment?.ok) warnings.push('Fear & Greed unavailable');
  if (metals?.auAg != null && metals.auAg > 90) {
    warnings.push(`Au/Ag ratio elevated (${metals.auAg.toFixed(1)}) — gold extended vs silver`);
  }
  if (metals?.spotVsChartPct != null && Math.abs(metals.spotVsChartPct) > 2.0) {
    warnings.push(`Spot/chart gap ${metals.spotVsChartPct.toFixed(2)}% (normal during volatile sessions)`);
  }
  return warnings;
}

export async function runPipeline() {
  if (!configIsFull) {
    throw new Error(
      'Pipeline config incomplete — TWELVEDATA_API_KEY and DEEPSEEK_API_KEY are required. See [config] warnings above.'
    );
  }

  const tTotal = time();
  const runTimestamp = new Date().toISOString();

  console.log(`\n=== XAUUSD Agent run @ ${runTimestamp} ===`);
  console.log(`symbol=${config.SYMBOL} exec=${config.EXECUTION_TF} bias=${config.BIAS_TF} dryRun=${config.DRY_RUN}`);

  // Phase 1: parallel fetch of all data sources (silver now comes exclusively from metals.js)
  const tFetch = time();
  const [xauResult, dxyResult, metalsResult, fredResult, sentimentResult, calendarResult] = await Promise.all([
    fetchXauBothTimeframes(),
    fetchDxy(),
    fetchMetals().catch(err => ({ ok: false, error: err.message })),
    fetchFredMacro(),
    fetchSentiment(),
    fetchCalendar(),
  ]);
  console.log(`[pipeline] fetch phase done in ${time() - tFetch}ms`);

  const h1Candles = xauResult.h1.candles;
  const h4Candles = xauResult.h4.candles;

  if (!h1Candles.length || !h4Candles.length) {
    console.error('[pipeline] FATAL: no XAU candles fetched; cannot continue');
    throw new Error('No XAU candles — aborting run');
  }

  // Resolve open trades from prior plans before computing new indicators
  await resolveOpenTrades(h1Candles).catch(err =>
    console.warn(`[outcome] resolution error: ${err.message}`)
  );

  // Refresh spot vs chart gap now that we have chart prices
  let metals = metalsResult;
  if (metals?.ok && h1Candles.length > 0) {
    const chartGold = h1Candles[h1Candles.length - 1].close;
    const diff = metals.gold - chartGold;
    const gapPct = (diff / chartGold) * 100;
    metals = {
      ...metals,
      spotVsChart: diff,
      spotVsChartPct: gapPct,
    };
    console.log(`[metals] Spot/chart gap ${gapPct.toFixed(2)}% (normal during volatile sessions)`);
  }

  // Phase 2: indicators + SMC
  const tCompute = time();
  const h1Indicators = computeClassicalIndicators(h1Candles);
  const h4Indicators = computeClassicalIndicators(h4Candles);
  const smcH1 = smcForTimeframe(h1Candles, 5);
  const smcH4 = smcForTimeframe(h4Candles, 3);
  const session = detectSession();
  const sessionLevels = computeSessionLevels(h1Candles);
  console.log(`[pipeline] compute phase done in ${time() - tCompute}ms`);

  // Phase 3: build context + call LLM
  const ctx = {
    symbol: config.SYMBOL,
    timestamp: runTimestamp,
    executionTf: config.EXECUTION_TF,
    biasTf: config.BIAS_TF,
    h1Candles,
    h4Candles,
    h1Indicators,
    h4Indicators,
    smcH1,
    smcH4,
    session,
    sessionLevels,
    dxy: dxyResult,
    metals,
    fred: fredResult,
    sentiment: sentimentResult,
    calendar: calendarResult,
  };

  const tLlm = time();
  const { plan, ok: llmOk } = await generatePlan(ctx);
  console.log(`[pipeline] LLM phase done in ${time() - tLlm}ms (ok=${llmOk})`);

  // Merge warnings from calendar + cross-asset into the plan
  const extraWarnings = [
    ...(calendarResult?.warnings || []),
    ...buildCrossAssetWarnings({ dxy: dxyResult, metals, fred: fredResult, sentiment: sentimentResult }),
  ];
  const mergedPlan = {
    ...plan,
    warnings: [...new Set([...(plan.warnings || []), ...extraWarnings])],
  };

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
    // Still compute summary from any plans already on disk (for footer preview)
    dailySummary = await updateDailySummary(runTimestamp, { save: false }).catch(() => null);
  }
  console.log(`[pipeline] write phase done in ${time() - tWrite}ms`);

  const tNotify = time();
  const telegramText = formatPlanForTelegram(mergedPlan, {
    dxy: dxyResult,
    metals,
    sentiment: sentimentResult,
    fred: fredResult,
    calendar: calendarResult,
    session,
    dailySummary,
  });
  console.log(`[telegram] SENDING NOW (bias=${mergedPlan.bias} setup=${mergedPlan.setupQuality} dryRun=${config.DRY_RUN})`);
  await sendTelegramMessage(telegramText);
  console.log(`[pipeline] notify phase done in ${time() - tNotify}ms`);

  console.log(`=== run complete in ${time() - tTotal}ms ===\n`);
  return { plan: mergedPlan, telegramText };
}
