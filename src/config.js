import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Required
  TWELVEDATA_API_KEY: z.string().min(1, 'TWELVEDATA_API_KEY is required'),
  DEEPSEEK_API_KEY: z.string().min(1, 'DEEPSEEK_API_KEY is required'),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID: z.string().min(1, 'TELEGRAM_CHAT_ID is required'),

  // Optional API keys
  FRED_API_KEY: z.string().optional(),
  METALPRICE_API_KEY: z.string().optional(),
  METALSDEV_API_KEY: z.string().optional(),

  // Trading config
  SYMBOL: z.string().default('XAU/USD'),
  EXECUTION_TF: z.string().default('1h'),
  BIAS_TF: z.string().default('4h'),
  CANDLES_LOOKBACK: z.coerce.number().int().positive().default(200),
  DEFAULT_RISK_PCT: z.coerce.number().positive().default(1),
  DEFAULT_RR_MIN: z.coerce.number().positive().default(2),

  // Dev
  DRY_RUN: z.string().transform(v => v === 'true').default('false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
