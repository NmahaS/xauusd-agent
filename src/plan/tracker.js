import fs from 'node:fs/promises';
import path from 'node:path';
import { syncFileToGithub } from '../utils/gitSync.js';

const PLANS_DIR = path.resolve('plans');

function r(v, d = 2) {
  if (v == null || Number.isNaN(v)) return null;
  return Math.round(v * 10 ** d) / 10 ** d;
}

function pct(num, denom) {
  if (!denom) return '0%';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

export async function updateDailySummary(timestampIso, { save = true } = {}) {
  const dateStr = timestampIso.slice(0, 10);
  const dir = path.join(PLANS_DIR, dateStr);

  let files;
  try {
    files = (await fs.readdir(dir)).filter(f => /^\d{2}\.json$/.test(f));
  } catch {
    return null; // directory doesn't exist (dry-run with no prior plans)
  }

  const plans = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      plans.push(JSON.parse(raw));
    } catch {}
  }
  if (plans.length === 0) return null;

  plans.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const tradePlans = plans.filter(p => p.direction != null);
  const noTradePlans = plans.filter(p => p.direction == null);

  // Setup quality counts
  const setups = { 'A+': 0, 'A': 0, 'B': 0, 'no-trade': 0 };
  for (const p of plans) {
    if (p.setupQuality in setups) setups[p.setupQuality]++;
  }

  // Direction counts
  const directions = { long: 0, short: 0 };
  for (const p of tradePlans) {
    if (p.direction === 'long') directions.long++;
    else if (p.direction === 'short') directions.short++;
  }

  // Outcome groupings
  const withOutcome = tradePlans.filter(p => p.outcome && p.outcome.status !== 'open');
  const wins = withOutcome.filter(p => p.outcome.status === 'win');
  const partialWins = withOutcome.filter(p => p.outcome.status === 'partial_win');
  const losses = withOutcome.filter(p => p.outcome.status === 'loss');
  const expired = withOutcome.filter(p => p.outcome.status === 'expired');
  const openTrades = tradePlans.filter(p => !p.outcome || p.outcome.status === 'open');
  const resolvedCount = wins.length + partialWins.length + losses.length;

  // Win stats by quality
  const winsByQuality = {};
  for (const q of ['A+', 'A', 'B']) {
    const qt = tradePlans.filter(p => p.setupQuality === q);
    if (qt.length === 0) continue;
    const qw = qt.filter(p => p.outcome?.status === 'win' || p.outcome?.status === 'partial_win');
    const ql = qt.filter(p => p.outcome?.status === 'loss');
    winsByQuality[q] = {
      wins: qw.length,
      losses: ql.length,
      total: qt.length,
      winRate: pct(qw.length, qt.length),
    };
  }

  // Win stats by session
  const sessionNames = [...new Set(tradePlans.map(p => p.session?.current).filter(Boolean))];
  const winsBySession = {};
  for (const sess of sessionNames) {
    const st = tradePlans.filter(p => p.session?.current === sess);
    const sw = st.filter(p => p.outcome?.status === 'win' || p.outcome?.status === 'partial_win');
    const sl = st.filter(p => p.outcome?.status === 'loss');
    winsBySession[sess] = {
      wins: sw.length,
      losses: sl.length,
      winRate: pct(sw.length, st.length),
    };
  }

  // Per-plan summaries (trade plans only)
  const planSummaries = tradePlans.map(p => {
    const tp1 = p.takeProfits?.[0] ?? null;
    const tp2 = p.takeProfits?.[1] ?? null;
    const tp3 = p.takeProfits?.[2] ?? null;
    const maxRR = tp3?.rr ?? tp2?.rr ?? tp1?.rr ?? null;
    return {
      hour: p.timestamp.slice(11, 13),
      setupQuality: p.setupQuality,
      direction: p.direction,
      entry: p.entry?.price ?? null,
      sl: p.stopLoss?.price ?? null,
      slPips: p.stopLoss?.pips ?? null,
      tp1: tp1 ? { price: tp1.price, rr: tp1.rr } : null,
      tp2: tp2 ? { price: tp2.price, rr: tp2.rr } : null,
      tp3: tp3 ? { price: tp3.price, rr: tp3.rr } : null,
      maxRR,
      session: p.session?.current ?? null,
      bias: p.bias,
      confluenceCount: p.confluenceCount,
      outcome: p.outcome?.status ?? 'open',
      actualRR: p.outcome?.actualRR ?? null,
      tpHits: [
        p.outcome?.tp1Hit ?? false,
        p.outcome?.tp2Hit ?? false,
        p.outcome?.tp3Hit ?? false,
      ],
    };
  });

  // Daily RR calculations
  const sumRR = (arr, idx) =>
    arr.reduce((s, p) => s + (p.takeProfits?.[idx]?.rr ?? 0), 0);

  const totalPotRR1 = r(sumRR(tradePlans, 0));
  const totalPotRR2 = r(sumRR(tradePlans, 1));
  const totalPotRR3 = r(sumRR(tradePlans, 2));
  const n = tradePlans.length;

  const actualRRs = withOutcome.map(p => p.outcome.actualRR ?? 0);
  const totalActualRR = r(actualRRs.reduce((s, v) => s + v, 0));
  const netRR = totalActualRR; // positive for wins (+RR), negative for losses (-1.0 each)

  // Best = highest maxRR potential (or actualRR if resolved)
  const bestPlan = tradePlans.length
    ? tradePlans.reduce((best, p) => {
        const v = p.outcome?.actualRR ?? p.takeProfits?.[0]?.rr ?? 0;
        const bv = best.outcome?.actualRR ?? best.takeProfits?.[0]?.rr ?? 0;
        return v > bv ? p : best;
      })
    : null;

  // Worst = lowest actualRR among resolved
  const worstPlan = withOutcome.length
    ? withOutcome.reduce((w, p) => {
        return (p.outcome.actualRR ?? 0) < (w.outcome.actualRR ?? 0) ? p : w;
      })
    : null;

  const dailyRR = {
    totalPotentialRR_TP1: totalPotRR1,
    totalPotentialRR_TP2: totalPotRR2,
    totalPotentialRR_TP3: totalPotRR3,
    totalActualRR,
    avgRR_TP1: n ? r(totalPotRR1 / n) : null,
    avgRR_TP2: n ? r(totalPotRR2 / n) : null,
    avgRR_TP3: n ? r(totalPotRR3 / n) : null,
    avgActualRR: withOutcome.length ? r(totalActualRR / withOutcome.length) : null,
    netRR,
    bestSetup: bestPlan
      ? {
          hour: bestPlan.timestamp.slice(11, 13),
          rr: r(bestPlan.outcome?.actualRR ?? bestPlan.takeProfits?.[0]?.rr ?? 0),
          direction: bestPlan.direction,
          quality: bestPlan.setupQuality,
          outcome: bestPlan.outcome?.status ?? 'open',
        }
      : null,
    worstSetup: worstPlan
      ? {
          hour: worstPlan.timestamp.slice(11, 13),
          rr: r(worstPlan.outcome?.actualRR ?? 0),
          direction: worstPlan.direction,
          quality: worstPlan.setupQuality,
          outcome: worstPlan.outcome?.status ?? 'open',
        }
      : null,
  };

  const summary = {
    date: dateStr,
    totalPlans: plans.length,
    trades: tradePlans.length,
    noTrades: noTradePlans.length,
    setups,
    directions,
    wins: {
      total: wins.length + partialWins.length,
      losses: losses.length,
      partialWins: partialWins.length,
      expired: expired.length,
      open: openTrades.length,
      winRate: pct(wins.length + partialWins.length, resolvedCount),
      winsByQuality,
      winsBySession,
    },
    plans: planSummaries,
    dailyRR,
  };

  if (save) {
    const summaryPath = path.join(dir, 'daily-summary.json');
    const content = JSON.stringify(summary, null, 2);
    await fs.writeFile(summaryPath, content, 'utf8');
    syncFileToGithub(`plans/${dateStr}/daily-summary.json`, content).catch(() => {});
    console.log(
      `[tracker] ${dateStr}: ${plans.length} plans, ${tradePlans.length} trades, ` +
      `${wins.length + partialWins.length}W ${losses.length}L ${openTrades.length} open`
    );
  }

  return summary;
}
