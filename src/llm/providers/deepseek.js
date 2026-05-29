import { config } from '../../config.js';

const API_URL = 'https://api.deepseek.com/chat/completions';

function stripFences(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/g, '')
    .trim();
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
  const apiKey = process.env.DEEPSEEK_API_KEY || config.DEEPSEEK_API_KEY || '';
  console.log('[deepseek] starting call...');
  console.log(`[deepseek] API key present: ${!!apiKey} prefix: ${apiKey.slice(0, 15)}`);
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    console.error('[deepseek] TIMEOUT after 20 seconds');
  }, 20000);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || config.DEEPSEEK_MODEL || 'deepseek-chat',
        max_tokens: 2000,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    console.log(`[deepseek] HTTP status: ${res.status}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[deepseek] HTTP error: ${errText.slice(0, 300)}`);
      throw new Error(`DeepSeek HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const elapsed = Date.now() - t0;
    console.log(`[deepseek] response received in ${elapsed}ms, tokens: ${data.usage?.total_tokens ?? 'n/a'}`);

    if (!content) {
      throw new Error(`DeepSeek empty content: ${JSON.stringify(data).slice(0, 300)}`);
    }

    console.log(`[deepseek] response preview: ${content.slice(0, 120)}`);
    const cleaned = stripFences(content);
    const parsed = JSON.parse(cleaned);

    // Derive direction from bias when DeepSeek omits it
    if (!parsed.direction || parsed.direction === 'null') {
      if (parsed.bias === 'bullish') {
        parsed.direction = 'long';
        console.log('[deepseek] derived direction=long from bias=bullish');
      } else if (parsed.bias === 'bearish') {
        parsed.direction = 'short';
        console.log('[deepseek] derived direction=short from bias=bearish');
      } else {
        console.log(`[deepseek] direction null, bias=${parsed.bias ?? 'missing'} — staying no-trade`);
      }
    }

    Object.defineProperty(parsed, '__usage', {
      value: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
        cost: estimateCost(data.usage),
      },
      enumerable: false,
    });
    return parsed;
  } catch (err) {
    clearTimeout(timeout);
    console.error('[deepseek] failed:', err.message);
    throw err;
  }
}
