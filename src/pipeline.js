import { config, configIsFull } from './config.js';
import { fetchAllIGData } from './data/ig.js';
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

function buildCrossAssetWarnings({ dxy, fred, sentiment, marketStatus, spread, h1Count, h4Count }) {
  const warnings = [];
  if (!dxy?.ok) warnings.push('DXY proxy unavailable — cross-asset context reduced');
  if (!fred?.ok) warnings.push('FRED macro data unavailable — yields/real-rate missing');
  if (!sentiment?.ok) warnings.push('Fear & Greed unavailable');
  if (marketStatus === 'EDITS_ONLY') {
    warnings.push('IG market status EDITS_ONLY — pre-open / closed window. Data is valid; execution restricted until open.');
  } else if (marketStatus && marketStatus !== 'TRADEABLE') {
    warnings.push(`IG market status: ${marketStatus} — execution may be restricted`);
  }
  if (spread != null && spread > 0.5) {
    warnings.push(`Wide IG spread (${spread.toFixed(2)}) — confirm before market orders`);
  }
  if (h1Count != null && h1Count < 50) {
    warnings.push(`Limited history (${h1Count} H1 / ${h4Count} H4 candles) — SMC and indicators degraded`);
  }
  return warnings;
}

export async function runPipeline() {
  if (!configIsFull) {
    throw new Error(
      'Pipeline config incomplete — IG and DEEPSEEK credentials are required. See [config] warnings above.'
    );
  }

  const tTotal = time();
  const runTimestamp = new Date().toISOString();

  console.log(`\n=== XAUUSD Agent run @ ${runTimestamp} ===`);
  console.log(`symbol=${config.SYMBOL} exec=${config.EXECUTION_TF} bias=${config.BIAS_TF} dryRun=${config.DRY_RUN}`);

  // Phase 1: parallel fetch — IG (price/candles/sentiment/dxy) + macro + alt-sentiment + calendar
  const tFetch = time();
  const [igData, macro, altSentiment, calendar] = await Promise.all([
    fetchAllIGData(),
    fetchMacroData(config.FRED_API_KEY),
    fetchSentiment(),
    fetchEconomicCalendar(),
  ]);

  const { h1Candles, h4Candles, currentPrice, spread, marketStatus, igSentiment, dxy, dailyHigh, dailyLow } = igData;
  console.log(`[pipeline] fetch phase done in ${time() - tFetch}ms`);

  if (h1Candles.length < 50 || h4Candles.length < 50) {
    console.warn(
      `[pipeline] reduced history: H1=${h1Candles.length} H4=${h4Candles.length} — continuing with degraded analysis`
    );
  }
  if (h1Candles.length === 0 || h4Candles.length === 0) {
    console.error('[pipeline] FATAL: no XAU candles fetched from IG; cannot continue');
    throw new Error('No XAU candles — aborting run');
  }

  // Resolve open trades from prior plans before computing new indicators
  await resolveOpenTrades(h1Candles).catch(err =>
    console.warn(`[outcome] resolution error: ${err.message}`)
  );

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
    dxy,
    currentPrice,
    spread,
    dailyHigh,
    dailyLow,
    marketStatus,
    igSentiment,
    fred: macro,
    sentiment: altSentiment,
    calendar,
  };

  const tLlm = time();
  const { plan, ok: llmOk } = await generatePlan(ctx);
  console.log(`[pipeline] LLM phase done in ${time() - tLlm}ms (ok=${llmOk})`);

  // Merge warnings from calendar + cross-asset into the plan
  const extraWarnings = [
    ...(calendar?.warnings || []),
    ...buildCrossAssetWarnings({
      dxy, fred: macro, sentiment: altSentiment, marketStatus, spread,
      h1Count: h1Candles.length, h4Count: h4Candles.length,
    }),
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
    dailySummary = await updateDailySummary(runTimestamp, { save: false }).catch(() => null);
  }
  console.log(`[pipeline] write phase done in ${time() - tWrite}ms`);

  const tNotify = time();
  const telegramText = formatPlanForTelegram(mergedPlan, {
    dxy,
    sentiment: altSentiment,
    fred: macro,
    calendar,
    session,
    igSentiment,
    currentPrice,
    spread,
    marketStatus,
    dailySummary,
  });
  console.log(`[telegram] SENDING NOW (bias=${mergedPlan.bias} setup=${mergedPlan.setupQuality} dryRun=${config.DRY_RUN})`);
  await sendTelegramMessage(telegramText);
  console.log(`[pipeline] notify phase done in ${time() - tNotify}ms`);

  console.log(`=== run complete in ${time() - tTotal}ms ===\n`);
  return { plan: mergedPlan, telegramText };
}
