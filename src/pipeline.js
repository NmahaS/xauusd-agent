import fs from 'node:fs/promises';
import path from 'node:path';

import { config, configIsFull } from './config.js';
import { fetchAllIGData, IG_ENV } from './data/ig.js';
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

// Run mode resolution. The hourly cron may eventually fire every 15 min; in that case
// the first run of each hour (minute 0-9) does the full pipeline, the other three only
// monitor positions and check M15 confirmation. Override via RUN_MODE env or --quick CLI.
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
// No LLM calls — costs $0. Sends Telegram only when state changes (M15 confirmed,
// SL/TP hit). Otherwise silent.
async function runQuickPipeline() {
  const tTotal = time();
  const runTimestamp = new Date().toISOString();
  console.log(`\n=== XAUUSD Agent QUICK run @ ${runTimestamp} ===`);
  console.log(`mode=quick env=${IG_ENV} dryRun=${config.DRY_RUN}`);

  // Phase 1: IG fetch only (no macro/sentiment/calendar — saves a second)
  const igData = await fetchAllIGData();
  if (!igData.h1Candles?.length) {
    console.log('[quick] no H1 candles — skipping silently');
    return { mode: 'quick', skipped: true };
  }

  // Phase 2: outcome resolution
  await resolveOpenTrades(igData.h1Candles).catch(err =>
    console.warn(`[outcome] resolution error: ${err.message}`)
  );

  // Phase 3: M15 confirmation check on the most recent pending plan
  const recent = await loadMostRecentPlan();
  if (!recent?.plan?.direction) {
    console.log('[quick] no pending directional plan — done');
    return { mode: 'quick', updated: false };
  }
  const prevM15Status = recent.plan.m15?.status ?? null;

  const refinement = await refineEntry(
    recent.plan,
    igData.h1Candles,
    igData.session,
    igData.goldEpic,
    igData.goldDivisor,
  );
  console.log(`[m15] ${refinement.status}: ${refinement.reason}`);

  let stateChanged = false;
  if (refinement.refined && prevM15Status !== 'CONFIRMED') {
    stateChanged = true;
    const refinedPlan = { ...refinement.plan, m15: { status: 'CONFIRMED', reason: refinement.reason } };
    await fs.writeFile(recent.filePath, JSON.stringify(refinedPlan, null, 2));
    console.log(`[quick] M15 CONFIRMED — plan updated at ${recent.filePath}`);

    // Try execution if AUTO_TRADE is on
    if (config.AUTO_TRADE) {
      const exec = await executeIfApproved(refinedPlan, { ...igData, calendar: null }, igData.session);
      console.log(`[executor] ${exec.executed ? 'EXECUTED' : 'BLOCKED'} — ${exec.reason}`);
    }

    if (!config.DRY_RUN) {
      await sendTelegramMessage(
        `🎯 <b>M15 confirmation</b>\n` +
        `${recent.plan.direction.toUpperCase()} @ ${refinement.plan.entry.price.toFixed(2)}\n` +
        `SL: ${refinement.plan.stopLoss.price.toFixed(2)}\n` +
        `<i>${refinement.reason}</i>`
      );
    }
  }

  console.log(`=== quick run complete in ${time() - tTotal}ms (stateChanged=${stateChanged}) ===\n`);
  return { mode: 'quick', updated: stateChanged };
}

// FULL run: existing behavior + Step A (M15 refinement) + Step B (auto-execute).
async function runFullPipeline() {
  if (!configIsFull) {
    throw new Error(
      'Pipeline config incomplete — IG, ANTHROPIC, and DEEPSEEK credentials are required. See [config] warnings above.'
    );
  }

  const tTotal = time();
  const runTimestamp = new Date().toISOString();

  console.log(`\n=== XAUUSD Agent run @ ${runTimestamp} ===`);
  console.log(
    `symbol=${config.SYMBOL} exec=${config.EXECUTION_TF} bias=${config.BIAS_TF} ` +
    `env=${IG_ENV} dryRun=${config.DRY_RUN} autoTrade=${config.AUTO_TRADE} dryExecute=${config.DRY_EXECUTE}`
  );

  // Phase 1: parallel fetch
  const tFetch = time();
  const [igData, macro, altSentiment, calendar] = await Promise.all([
    fetchAllIGData(),
    fetchMacroData(config.FRED_API_KEY),
    fetchSentiment(),
    fetchEconomicCalendar(),
  ]);

  const {
    h1Candles, h4Candles, currentPrice, spread, marketStatus, igSentiment, dxy,
    dailyHigh, dailyLow, goldEpic, goldDivisor, session: igSession,
  } = igData;
  console.log(`[pipeline] fetch phase done in ${time() - tFetch}ms`);

  if (h1Candles.length === 0) {
    console.error('[pipeline] no usable gold candles from IG — sending alert and exiting');
    const alert =
      `⚠️ <b>XAUUSD Agent [${IG_ENV}]</b>\n` +
      `Cannot fetch gold prices — no valid IG epic found.\n` +
      `Enable <code>CS.D.CFDGOLD.CFD.IP</code> on your IG account.`;
    try { await sendTelegramMessage(alert); }
    catch (e) { console.error(`[pipeline] alert send failed: ${e.message}`); }
    return { plan: null, telegramText: alert, skipped: true };
  }

  if (h4Candles.length === 0) {
    console.warn('[pipeline] no H4 candles — H4 SMC will be empty, continuing with H1 only');
  }
  if (h1Candles.length < 50 || h4Candles.length < 50) {
    console.warn(`[pipeline] reduced history: H1=${h1Candles.length} H4=${h4Candles.length} — continuing with degraded analysis`);
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

  // Phase 3: build context + call LLM consensus
  const ctx = {
    symbol: config.SYMBOL,
    timestamp: runTimestamp,
    executionTf: config.EXECUTION_TF,
    biasTf: config.BIAS_TF,
    h1Candles, h4Candles, h1Indicators, h4Indicators, smcH1, smcH4,
    session, sessionLevels, dxy, currentPrice, spread, dailyHigh, dailyLow,
    marketStatus, igSentiment, fred: macro, sentiment: altSentiment, calendar,
    goldEpic, goldDivisor,
  };

  const tLlm = time();
  let { plan, ok: llmOk } = await generatePlan(ctx);
  console.log(`[pipeline] LLM phase done in ${time() - tLlm}ms (ok=${llmOk})`);

  // ── Step A: M15 entry refinement ───────────────────────────────────────────
  let m15 = { status: 'N/A', reason: 'no directional plan' };
  if (plan?.direction && plan?.poi?.zone && igSession && goldEpic) {
    const refinement = await refineEntry(plan, h1Candles, igSession, goldEpic, goldDivisor);
    m15 = { status: refinement.status, reason: refinement.reason };
    if (refinement.refined) {
      plan = refinement.plan;
      console.log(`[m15] CONFIRMED: entry=${plan.entry.price.toFixed(2)} SL=${plan.stopLoss.price.toFixed(2)} (${refinement.reason})`);
    } else {
      console.log(`[m15] ${refinement.status}: ${refinement.reason}`);
    }
  } else {
    console.log(`[m15] N/A — ${plan?.direction ? 'missing context' : 'no directional plan'}`);
  }
  plan.m15 = m15;

  // Merge warnings (calendar + cross-asset)
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

  // ── Step B: Auto-execution ─────────────────────────────────────────────────
  let execution = { executed: false, reason: 'N/A' };
  if (mergedPlan.direction) {
    if (!config.AUTO_TRADE) {
      execution = { executed: false, reason: 'Auto-trade disabled — manual signal' };
      console.log('[executor] AUTO_TRADE=false — signal only, no order placed');
    } else if (mergedPlan.m15?.status === 'CONFIRMED' || mergedPlan.entry?.trigger === 'limit') {
      execution = await executeIfApproved(mergedPlan, { ...ctx, goldEpic, goldDivisor }, igSession);
    } else {
      execution = { executed: false, reason: 'Awaiting M15 confirmation' };
      console.log(`[executor] awaiting M15 confirmation (current status=${mergedPlan.m15?.status})`);
    }
  }
  mergedPlan.execution = {
    autoTradeEnabled: !!config.AUTO_TRADE,
    dryExecute: !!config.DRY_EXECUTE,
    m15Status: mergedPlan.m15?.status || 'N/A',
    executed: execution.executed,
    reason: execution.reason,
    dealId: execution.trade?.dealId || null,
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
