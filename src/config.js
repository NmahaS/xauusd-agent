import 'dotenv/config';
import { z } from 'zod';

const baseSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID: z.string().min(1, 'TELEGRAM_CHAT_ID is required'),
});

const fullSchema = baseSchema.extend({
  IG_API_KEY: z.string().min(1, 'IG_API_KEY is required'),
  IG_USERNAME: z.string().min(1, 'IG_USERNAME is required'),
  IG_PASSWORD: z.string().min(1, 'IG_PASSWORD is required'),
  IG_ACCOUNT_ID: z.string().default(''),
  IG_DEMO: z.string()
    .transform(v => v === 'false' ? false : true)
    .default('true'),
  AUTO_TRADE: z.string().transform(v => v === 'true').default('false'),
  DRY_EXECUTE: z.string().transform(v => v === 'true').default('true'),
  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY is required'),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  PERPLEXITY_API_KEY: z.string().default(''),
  FRED_API_KEY: z.string().default(''),
  SYMBOL: z.string().default('XAU/AUD'),
  CURRENCY: z.string().default('AUD'),
  EXECUTION_TF: z.string().default('15min'),
  BIAS_TF: z.string().default('4h'),
  CANDLES_LOOKBACK: z.coerce.number().int().min(100).default(200),
  DEFAULT_RISK_PCT: z.coerce.number().min(0.1).max(5).default(1),
  DEFAULT_RR_MIN: z.coerce.number().min(1).default(2),
  DRY_RUN: z.string().transform(v => v === 'true').default('false'),
});

const fullParsed = fullSchema.safeParse(process.env);
const baseParsed = baseSchema.safeParse(process.env);

export const reportConfig = (() => {
  if (!baseParsed.success) {
    console.error('Invalid environment variables:');
    for (const issue of baseParsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return baseParsed.data;
})();

// Pipeline (src/run.js) needs the full schema. Monthly report (src/plan/generateMonthlyReport.js)
// only needs reportConfig. When we fall back to reportConfig, log loudly so the caller can detect it.
export const config = (() => {
  if (fullParsed.success) return fullParsed.data;
  console.warn('[config] Full schema validation failed — pipeline will not work. Missing/invalid:');
  for (const issue of fullParsed.error.issues) {
    console.warn(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  return reportConfig;
})();

export const configIsFull = fullParsed.success;
