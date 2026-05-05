import fs from 'node:fs/promises';
import path from 'node:path';

import { config, configIsFull } from './config.js';
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

import { generatePlan } from './llm/client.js';
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

function resolveRunMode() {
  if (process.env.RUN_MODE === 'full') return 'full';
  if (process.env.RUN_MODE === 'quick') return 'quick';
  if (process.argv.includes('--quick')) return 'quick';
  if (process.argv.includes('--full') || process.argv.includes('--force')) return 'full';
  const minute = new Date().getUTCMinutes();
  return minute < 10 ? 'full' : 'quick';
}

async function loadMostRecentPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.resolve('plans', today);
  try {
    const files = (await fs.readdir(dir))
      .filter(f => /^\d{2}\.json$/.test(f))
      .sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1];
    const raw = await fs.readFile(path.join(dir, latest), 'utf8');
    return { plan: JSON.parse(raw), filePath: path.join(dir, latest) };
  } catch {
    return null;
  }
}

// QUICK run: outcome resolution + M15 confirmation check on the most recent pending plan.
async function runQuickPipeline() {
  const tTotal = time();
  const runTimestamp = new Date().toISOString();
  console.log(`\n=== XAUUSD Agent QUICK run @ ${runTimestamp} ===`);
  console.log(`mode=quick dryRun=${config.DRY_RUN}`);

  // Phase 1: HL fetch
  const hlData = await fetchAllHLData();
  if (!hlData.h1Candles?.length) {
    console.log('[quick] no H1 candles — skipping silently');
    return { mode: 'quick', skipped: true };
  }

  // Phase 2: outcome resolution
  await resolveOpenTrades(hlData.h1Candles).catch(err =>
    console.warn(`[outcome] resolution error: ${err.message}`)
  );

  // Phase 3: M15 confirmation check on the most recent pending plan
  const recent = await loadMostRecentPlan();
  if (!recent?.plan?.direction) {
    console.log('[quick] no pending directional plan — done');
    return { mode: 'quick', updated: false };
  }
  const prevM15Status = recent.plan.m15?.status ?? null;

  const quickM15Candles = hlData.m15Candles || [];
  const quickCurrentPrice = hlData.currentPrice;

  const refinement = refineEntry(recent.plan, quickM15Candles, quickCurrentPrice);
  console.log(`[m15] ${refinement.status}: ${refinement.reason}`);

  let stateChanged = false;
  if (refinement.refined && prevM15Status !== 'CONFIRMED') {
    stateChanged = true;
    const refinedPlan = { ...refinement.plan, m15: { status: 'CONFIRMED', reason: refinement.reason } };
    await fs.writeFile(recent.filePath, JSON.stringify(refinedPlan, null, 2));
    console.log(`[quick] M15 CONFIRMED — plan updated at ${recent.filePath}`);

    if (config.AUTO_TRADE) {
      const exec = await executeIfApproved(refinedPlan, { ...hlData, calendar: null });
      console.log(`[executor] ${exec.executed ? 'EXECUTED' : 'BLOCKED'} — ${exec.reason}`);
    }

    if (!config.DRY_RUN) {
      await sendTelegramMessage(
        `🎯 <b>M15 confirmation</b>\n` +
        `${recent.plan.direction.toUpperCase()} @ $${refinement.plan.entry.price.toFixed(2)}\n` +
        `SL: $${refinement.plan.stopLoss.price.toFixed(2)}\n` +
        `<i>${refinement.reason}</i>`
      );
    }
  }

  console.log(`=== quick run complete in ${time() - tTotal}ms (stateChanged=${stateChanged}) ===\n`);
  return { mode: 'quick', updated: stateChanged };
}

// FULL run: complete pipeline with LLM analysis + three-layer consensus + execution.
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

  // Phase 2: indicators + SMC (H4=bias, H1=context, M15=primary signal)
  const tCompute = time();
  const h1Indicators = computeClassicalIndicators(h1Candles);
  const h4Indicators = computeClassicalIndicators(h4Candles);
  const m15Indicators = m15Candles.length >= 14 ? computeClassicalIndicators(m15Candles) : null;
  const smcH1 = smcForTimeframe(h1Candles, 5);
  const smcH4 = smcForTimeframe(h4Candles, 3);
  const smcM15 = m15Candles.length >= 10 ? smcForTimeframe(m15Candles, 3) : null;
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

  // Phase 3: build context + call LLM consensus
  const ctx = {
    symbol: config.SYMBOL,
    timestamp: runTimestamp,
    executionTf: config.EXECUTION_TF,
    biasTf: config.BIAS_TF,
    h1Candles, h4Candles, m15Candles, h1Indicators, h4Indicators, m15Indicators, smcH1, smcH4, smcM15,
    session, sessionLevels, dxy, currentPrice, spread, dailyHigh, dailyLow,
    marketStatus, igSentiment, fred: macro, sentiment: altSentiment, calendar,
    // HL-specific
    funding: { rate: funding, annualized: fundingAnnualized, signal: funding > 0 ? 'longs_paying' : 'shorts_paying' },
    openInterest,
    oraclePrice,
    // Layer 1 + 2 context
    weeklyMacro, volumeProfile: vpSignal, vwap: vwapSignal, regime,
  };

  const tLlm = time();
  let { plan, ok: llmOk } = await generatePlan(ctx);
  console.log(`[pipeline] LLM phase done in ${time() - tLlm}ms (ok=${llmOk})`);

  // Three-layer consensus (post-LLM)
  const threeLayer = await computeThreeLayerConsensus({
    weeklyMacro, smcH4, smcH1,
    volumeProfile: vpSignal, vwap: vwapSignal, regime,
    plan, currentPrice,
  }).catch(err => {
    console.warn(`[3layer] consensus failed: ${err.message}`);
    return null;
  });

  if (threeLayer?.tier === 1 && plan.risk) {
    plan.risk.suggestedRiskPct = Math.min(1.5, (plan.risk.suggestedRiskPct || 1) * 1.5);
    plan.risk.positionSizeHint = 'Tier 1 — 1.5% risk (all layers strongly aligned)';
  }

  // Step A: M15 entry refinement
  let m15 = { status: 'N/A', reason: 'no directional plan' };
  if (plan?.direction && plan?.poi?.zone) {
    const refinement = refineEntry(plan, m15Candles, currentPrice);
    m15 = { status: refinement.status, reason: refinement.reason };
    if (refinement.refined) {
      plan = refinement.plan;
      console.log(`[m15] CONFIRMED: entry=${plan.entry.price.toFixed(2)} SL=${plan.stopLoss.price.toFixed(2)} (${refinement.reason})`);
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

  // Step B: Auto-execution
  let execution = { executed: false, reason: 'N/A' };
  if (mergedPlan.direction) {
    if (!config.AUTO_TRADE) {
      execution = { executed: false, reason: 'Auto-trade disabled — manual signal' };
      console.log('[executor] AUTO_TRADE=false — signal only, no order placed');
    } else if (mergedPlan.m15?.status === 'CONFIRMED' || mergedPlan.entry?.trigger === 'limit') {
      execution = await executeIfApproved(mergedPlan, ctx);
    } else {
      execution = { executed: false, reason: 'Awaiting M15 confirmation' };
      console.log(`[executor] awaiting M15 confirmation (current status=${mergedPlan.m15?.status})`);
    }
  }
  mergedPlan.execution = {
    autoTradeEnabled: !!config.AUTO_TRADE,
    dryExecute: !!config.DRY_EXECUTE,
    m15Status: mergedPlan.m15?.status || 'N/A',
    tier: threeLayer?.tier ?? null,
    tierLabel: threeLayer?.tierLabel ?? null,
    executed: execution.executed,
    reason: execution.reason,
    orderId: execution.trade?.orderId || null,
    size: execution.trade?.size || null,
    riskAmount: execution.trade?.riskAmount || null,
    riskPct: execution.trade?.riskPct || null,
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
    dxy, sentiment: altSentiment, fred: macro, calendar, session,
    igSentiment, currentPrice, spread, marketStatus, dailySummary,
    funding, fundingAnnualized, openInterest, oraclePrice,
  });
  console.log(`[telegram] SENDING NOW (bias=${mergedPlan.bias} setup=${mergedPlan.setupQuality} dryRun=${config.DRY_RUN})`);
  await sendTelegramMessage(telegramText);
  console.log(`[pipeline] notify phase done in ${time() - tNotify}ms`);

  console.log(`=== run complete in ${time() - tTotal}ms ===\n`);
  return { plan: mergedPlan, telegramText };
}

export async function runPipeline() {
  const mode = resolveRunMode();
  if (mode === 'quick') return runQuickPipeline();
  return runFullPipeline();
}
