import { config } from '../../config.js';

const API_URL = 'https://api.deepseek.com/chat/completions';

function stripFences(s) {
  if (typeof s !== 'string') return s;
  let out = s.trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return out;
}

// DeepSeek Chat pricing: ~$0.27/M input, $1.10/M output.
function estimateCost(usage) {
  if (!usage) return 0;
  const inCost = (usage.prompt_tokens || 0) * 0.27 / 1_000_000;
  const outCost = (usage.completion_tokens || 0) * 1.10 / 1_000_000;
  return inCost + outCost;
}

export async function askDeepSeek(systemPrompt, userPrompt) {
  const t0 = Date.now();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.DEEPSEEK_MODEL || 'deepseek-chat',
      max_tokens: 4000,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  const elapsed = Date.now() - t0;
  console.log(`[deepseek] response in ${elapsed}ms`);

  if (!content) {
    throw new Error(`DeepSeek empty content: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const cleaned = stripFences(content);
  const parsed = JSON.parse(cleaned);
  Object.defineProperty(parsed, '__usage', {
    value: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cost: estimateCost(data.usage),
    },
    enumerable: false,
  });
  return parsed;
}
