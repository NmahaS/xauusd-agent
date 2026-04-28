import { config } from '../../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

function stripFences(s) {
  if (typeof s !== 'string') return s;
  let out = s.trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return out;
}

// Claude Haiku 4.5 pricing: $1/M input tokens, $5/M output tokens.
function estimateCost(usage) {
  if (!usage) return 0;
  const inCost = (usage.input_tokens || 0) * 1 / 1_000_000;
  const outCost = (usage.output_tokens || 0) * 5 / 1_000_000;
  return inCost + outCost;
}

export async function askClaude(systemPrompt, userPrompt) {
  const t0 = Date.now();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  const elapsed = Date.now() - t0;
  console.log(`[claude] response in ${elapsed}ms (${text.length} chars)`);

  if (!text) {
    throw new Error(`Claude empty content: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const cleaned = stripFences(text);
  const parsed = JSON.parse(cleaned);
  Object.defineProperty(parsed, '__usage', {
    value: {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      cost: estimateCost(data.usage),
    },
    enumerable: false,
  });
  return parsed;
}
