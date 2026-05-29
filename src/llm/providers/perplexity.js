import { config } from '../../config.js';

const API_URL = 'https://api.perplexity.ai/chat/completions';

function stripFences(s) {
  if (typeof s !== 'string') return s;
  let out = s.trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return out;
}

function safeDefault(headline = 'Parse error') {
  return {
    hasBreakingNews: false,
    riskLevel: 'low',
    sentiment: 'neutral',
    shouldBlockTrading: false,
    headline,
    details: '',
    blockReason: null,
    newsItems: [],
  };
}

function buildNewsPrompt(goldPrice, upcomingEvents, currentBias) {
  const eventsBlock = (upcomingEvents || []).slice(0, 10).map(e =>
    `- +${e.minutesAway ?? '?'}m ${e.country ?? ''} ${e.title ?? ''} (${e.impact ?? 'unknown'}${e.goldRelevant ? ', gold-relevant' : ''})`
  ).join('\n') || '- (no events listed)';

  return `You are a gold market news analyst. Current XAU/AUD price: ${goldPrice}. Technical bias: ${currentBias}.

Upcoming economic events in the next 24 hours:
${eventsBlock}

Search the web for breaking news about:
1. Gold price movements and drivers in the last 2 hours
2. Surprise economic data releases
3. Central bank statements (Fed, ECB, RBA) affecting gold
4. Geopolitical events impacting safe-haven demand
5. US Dollar / AUD developments

Respond with ONLY this JSON — no markdown, no prose:
{
  "hasBreakingNews": true/false,
  "riskLevel": "low" | "medium" | "high" | "extreme",
  "sentiment": "bullish" | "bearish" | "neutral",
  "headline": "one-line summary",
  "details": "2-3 sentences on impact to gold",
  "shouldBlockTrading": true/false,
  "blockReason": "reason or null",
  "newsItems": [{"headline": "...", "impact": "bullish/bearish/neutral", "source": "..."}]
}

Set shouldBlockTrading=true ONLY for: war outbreak, emergency rate decision, flash crash, or high-impact data release within 15 minutes.`;
}

// Perplexity Sonar Pro: ~$3/M input, $15/M output, plus ~$5/1k searches.
function estimateCost(usage) {
  if (!usage) return 0.005; // bare minimum for the search itself
  const inCost = (usage.prompt_tokens || 0) * 3 / 1_000_000;
  const outCost = (usage.completion_tokens || 0) * 15 / 1_000_000;
  return inCost + outCost + 0.005;
}

export async function askPerplexity(goldPrice, upcomingEvents, currentBias) {
  if (!config.PERPLEXITY_API_KEY) {
    return safeDefault('PERPLEXITY_API_KEY not configured');
  }

  const t0 = Date.now();
  const newsPrompt = buildNewsPrompt(goldPrice, upcomingEvents, currentBias);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        max_tokens: 1000,
        temperature: 0.1,
        messages: [{ role: 'user', content: newsPrompt }],
      }),
    });
  } catch (err) {
    console.warn(`[perplexity] network error: ${err.message}`);
    return safeDefault('Network error');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[perplexity] HTTP ${res.status}: ${body.slice(0, 200)}`);
    return safeDefault(`HTTP ${res.status}`);
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  const elapsed = Date.now() - t0;

  if (!content) {
    console.warn(`[perplexity] empty content in ${elapsed}ms`);
    return safeDefault('Empty content');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFences(content));
  } catch (err) {
    console.warn(`[perplexity] parse failed in ${elapsed}ms: ${err.message}`);
    return safeDefault('Parse error');
  }

  Object.defineProperty(parsed, '__usage', {
    value: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cost: estimateCost(data.usage),
    },
    enumerable: false,
  });

  console.log(`[perplexity] risk=${parsed.riskLevel} sentiment=${parsed.sentiment} block=${parsed.shouldBlockTrading} in ${elapsed}ms`);
  return parsed;
}
