import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

import { fetchHistory } from './fetchHistory.js';
import { runBacktest } from './runner.js';
import { computeStats, saveStats } from './stats.js';
import { publishReport } from './report.js';

const SIGNALS_FILE = path.resolve('backtest/results/signals.json');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--fetch');
  const reportOnly = args.includes('--report-only');
  const skipTelegram = args.includes('--no-telegram');

  let signals;

  if (reportOnly) {
    console.log('[backtest] --report-only: loading signals from cache');
    try {
      const raw = await fs.readFile(SIGNALS_FILE, 'utf8');
      signals = JSON.parse(raw);
    } catch (err) {
      console.error(`[backtest] no signals cache at ${SIGNALS_FILE} — run npm run backtest first`);
      process.exit(1);
    }
  } else {
    const { h1, h4, epic, cached } = await fetchHistory({ force });
    if (h1.length === 0) {
      console.error('[backtest] no H1 candles — cannot run');
      process.exit(1);
    }
    console.log(`[backtest] running on epic=${epic} (${cached ? 'cached' : 'fresh fetch'})`);
    signals = await runBacktest(h1, h4);
  }

  const stats = computeStats(signals);
  await saveStats(stats);
  await publishReport(stats, { sendTelegram: !skipTelegram });

  process.exit(0);
}

main().catch(err => {
  console.error('[backtest] FATAL:', err.message, err.stack);
  process.exit(1);
});
