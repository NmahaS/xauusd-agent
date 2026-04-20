import { generateMonthlyReport, saveMonthlyReport } from './monthlyReport.js';
import { formatMonthlyReportForTelegram } from './formatter.js';
import { sendTelegramMessage } from '../telegram/notify.js';

function getPreviousMonth() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed; 0 = January
  const prevM = m === 0 ? 12 : m;
  const prevY = m === 0 ? y - 1 : y;
  return `${prevY}-${String(prevM).padStart(2, '0')}`;
}

function parseArgs() {
  const monthArg = process.argv.find(a => a.startsWith('--month='));
  if (monthArg) {
    const val = monthArg.split('=')[1];
    if (/^\d{4}-\d{2}$/.test(val)) return val;
    console.error(`Invalid --month format: "${val}". Expected YYYY-MM.`);
    process.exit(1);
  }
  return getPreviousMonth();
}

async function main() {
  const yearMonth = parseArgs();
  console.log(`\n=== Monthly Report: ${yearMonth} ===`);

  const report = await generateMonthlyReport(yearMonth);
  if (!report) {
    console.log(`[monthly] No daily summaries found for ${yearMonth}. Nothing to report.`);
    process.exit(0);
  }

  console.log(
    `[monthly] ${report.summary.totalDays} days · ` +
    `${report.summary.totalTrades} trades · ` +
    `${report.winLoss.winRate} win rate · ` +
    `net ${report.rrAnalysis.totalNetRR ?? 0}R`
  );

  await saveMonthlyReport(yearMonth, report);

  const message = formatMonthlyReportForTelegram(report);
  await sendTelegramMessage(message);

  console.log(`=== monthly report complete ===\n`);
}

main().catch(err => {
  console.error('[monthly] fatal error:', err);
  process.exit(2);
});
