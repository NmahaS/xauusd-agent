// Manual smoke test for the executor path. Feeds a synthetic A-quality, full-consensus
// LONG plan into executeIfApproved() with AUTO_TRADE=true + DRY_EXECUTE=true, against
// the real IG LIVE account. Demonstrates [risk] checks, position sizing, [executor]
// PRE-FLIGHT log, and DRY_EXECUTE short-circuit. No real order is placed.
import 'dotenv/config';
process.env.AUTO_TRADE = 'true';   // override for this smoke test only
process.env.DRY_EXECUTE = 'true';  // ensure no real POST happens

const { config } = await import('../src/config.js');
const { fetchAllIGData } = await import('../src/data/ig.js');
const { executeIfApproved } = await import('../src/broker/executor.js');

console.log(`[smoke] AUTO_TRADE=${config.AUTO_TRADE} DRY_EXECUTE=${config.DRY_EXECUTE}`);

const ig = await fetchAllIGData();
if (!ig.h1Candles?.length) {
  console.error('[smoke] no IG candles — abort');
  process.exit(1);
}
const live = ig.currentPrice;
console.log(`[smoke] live mid=${live}, gold epic=${ig.goldEpic}, divisor=${ig.goldDivisor}`);

// Synthetic A-quality LONG plan with tight SL (~5 pts) so 0.2 lots fits A$1 risk.
const entry = parseFloat(live.toFixed(2));
const sl    = parseFloat((entry - 5).toFixed(2));
const tp1   = parseFloat((entry + 10).toFixed(2));     // RR 2.0
const tp2   = parseFloat((entry + 18).toFixed(2));     // RR 3.6
const tp3   = parseFloat((entry + 30).toFixed(2));     // RR 6.0

const plan = {
  symbol: 'XAU/AUD',
  timestamp: new Date().toISOString(),
  timeframe: '1h',
  bias: 'bullish',
  biasReasoning: '[smoke test] synthetic plan',
  setupQuality: 'A',
  confluenceCount: 6,
  confluenceFactors: ['c1','c2','c3','c4','c5','c6'],
  direction: 'long',
  poi: { type: 'bullish_order_block', zone: [sl, entry], reasoning: 'smoke' },
  entry: { trigger: 'marketOnConfirmation', price: entry, confirmation: 'M15 ok' },
  stopLoss: { price: sl, reasoning: 'smoke', pips: 5 },
  takeProfits: [
    { level: 'TP1', price: tp1, rr: 2.0, reasoning: 'smoke' },
    { level: 'TP2', price: tp2, rr: 3.6, reasoning: 'smoke' },
    { level: 'TP3', price: tp3, rr: 6.0, reasoning: 'smoke' },
  ],
  invalidation: { price: sl - 1, reasoning: 'smoke' },
  session: { current: 'london', recommendedExecutionWindow: 'now' },
  risk: { suggestedRiskPct: 1, positionSizeHint: '1% risk' },
  macroContext: '[smoke]',
  warnings: [],
  promptVersion: 'v3.0',
  m15: { status: 'CONFIRMED', reason: 'smoke synthetic' },
  consensus: {
    agreement: 'full',
    confidence: 'high',
    claudeDirection: 'long', deepseekDirection: 'long',
    claudeQuality: 'A',      deepseekQuality: 'A',
    newsRisk: 'low', newsSentiment: 'neutral', newsHeadline: null,
  },
};

const result = await executeIfApproved(plan, { goldEpic: ig.goldEpic, calendar: { events: [] } }, ig.session);
console.log(`\n[smoke] result.executed=${result.executed} reason="${result.reason}"`);
if (result.trade) console.log('[smoke] trade payload:', JSON.stringify(result.trade, null, 2));
process.exit(0);
