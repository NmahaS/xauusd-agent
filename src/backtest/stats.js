import fs from 'node:fs/promises';
import path from 'node:path';

const RESULTS_DIR = path.resolve('backtest/results');
const REPORT_JSON = path.join(RESULTS_DIR, 'backtest-report.json');
const REPORT_TXT = path.join(RESULTS_DIR, 'backtest-summary.txt');

function n(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 10 ** d) / 10 ** d;
}

function pct(num, denom) {
  if (!denom) return 'N/A';
  return ((num / denom) * 100).toFixed(1) + '%';
}

function sumRR(arr) {
  return arr.reduce((s, t) => s + (t.actualRR || 0), 0);
}

export function computeStats(signals) {
  const taken = signals.filter(s => !s.skipped);
  const trades = taken.filter(s => s.outcome !== 'EXPIRED');
  const wins = trades.filter(s => s.outcome.startsWith('WIN'));
  const losses = trades.filter(s => s.outcome === 'LOSS');
  const expired = taken.filter(s => s.outcome === 'EXPIRED');
  const skipped = signals.filter(s => s.skipped);

  const winsRR = sumRR(wins);
  const lossesRR = sumRR(losses);
  const totalNetRR = sumRR(trades);

  const avgWinRR = wins.length ? winsRR / wins.length : 0;
  const avgLossRR = losses.length ? lossesRR / losses.length : 0;
  const expectancy = trades.length
    ? (wins.length / trades.length) * avgWinRR + (losses.length / trades.length) * avgLossRR
    : 0;
  const profitFactor = lossesRR < 0
    ? Math.abs(winsRR / lossesRR)
    : (winsRR > 0 ? Infinity : 0);

  const byQuality = ['A+', 'A', 'B'].map(q => {
    const qt = trades.filter(t => t.quality === q);
    const qw = qt.filter(t => t.outcome.startsWith('WIN'));
    return {
      quality: q,
      trades: qt.length,
      wins: qw.length,
      winRate: pct(qw.length, qt.length),
      avgRR: n(qt.length ? sumRR(qt) / qt.length : 0),
      netRR: n(sumRR(qt)),
    };
  });

  const sessions = ['london', 'ny', 'asia', 'off'];
  const bySession = sessions.map(sess => {
    const st = trades.filter(t => t.session === sess);
    const sw = st.filter(t => t.outcome.startsWith('WIN'));
    return {
      session: sess,
      trades: st.length,
      wins: sw.length,
      winRate: pct(sw.length, st.length),
      avgRR: n(st.length ? sumRR(st) / st.length : 0),
      netRR: n(sumRR(st)),
    };
  });

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const byDay = days.map(day => {
    const dt = trades.filter(t => t.dayOfWeek === day);
    const dw = dt.filter(t => t.outcome.startsWith('WIN'));
    return {
      day,
      trades: dt.length,
      winRate: pct(dw.length, dt.length),
      netRR: n(sumRR(dt)),
    };
  });

  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.outcome.startsWith('WIN')) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
    else if (t.outcome === 'LOSS') { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
  }

  const tpDist = {
    TP1: wins.filter(t => t.outcome === 'WIN_TP1').length,
    TP2: wins.filter(t => t.outcome === 'WIN_TP2').length,
    TP3: wins.filter(t => t.outcome === 'WIN_TP3').length,
  };

  return {
    period: {
      from: signals[0]?.timestamp ?? null,
      to: signals[signals.length - 1]?.timestamp ?? null,
      totalCandlesScanned: signals.length,
    },
    overall: {
      totalSignals: signals.length,
      totalTrades: trades.length,
      skipped: skipped.length,
      expired: expired.length,
      wins: wins.length,
      losses: losses.length,
      winRate: pct(wins.length, trades.length),
      totalNetRR: n(totalNetRR),
      avgWinRR: n(avgWinRR),
      avgLossRR: n(avgLossRR),
      expectancy: n(expectancy),
      profitFactor: profitFactor === Infinity ? 'infinite' : n(profitFactor),
      maxWinStreak,
      maxLossStreak,
      tpDistribution: tpDist,
    },
    byQuality,
    bySession,
    byDay,
  };
}

export async function saveStats(stats) {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.writeFile(REPORT_JSON, JSON.stringify(stats, null, 2));
  await fs.writeFile(REPORT_TXT, plainTextSummary(stats));
  console.log(`[backtest] saved stats to ${REPORT_JSON}`);
}

export function plainTextSummary(stats) {
  const lines = [];
  const o = stats.overall;
  lines.push(`XAU/AUD BACKTEST REPORT`);
  lines.push(`Period: ${stats.period.from ?? 'n/a'} → ${stats.period.to ?? 'n/a'}`);
  lines.push(`Candles scanned: ${o.totalSignals}`);
  lines.push(`Trades taken: ${o.totalTrades} · Skipped: ${o.skipped} · Expired: ${o.expired}`);
  lines.push('');
  lines.push(`Win rate: ${o.winRate} (${o.wins}W / ${o.losses}L)`);
  lines.push(`Net RR: ${o.totalNetRR >= 0 ? '+' : ''}${o.totalNetRR}R`);
  lines.push(`Avg win: +${o.avgWinRR}R · Avg loss: ${o.avgLossRR}R`);
  lines.push(`Expectancy: ${o.expectancy >= 0 ? '+' : ''}${o.expectancy}R/trade · PF: ${o.profitFactor}x`);
  lines.push(`Streaks: max ${o.maxWinStreak}W / ${o.maxLossStreak}L`);
  lines.push('');
  lines.push(`TP distribution: TP1=${o.tpDistribution.TP1} TP2=${o.tpDistribution.TP2} TP3=${o.tpDistribution.TP3}`);
  lines.push('');
  lines.push(`By Quality:`);
  for (const q of stats.byQuality) lines.push(`  ${q.quality.padEnd(3)} ${String(q.trades).padStart(4)} trades  ${q.winRate.padStart(6)} WR  ${String(q.avgRR).padStart(6)}R avg  ${String(q.netRR).padStart(7)}R net`);
  lines.push('');
  lines.push(`By Session:`);
  for (const s of stats.bySession) lines.push(`  ${s.session.padEnd(7)} ${String(s.trades).padStart(4)} trades  ${s.winRate.padStart(6)} WR  ${String(s.avgRR).padStart(6)}R avg  ${String(s.netRR).padStart(7)}R net`);
  lines.push('');
  lines.push(`By Day:`);
  for (const d of stats.byDay) lines.push(`  ${d.day.padEnd(10)} ${String(d.trades).padStart(4)} trades  ${d.winRate.padStart(6)} WR  ${String(d.netRR).padStart(7)}R net`);
  return lines.join('\n');
}
