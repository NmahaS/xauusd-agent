import { z } from 'zod';

const poiSchema = z.object({
  type: z.string(),
  zone: z.tuple([z.number(), z.number()]),
  reasoning: z.string(),
});

const entrySchema = z.object({
  trigger: z.enum(['limit', 'marketOnConfirmation']),
  price: z.number(),
  confirmation: z.string(),
});

const stopLossSchema = z.object({
  price: z.number(),
  reasoning: z.string(),
  pips: z.number().optional().nullable(),
});

const takeProfitSchema = z.object({
  level: z.union([z.string(), z.number()]),
  price: z.number(),
  reasoning: z.string(),
  rr: z.number(),
});

const invalidationSchema = z.object({
  price: z.number(),
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
  symbol: z.string(),
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
