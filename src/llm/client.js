import { config } from '../config.js';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from './prompt.js';
import { tradingPlanSchema } from '../plan/schema.js';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

function stripMarkdownFences(s) {
  if (typeof s !== 'string') return s;
  let out = s.trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return out;
}

async function callDeepSeek(messages) {
  const body = {
    model: config.DEEPSEEK_MODEL,
    messages,
    max_tokens: 4000,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`DeepSeek empty content: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return content;
}

function sanitizePlan(p) {
  if (!p || typeof p !== 'object') return p;

  // Fix poi.zone strings to numbers
  if (p.poi?.zone && Array.isArray(p.poi.zone)) {
    p.poi.zone = p.poi.zone.map(v => typeof v === 'string' ? parseFloat(v) : v);
  }

  // Fix takeProfits level names + string prices/rr
  const levelMap = {
    'TP 1': 'TP1', 'TP 2': 'TP2', 'TP 3': 'TP3',
    'TP One': 'TP1', 'TP Two': 'TP2', 'TP Three': 'TP3',
    'First TP': 'TP1', 'Second TP': 'TP2', 'Third TP': 'TP3',
    'tp1': 'TP1', 'tp2': 'TP2', 'tp3': 'TP3',
  };
  if (Array.isArray(p.takeProfits)) {
    p.takeProfits = p.takeProfits.map(tp => ({
      ...tp,
      level: levelMap[tp.level] || tp.level,
      price: typeof tp.price === 'string' ? parseFloat(tp.price) : tp.price,
      rr: typeof tp.rr === 'string' ? parseFloat(tp.rr) : tp.rr,
    }));
  }

  // Fix all price fields from strings to numbers
  const priceFields = ['entry', 'stopLoss', 'invalidation'];
  for (const field of priceFields) {
    if (p[field]?.price && typeof p[field].price === 'string') {
      p[field].price = parseFloat(p[field].price);
    }
  }

  // If direction is set but entry/SL/TP missing, force no-trade
  if (p.direction && (!p.entry || !p.stopLoss || !p.takeProfits)) {
    console.warn('[llm] sanitize: direction set but missing entry/SL/TP — forcing no-trade');
    p.direction = null;
    p.setupQuality = 'no-trade';
    p.poi = null;
    p.entry = null;
    p.stopLoss = null;
    p.takeProfits = null;
    p.invalidation = null;
  }

  return p;
}

function sanitizeResponse(parsed) {
  // Unwrap if plan is nested inside a key
  if (parsed && typeof parsed === 'object' && !('bias' in parsed)) {
    const nested = parsed.tradingPlan ?? parsed.plan ?? parsed.analysis ?? parsed.result;
    if (nested && typeof nested === 'object' && 'bias' in nested) {
      parsed = nested;
    }
  }

  if (typeof parsed.session === 'string') {
    parsed.session = { current: 'unknown', recommendedExecutionWindow: parsed.session };
  }
  if (parsed.risk == null) {
    parsed.risk = { suggestedRiskPct: 0, positionSizeHint: 'No trade' };
  }
  if (typeof parsed.warnings === 'string') {
    parsed.warnings = [parsed.warnings];
  }
  if (
    parsed.takeProfits != null &&
    !Array.isArray(parsed.takeProfits) &&
    typeof parsed.takeProfits === 'object' &&
    'level' in parsed.takeProfits
  ) {
    parsed.takeProfits = [parsed.takeProfits];
  }

  return parsed;
}

function synthesizeMacroContext(ctx) {
  const parts = [];
  const dxy = ctx.dxy;
  const fred = ctx.fred;
  const sentiment = ctx.sentiment;

  if (dxy?.ok && dxy.trend && dxy.trend !== 'unknown') {
    parts.push(`${dxy.symbol ?? 'Dollar proxy'} ${dxy.trend} (${dxy.goldImpact})`);
  }
  if (fred?.ok && fred.realYield != null) {
    parts.push(`10Y real yield ${fred.realYield.toFixed(2)}% → ${fred.goldImpact}`);
  }
  if (sentiment?.ok && sentiment.value != null) {
    parts.push(`F&G ${sentiment.value} (${sentiment.classification}, ${sentiment.goldImpact})`);
  }
  if (parts.length === 0) return 'Cross-asset and macro data unavailable this run.';
  return parts.join('; ') + '.';
}

function buildFallbackPlan(ctx, errorMessage) {
  return {
    timestamp: ctx.timestamp,
    symbol: ctx.symbol,
    timeframe: ctx.executionTf,
    bias: 'neutral',
    biasReasoning: 'LLM analysis failed; fallback no-trade plan returned.',
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
    risk: {
      suggestedRiskPct: 0,
      positionSizeHint: 'n/a (no-trade)',
    },
    macroContext: synthesizeMacroContext(ctx),
    warnings: [`LLM failure: ${errorMessage}`],
    promptVersion: PROMPT_VERSION,
  };
}

export async function generatePlan(ctx) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(ctx);

  const baseMessages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let rawContent = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const messages = attempt === 1
        ? baseMessages
        : [
            ...baseMessages,
            { role: 'assistant', content: rawContent ?? '' },
            {
              role: 'user',
              content: `The previous response was not valid JSON for the required schema. Error: ${lastError}. Return ONLY a single valid JSON object matching the v2.0 schema. No markdown, no fences, no prose.`,
            },
          ];

      rawContent = await callDeepSeek(messages);
      const cleaned = stripMarkdownFences(rawContent);
      const parsed = sanitizePlan(sanitizeResponse(JSON.parse(cleaned)));
      const result = tradingPlanSchema.safeParse(parsed);
      if (!result.success) {
        lastError = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        console.warn(`[llm] attempt ${attempt} schema invalid: ${lastError}`);
        continue;
      }
      console.log(`[llm] plan generated on attempt ${attempt} (${result.data.setupQuality})`);
      return { ok: true, plan: result.data, rawContent };
    } catch (err) {
      lastError = err.message;
      console.warn(`[llm] attempt ${attempt} failed: ${err.message}`);
    }
  }

  console.warn(`[llm] both attempts failed; returning fallback plan. Last error: ${lastError}`);
  return { ok: false, plan: buildFallbackPlan(ctx, lastError ?? 'unknown error'), rawContent };
}
