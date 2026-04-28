// Combines Claude + DeepSeek plans + Perplexity news into a final decision.
//
// Rules in priority order:
//   1. NEWS OVERRIDE       — news.shouldBlockTrading=true → force no-trade
//   2. SINGLE-LLM          — only one of the two succeeded → use it (medium confidence)
//   3. FULL AGREEMENT      — both have same direction → use Claude's, take higher quality
//   4. BOTH NO-TRADE       — both null → use Claude's
//   5. DISAGREEMENT (split)— one trades, one doesn't, or opposite → force B quality

const QUALITY_RANK = { 'A+': 4, 'A': 3, 'B': 2, 'no-trade': 1 };

function pickHigherQuality(a, b) {
  return (QUALITY_RANK[a] || 0) >= (QUALITY_RANK[b] || 0) ? a : b;
}

function consensusMeta(agreement, confidence, claudePlan, deepseekPlan, news) {
  return {
    agreement,
    confidence,
    claudeDirection: claudePlan?.direction ?? null,
    deepseekDirection: deepseekPlan?.direction ?? null,
    claudeQuality: claudePlan?.setupQuality ?? 'failed',
    deepseekQuality: deepseekPlan?.setupQuality ?? 'failed',
    newsRisk: news?.riskLevel ?? null,
    newsSentiment: news?.sentiment ?? null,
    newsHeadline: news?.headline ?? null,
  };
}

function applyNewsOverride(base, claudePlan, deepseekPlan, news) {
  return {
    ...base,
    direction: null,
    setupQuality: 'no-trade',
    poi: null,
    entry: null,
    stopLoss: null,
    takeProfits: null,
    invalidation: null,
    warnings: [
      ...(base.warnings || []),
      `🔴 BREAKING: ${news.headline} — trading blocked`,
    ],
    consensus: consensusMeta('news_override', 'none', claudePlan, deepseekPlan, news),
  };
}

export function buildConsensus(claudePlan, deepseekPlan, newsResult) {
  const base = claudePlan || deepseekPlan;
  if (!base) return null; // caller (askLLM) handles all-failed via fallback

  // Rule 1: news override fires regardless of single/multi state
  if (newsResult?.shouldBlockTrading === true) {
    return applyNewsOverride(base, claudePlan, deepseekPlan, newsResult);
  }

  // Rule 2: single LLM only
  if (claudePlan && !deepseekPlan) {
    return {
      ...claudePlan,
      warnings: [
        ...(claudePlan.warnings || []),
        '⚡ Single LLM only — Claude (DeepSeek failed)',
      ],
      consensus: consensusMeta('single', 'medium', claudePlan, null, newsResult),
    };
  }
  if (!claudePlan && deepseekPlan) {
    return {
      ...deepseekPlan,
      warnings: [
        ...(deepseekPlan.warnings || []),
        '⚡ Single LLM only — DeepSeek (Claude failed)',
      ],
      consensus: consensusMeta('single', 'medium', null, deepseekPlan, newsResult),
    };
  }

  // Both LLMs present — compare directions
  const cd = claudePlan.direction;
  const dd = deepseekPlan.direction;

  // Rule 3: full agreement on a direction
  if (cd && dd && cd === dd) {
    return {
      ...claudePlan,
      setupQuality: pickHigherQuality(claudePlan.setupQuality, deepseekPlan.setupQuality),
      warnings: [
        ...(claudePlan.warnings || []),
        `✅ Consensus: Claude + DeepSeek both ${cd}`,
      ],
      consensus: consensusMeta('full', 'high', claudePlan, deepseekPlan, newsResult),
    };
  }

  // Rule 4: both no-trade
  if (!cd && !dd) {
    return {
      ...claudePlan,
      consensus: consensusMeta('full', 'high', claudePlan, deepseekPlan, newsResult),
    };
  }

  // Rule 5: disagreement — force B quality so the risk manager blocks auto-execution
  const winner = cd ? claudePlan : deepseekPlan;
  return {
    ...winner,
    setupQuality: 'B',
    warnings: [
      ...(winner.warnings || []),
      `⚠️ Split: Claude=${cd || 'no-trade'} DeepSeek=${dd || 'no-trade'} — manual only`,
    ],
    consensus: consensusMeta('split', 'medium', claudePlan, deepseekPlan, newsResult),
  };
}
