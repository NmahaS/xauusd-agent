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
    macroContext: 'LLM unavailable; no macro synthesis produced.',
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
      const parsed = sanitizeResponse(JSON.parse(cleaned));
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
