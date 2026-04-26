import { z } from 'zod';

const numberLike = z.union([z.number(), z.string().transform(s => parseFloat(s))]);

// Gold price-magnitude sanity. AUD gold futures sit ~4700-4800; USD spot ~3300; either is fine.
// Anything outside 2000-15000 is almost certainly a magnitude error from the LLM and should
// fail validation so the retry path can correct it.
const priceLike = numberLike.refine(
  v => v >= 2000 && v <= 15000,
  { message: 'price out of plausible gold range 2000-15000' }
);

const poiSchema = z.object({
  type: z.string(),
  zone: z.array(priceLike).length(2),
  reasoning: z.string(),
});

const entrySchema = z.object({
  trigger: z.enum(['limit', 'marketOnConfirmation']),
  price: priceLike,
  confirmation: z.string(),
});

const stopLossSchema = z.object({
  price: priceLike,
  reasoning: z.string(),
  pips: z.union([z.number(), z.string().transform(s => parseFloat(s))]).optional().nullable(),
});

const takeProfitSchema = z.object({
  level: z.enum(['TP1', 'TP2', 'TP3']),
  price: priceLike,
  reasoning: z.string(),
  rr: numberLike,
});

const invalidationSchema = z.object({
  price: priceLike,
  reasoning: z.string(),
});

// Coerce string → { current: "unknown", recommendedExecutionWindow: string }
const sessionSchema = z.preprocess(
  (val) => {
    if (typeof val === 'string') return { current: 'unknown', recommendedExecutionWindow: val };
    return val;
  },
  z.object({
    current: z.string(),
    recommendedExecutionWindow: z.string(),
  })
);

// Default null/undefined → { suggestedRiskPct: 0, positionSizeHint: "No trade" }
const riskSchema = z.preprocess(
  (val) => {
    if (val == null) return { suggestedRiskPct: 0, positionSizeHint: 'No trade' };
    return val;
  },
  z.object({
    suggestedRiskPct: z.number(),
    positionSizeHint: z.string(),
  })
);

// Coerce string → [string], keep array as-is
const warningsSchema = z.preprocess(
  (val) => {
    if (typeof val === 'string') return [val];
    return val;
  },
  z.array(z.string()).default([])
);

// Coerce single TP object → [object], keep array/null as-is
const takeProfitsSchema = z.preprocess(
  (val) => {
    if (val != null && !Array.isArray(val) && typeof val === 'object' && 'level' in val) {
      return [val];
    }
    return val;
  },
  z.array(takeProfitSchema).nullable()
);

export const tradingPlanSchema = z.object({
  timestamp: z.string(),
  symbol: z.string().default('XAU/AUD'),
  timeframe: z.string(),
  bias: z.enum(['bullish', 'bearish', 'neutral']),
  biasReasoning: z.string(),
  setupQuality: z.enum(['A+', 'A', 'B', 'no-trade']),
  confluenceCount: z.number().int().nonnegative(),
  confluenceFactors: z.preprocess(
    (val) => (typeof val === 'string' ? [val] : val),
    z.array(z.string()).default([])
  ),
  direction: z.enum(['long', 'short']).nullable(),
  poi: poiSchema.nullable(),
  entry: entrySchema.nullable(),
  stopLoss: stopLossSchema.nullable(),
  takeProfits: takeProfitsSchema,
  invalidation: invalidationSchema.nullable(),
  session: sessionSchema,
  risk: riskSchema,
  macroContext: z.string(),
  warnings: warningsSchema,
  promptVersion: z.string(),
});

export const TradingPlan = tradingPlanSchema;
