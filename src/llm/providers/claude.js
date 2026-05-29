import { config } from '../../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

function stripFences(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/g, '')
    .trim();
}

// Claude Haiku 4.5 pricing: $1/M input tokens, $5/M output tokens.
function estimateCost(usage) {
  if (!usage) return 0;
  const inCost = (usage.input_tokens || 0) * 1 / 1_000_000;
  const outCost = (usage.output_tokens || 0) * 5 / 1_000_000;
  return inCost + outCost;
}

export async function askClaude(systemPrompt, userPrompt) {
  const apiKey = config.ANTHROPIC_API_KEY;
  console.log('[claude] starting call...');
  console.log(`[claude] API key present: ${!!apiKey} prefix: ${apiKey?.slice(0, 15)}`);
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    console.error('[claude] TIMEOUT after 30s');
  }, 30000);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Claude request timed out after 30s');
    throw err;
  }
  clearTimeout(timeout);

  console.log(`[claude] HTTP status: ${res.status}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[claude] HTTP error body: ${body.slice(0, 300)}`);
    throw new Error(`Claude HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  const elapsed = Date.now() - t0;
  console.log(`[claude] response in ${elapsed}ms (${text.length} chars)`);
  console.log(`[claude] response tokens: ${data.usage?.output_tokens ?? 'n/a'}`);
  console.log(`[claude] response preview: ${text.slice(0, 120)}`);

  if (!text) {
    throw new Error(`Claude empty content: ${JSON.stringify(data).slice(0, 300)}`);
  }

  // Retry once with correction nudge if JSON is truncated
  let cleaned = stripFences(text);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.warn(`[claude] JSON parse failed (${parseErr.message}) — retrying with correction nudge`);
    const retryRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        temperature: 0.2,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: text },
          { role: 'user', content: 'Your JSON was truncated. Produce ONLY a complete, valid JSON object — no other text.' },
        ],
      }),
    });
    if (!retryRes.ok) throw new Error(`Claude retry HTTP ${retryRes.status}`);
    const retryData = await retryRes.json();
    const retryText = (retryData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    console.log(`[claude] retry response: ${retryText.length} chars, tokens: ${retryData.usage?.output_tokens ?? 'n/a'}`);
    cleaned = stripFences(retryText);
    parsed = JSON.parse(cleaned);
  }

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
