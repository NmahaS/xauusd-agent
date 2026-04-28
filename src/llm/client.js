import { config } from '../config.js';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from './prompt.js';
import { tradingPlanSchema } from '../plan/schema.js';
import { askClaude } from './providers/claude.js';
import { askDeepSeek } from './providers/deepseek.js';
import { askPerplexity } from './providers/perplexity.js';
import { buildConsensus } from './consensus.js';

// Defensive normalization that runs before Zod validation. Each LLM has its own quirks
// (string prices, alternate TP labels, missing fields). This shapes the raw output into
// something the schema will accept; if that's impossible (no entry on a directional plan),
// it downgrades the plan to no-trade rather than failing validation outright.
export function sanitizePlan(p) {
  p = p?.tradingPlan || p?.plan || p?.result || p;
  if (!p || typeof p !== 'object') return p;

  if (p.poi?.zone && Array.isArray(p.poi.zone)) {
    p.poi.zone = p.poi.zone.map(v => parseFloat(String(v)));
    if (p.poi.zone.some(isNaN)) p.poi = null;
  }
  if (p.entry) {
    p.entry.price = parseFloat(String(p.entry.price || 0));
    if (!['limit', 'marketOnConfirmation'].includes(p.entry.trigger)) p.entry.trigger = 'marketOnConfirmation';
    if (!p.entry.confirmation) p.entry.confirmation = 'Price action confirmation at POI';
  }
  if (p.stopLoss) {
    p.stopLoss.price = parseFloat(String(p.stopLoss.price || 0));
    p.stopLoss.pips = parseFloat(String(p.stopLoss.pips || 0));
    if (!p.stopLoss.reasoning) p.stopLoss.reasoning = 'Below/above structure';
  }
  if (Array.isArray(p.takeProfits)) {
    const labels = ['TP1', 'TP2', 'TP3'];
    p.takeProfits = p.takeProfits.map((tp, i) => ({
      level: String(tp?.level || '').replace(/\s+/g, '').toUpperCase() || labels[i],
      price: parseFloat(String(tp?.price || 0)),
      rr: parseFloat(String(tp?.rr || 0)),
      reasoning: tp?.reasoning || '',
    })).filter(tp => tp.price > 0);
    if (p.takeProfits.length === 0) p.takeProfits = null;
  }
  if (p.invalidation?.price) p.invalidation.price = parseFloat(String(p.invalidation.price));

  if (!p.session || typeof p.session === 'string') {
    p.session = {
      current: 'unknown',
      recommendedExecutionWindow: typeof p.session === 'string' ? p.session : 'N/A',
    };
  }
  if (!['asia', 'london', 'ny', 'off', 'unknown'].includes(p.session.current)) p.session.current = 'unknown';

  if (!p.risk || typeof p.risk !== 'object') p.risk = { suggestedRiskPct: 1, positionSizeHint: '1% risk' };
  p.risk.suggestedRiskPct = parseFloat(String(p.risk.suggestedRiskPct || 1)) || 1;

  if (typeof p.warnings === 'string') p.warnings = [p.warnings];
  if (!Array.isArray(p.warnings)) p.warnings = [];
  if (!Array.isArray(p.confluenceFactors)) p.confluenceFactors = [];
  if (typeof p.confluenceCount !== 'number') p.confluenceCount = p.confluenceFactors.length;
  if (!p.macroContext) p.macroContext = '';
  if (!p.biasReasoning) p.biasReasoning = '';
  if (!p.promptVersion) p.promptVersion = 'v3.0';

  // If LLM claims a direction but didn't deliver entry/SL/TP, downgrade to no-trade
  if (p.direction && (!p.entry?.price || !p.stopLoss?.price || !Array.isArray(p.takeProfits) || p.takeProfits.length === 0)) {
    p.direction = null;
    p.setupQuality = 'no-trade';
    p.poi = null; p.entry = null; p.stopLoss = null; p.takeProfits = null; p.invalidation = null;
  }

  return p;
}

function validatePlan(raw, label) {
  const sanitized = sanitizePlan(raw);
  return tradingPlanSchema.parse(sanitized);
}

function fallbackNoTradePlan(ctx, error) {
  return {
    timestamp: ctx.timestamp,
    symbol: ctx.symbol,
    timeframe: ctx.executionTf,
    bias: 'neutral',
    biasReasoning: 'All LLMs failed — fallback no-trade plan returned.',
    setupQuality: 'no-trade',
    confluenceCount: 0,
    confluenceFactors: [],
    direction: null,
    poi: null,
    entry: null,
    stopLoss: null,
    takeProfits: null,
    invalidation: null,
    session: {
      current: ctx.session?.current ?? 'unknown',
      recommendedExecutionWindow: ctx.session?.recommendedWindow ?? 'unknown',
    },
    risk: { suggestedRiskPct: 0, positionSizeHint: 'n/a (no-trade)' },
    macroContext: 'LLM consensus failed.',
    warnings: [`All LLMs failed: ${error}`],
    promptVersion: PROMPT_VERSION,
    consensus: {
      agreement: 'all_failed',
      confidence: 'none',
      claudeDirection: null,
      deepseekDirection: null,
      claudeQuality: 'failed',
      deepseekQuality: 'failed',
      newsRisk: null,
      newsSentiment: null,
      newsHeadline: null,
    },
  };
}

// Calls Claude + DeepSeek in parallel, optionally Perplexity (only when calendar has events
// AND key set), and combines into a consensus plan via src/llm/consensus.js.
export async function askLLM(ctx) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(ctx);

  const [claudeResult, deepseekResult] = await Promise.allSettled([
    askClaude(systemPrompt, userPrompt),
    askDeepSeek(systemPrompt, userPrompt),
  ]);

  let claudePlan = null;
  let deepseekPlan = null;
  let claudeUsage = null;
  let deepseekUsage = null;

  if (claudeResult.status === 'fulfilled') {
    claudeUsage = claudeResult.value.__usage ?? null;
    try {
      claudePlan = validatePlan(claudeResult.value, 'claude');
    } catch (err) {
      console.warn(`[claude] schema invalid: ${err.message}`);
    }
  } else {
    console.warn(`[claude] failed: ${claudeResult.reason?.message ?? claudeResult.reason}`);
  }

  if (deepseekResult.status === 'fulfilled') {
    deepseekUsage = deepseekResult.value.__usage ?? null;
    try {
      deepseekPlan = validatePlan(deepseekResult.value, 'deepseek');
    } catch (err) {
      console.warn(`[deepseek] schema invalid: ${err.message}`);
    }
  } else {
    console.warn(`[deepseek] failed: ${deepseekResult.reason?.message ?? deepseekResult.reason}`);
  }

  // Perplexity only fires when calendar has upcoming events AND we have a key — saves cost.
  let news = null;
  let perplexityUsage = null;
  if (config.PERPLEXITY_API_KEY && Array.isArray(ctx.calendar?.events) && ctx.calendar.events.length > 0) {
    const refBias = (claudePlan?.bias ?? deepseekPlan?.bias) || 'neutral';
    news = await askPerplexity(ctx.currentPrice ?? 'unknown', ctx.calendar.events, refBias);
    perplexityUsage = news.__usage ?? null;
  } else if (!config.PERPLEXITY_API_KEY) {
    console.log('[perplexity] skipped — no API key');
  } else {
    console.log('[perplexity] skipped — no upcoming calendar events');
  }

  let plan;
  if (claudePlan || deepseekPlan) {
    plan = buildConsensus(claudePlan, deepseekPlan, news);
  } else {
    plan = fallbackNoTradePlan(ctx, 'all LLMs failed validation');
    console.log('[consensus] result: all_failed none → no-trade');
    return { ok: false, plan, rawContent: null };
  }

  console.log(`[consensus] result: ${plan.consensus.agreement} ${plan.consensus.confidence} → ${plan.direction || 'no-trade'}`);

  const claudeCost = claudeUsage?.cost ?? 0;
  const deepseekCost = deepseekUsage?.cost ?? 0;
  const perplexityCost = perplexityUsage?.cost ?? 0;
  const total = claudeCost + deepseekCost + perplexityCost;
  console.log(
    `[cost] Claude ~$${claudeCost.toFixed(4)} | DeepSeek ~$${deepseekCost.toFixed(4)} | ` +
    `Perplexity ~$${perplexityCost.toFixed(4)} | Total ~$${total.toFixed(4)}`
  );

  return { ok: true, plan, rawContent: null };
}

// Backwards-compat alias used by pipeline.js (existing code imports generatePlan).
export const generatePlan = askLLM;
