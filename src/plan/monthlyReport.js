import fs from 'node:fs/promises';
import path from 'node:path';

const PLANS_DIR = path.resolve('plans');

function r(v, d = 2) {
  if (v == null || Number.isNaN(v)) return null;
  return Math.round(v * 10 ** d) / 10 ** d;
}

function pct(num, denom) {
  if (!denom) return '0%';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Read all daily-summary.json files for a YYYY-MM month
async function loadDailySummaries(yearMonth) {
  let entries;
  try {
    entries = await fs.readdir(PLANS_DIR);
  } catch {
    return [];
  }

  const prefix = `${yearMonth}-`;
  const dirs = entries.filter(e => e.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(e));
  dirs.sort();

  const summaries = [];
  for (const dir of dirs) {
    const summaryPath = path.join(PLANS_DIR, dir, 'daily-summary.json');
    try {
      const raw = await fs.readFile(summaryPath, 'utf8');
      summaries.push(JSON.parse(raw));
    } catch {}
  }
  return summaries;
}

// Flatten all trade plan entries across daily summaries, sorted chronologically
function flattenTrades(summaries) {
  const trades = [];
  for (const s of summaries) {
    for (const p of s.plans ?? []) {
      trades.push({ date: s.date, ...p });
    }
  }
  return trades;
}

// Find consecutive win/loss streaks
function calcStreaks(trades) {
  const resolved = trades.filter(t =>
    t.outcome === 'win' || t.outcome === 'partial_win' || t.outcome === 'loss'
  );

  let maxWinStreak = 0, maxLossStreak = 0;
  let curWin = 0, curLoss = 0;
  let winStart = null, winEnd = null, lossStart = null, lossEnd = null;
  let bestWinStart = null, bestWinEnd = null, bestLossStart = null, bestLossEnd = null;

  for (const t of resolved) {
    const isWin = t.outcome === 'win' || t.outcome === 'partial_win';
    if (isWin) {
      if (curWin === 0) winStart = `${t.date} ${t.hour}:00`;
      curWin++;
      winEnd = `${t.date} ${t.hour}:00`;
      curLoss = 0;
      if (curWin > maxWinStreak) {
        maxWinStreak = curWin;
        bestWinStart = winStart;
        bestWinEnd = winEnd;
      }
    } else {
      if (curLoss === 0) lossStart = `${t.date} ${t.hour}:00`;
      curLoss++;
      lossEnd = `${t.date} ${t.hour}:00`;
      curWin = 0;
      if (curLoss > maxLossStreak) {
        maxLossStreak = curLoss;
        bestLossStart = lossStart;
        bestLossEnd = lossEnd;
      }
    }
  }

  return {
    maxConsecutiveWins: maxWinStreak,
    maxConsecutiveLosses: maxLossStreak,
    longestWinStreak: maxWinStreak > 0 ? { start: bestWinStart, end: bestWinEnd, count: maxWinStreak } : null,
    longestLoseStreak: maxLossStreak > 0 ? { start: bestLossStart, end: bestLossEnd, count: maxLossStreak } : null,
  };
}

// Generate 4-6 data-driven insights
function generateInsights(report) {
  const insights = [];
  const { summary: s, winLoss: wl, rrAnalysis: rr, breakdowns: bd, weeklyTrend } = report;

  // Best session
  if (bd.bySession) {
    const sessions = Object.entries(bd.bySession).filter(([, v]) => v.trades > 0);
    if (sessions.length > 1) {
      const best = sessions.reduce((a, b) => (b[1].netRR ?? 0) > (a[1].netRR ?? 0) ? b : a);
      const worst = sessions.reduce((a, b) => (b[1].netRR ?? 0) < (a[1].netRR ?? 0) ? b : a);
      insights.push(
        `${best[0].charAt(0).toUpperCase() + best[0].slice(1)} KZ: ${best[1].winRate} win rate with ` +
        `${(best[1].avgRR ?? 0).toFixed(1)}R avg — your best session`
      );
      if (worst[0] !== best[0] && (worst[1].netRR ?? 0) < 0) {
        insights.push(
          `${worst[0].charAt(0).toUpperCase() + worst[0].slice(1)} session: ${worst[1].winRate} WR · ` +
          `${(worst[1].netRR ?? 0).toFixed(1)}R net — consider avoiding`
        );
      }
    }
  }

  // Quality vs RR
  if (bd.byQuality?.['A+'] && bd.byQuality?.['B']) {
    const ap = bd.byQuality['A+'];
    const b = bd.byQuality['B'];
    if (ap.count > 0 && b.count > 0) {
      const diff = r(((ap.avgRR - b.avgRR) / Math.abs(b.avgRR)) * 100, 0);
      insights.push(
        `A+ setups: ${ap.winRate} win rate vs B at ${b.winRate} — ` +
        `quality filtering adds ${diff}% more RR`
      );
    }
  }

  // Long vs short
  if (bd.byDirection) {
    const lng = bd.byDirection.long;
    const sht = bd.byDirection.short;
    if (lng && sht && lng.trades > 0 && sht.trades > 0) {
      const dominant = lng.trades >= sht.trades ? 'long' : 'short';
      const ratio = r((Math.max(lng.trades, sht.trades) / (lng.trades + sht.trades)) * 100, 0);
      insights.push(`${dominant.charAt(0).toUpperCase() + dominant.slice(1)} bias dominated (${ratio}%) — consistent with monthly trend`);
    }
  }

  // Day-of-week: worst day
  if (bd.byDayOfWeek) {
    const days = Object.entries(bd.byDayOfWeek).filter(([, v]) => v.trades >= 3);
    if (days.length > 1) {
      const worst = days.reduce((a, b) => parseFloat(b[1].winRate) < parseFloat(a[1].winRate) ? b : a);
      if (parseFloat(worst[1].winRate) < 50) {
        insights.push(`${worst[0]} win rate drops to ${worst[1].winRate} — consider reducing size`);
      }
    }
  }

  // Trade rate check
  const tradeRate = parseFloat(s.tradeRate);
  if (tradeRate < 5) {
    insights.push(`Trade rate is very low (${s.tradeRate}) — agent may be too selective; review confluence thresholds`);
  } else if (tradeRate > 30) {
    insights.push(`Trade rate is high (${s.tradeRate}) — check if quality is being maintained`);
  }

  // Expectancy
  insights.push(
    `Expectancy: ${(wl.expectancy ?? 0).toFixed(2)}R per trade — ` +
    `${(wl.expectancy ?? 0) > 0 ? 'every trade is +EV' : 'expectancy is negative, review strategy'}`
  );

  // Weekly trend: flag any week >30% below average
  if (weeklyTrend?.length > 1) {
    const avgWR = weeklyTrend.reduce((s, w) => s + parseFloat(w.winRate), 0) / weeklyTrend.length;
    const weak = weeklyTrend.find(w => parseFloat(w.winRate) < avgWR * 0.7);
    if (weak) {
      insights.push(`Week ${weak.week} performance (${weak.winRate} WR) dropped >30% vs average — possible regime change`);
    }
  }

  // Max consecutive losses
  if (wl.maxConsecutiveLosses >= 4) {
    insights.push(`Max ${wl.maxConsecutiveLosses} consecutive losses — review drawdown management rules`);
  } else if (wl.maxConsecutiveLosses > 0) {
    insights.push(`Max ${wl.maxConsecutiveLosses} consecutive losses — drawdowns are contained`);
  }

  return insights.slice(0, 7);
}

export async function generateMonthlyReport(yearMonth) {
  const summaries = await loadDailySummaries(yearMonth);
  if (summaries.length === 0) return null;

  const allTrades = flattenTrades(summaries);
  const resolvedTrades = allTrades.filter(t =>
    t.outcome === 'win' || t.outcome === 'partial_win' || t.outcome === 'loss' || t.outcome === 'expired'
  );
  const wins = allTrades.filter(t => t.outcome === 'win' || t.outcome === 'partial_win');
  const losses = allTrades.filter(t => t.outcome === 'loss');
  const partialWins = allTrades.filter(t => t.outcome === 'partial_win');
  const expired = allTrades.filter(t => t.outcome === 'expired');

  const totalTrades = allTrades.length;
  const totalPlans = summaries.reduce((s, d) => s + d.totalPlans, 0);
  const totalNoTrades = summaries.reduce((s, d) => s + d.noTrades, 0);
  const resolvedCount = wins.length + losses.length;

  // RR analysis
  const winRRs = wins.map(t => t.actualRR ?? 0).filter(v => v > 0);
  const lossRRs = losses.map(t => t.actualRR ?? 0);
  const allActualRRs = resolvedTrades.map(t => t.actualRR ?? 0);
  const netRR = r(allActualRRs.reduce((s, v) => s + v, 0));
  const avgWinRR = winRRs.length ? r(winRRs.reduce((s, v) => s + v, 0) / winRRs.length) : 0;
  const avgLossRR = lossRRs.length ? r(lossRRs.reduce((s, v) => s + v, 0) / lossRRs.length) : -1;
  const avgActualRR = resolvedCount ? r(netRR / resolvedCount) : 0;

  const avgTP1 = r(summaries.reduce((s, d) => s + (d.dailyRR?.avgRR_TP1 ?? 0), 0) / summaries.length);
  const avgTP2 = r(summaries.reduce((s, d) => s + (d.dailyRR?.avgRR_TP2 ?? 0), 0) / summaries.length);
  const avgTP3 = r(summaries.reduce((s, d) => s + (d.dailyRR?.avgRR_TP3 ?? 0), 0) / summaries.length);
  const totalTP1 = r(summaries.reduce((s, d) => s + (d.dailyRR?.totalPotentialRR_TP1 ?? 0), 0));
  const totalTP2 = r(summaries.reduce((s, d) => s + (d.dailyRR?.totalPotentialRR_TP2 ?? 0), 0));
  const totalTP3 = r(summaries.reduce((s, d) => s + (d.dailyRR?.totalPotentialRR_TP3 ?? 0), 0));

  // Profit factor = sum of wins / abs sum of losses
  const grossWin = winRRs.reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(lossRRs.reduce((s, v) => s + v, 0));
  const profitFactor = grossLoss > 0 ? r(grossWin / grossLoss) : grossWin > 0 ? 999 : 0;

  // Expectancy = (winRate * avgWin) + (lossRate * avgLoss)
  const winRate = resolvedCount ? wins.length / resolvedCount : 0;
  const expectancy = r(winRate * avgWinRR + (1 - winRate) * avgLossRR);

  // Streaks
  const streaks = calcStreaks(allTrades);

  // Best/worst day
  const dayRRs = summaries.map(s => ({
    date: s.date,
    netRR: s.dailyRR?.netRR ?? 0,
    wins: s.wins?.total ?? 0,
    losses: s.wins?.losses ?? 0,
  })).filter(d => d.wins + d.losses > 0);

  const bestDay = dayRRs.length ? dayRRs.reduce((a, b) => b.netRR > a.netRR ? b : a) : null;
  const worstDay = dayRRs.length ? dayRRs.reduce((a, b) => b.netRR < a.netRR ? b : a) : null;

  // Best single trade
  const bestTrade = allTrades
    .filter(t => t.actualRR != null && t.actualRR > 0)
    .reduce((best, t) => (!best || t.actualRR > best.actualRR ? t : best), null);

  // Setup breakdown
  const byQuality = {};
  for (const q of ['A+', 'A', 'B']) {
    const qt = allTrades.filter(t => t.setupQuality === q);
    if (qt.length === 0) continue;
    const qw = qt.filter(t => t.outcome === 'win' || t.outcome === 'partial_win');
    const ql = qt.filter(t => t.outcome === 'loss');
    const qRRs = qt.map(t => t.actualRR ?? 0).filter(v => v !== 0);
    byQuality[q] = {
      count: qt.length,
      wins: qw.length,
      losses: ql.length,
      winRate: pct(qw.length, qt.length),
      avgRR: qRRs.length ? r(qRRs.reduce((s, v) => s + v, 0) / qRRs.length) : null,
      netRR: r(qRRs.reduce((s, v) => s + v, 0)),
    };
  }

  // Session breakdown
  const allSessions = [...new Set(allTrades.map(t => t.session).filter(Boolean))];
  const bySession = {};
  for (const sess of allSessions) {
    const st = allTrades.filter(t => t.session === sess);
    const sw = st.filter(t => t.outcome === 'win' || t.outcome === 'partial_win');
    const sl = st.filter(t => t.outcome === 'loss');
    const sRRs = st.map(t => t.actualRR ?? 0).filter(v => v !== 0);
    bySession[sess] = {
      trades: st.length,
      wins: sw.length,
      losses: sl.length,
      winRate: pct(sw.length, st.length),
      avgRR: sRRs.length ? r(sRRs.reduce((s, v) => s + v, 0) / sRRs.length) : null,
      netRR: r(sRRs.reduce((s, v) => s + v, 0)),
    };
  }

  // Direction breakdown
  const lngTrades = allTrades.filter(t => t.direction === 'long');
  const shtTrades = allTrades.filter(t => t.direction === 'short');
  const byDirection = {
    long: {
      trades: lngTrades.length,
      wins: lngTrades.filter(t => t.outcome === 'win' || t.outcome === 'partial_win').length,
      winRate: pct(lngTrades.filter(t => t.outcome === 'win' || t.outcome === 'partial_win').length, lngTrades.length),
      netRR: r(lngTrades.map(t => t.actualRR ?? 0).reduce((s, v) => s + v, 0)),
    },
    short: {
      trades: shtTrades.length,
      wins: shtTrades.filter(t => t.outcome === 'win' || t.outcome === 'partial_win').length,
      winRate: pct(shtTrades.filter(t => t.outcome === 'win' || t.outcome === 'partial_win').length, shtTrades.length),
      netRR: r(shtTrades.map(t => t.actualRR ?? 0).reduce((s, v) => s + v, 0)),
    },
  };

  // Day-of-week breakdown
  const byDayOfWeek = {};
  for (const s of summaries) {
    const dayName = DAY_NAMES[new Date(s.date + 'T12:00:00Z').getUTCDay()];
    if (!byDayOfWeek[dayName]) byDayOfWeek[dayName] = { trades: 0, wins: 0, losses: 0 };
    byDayOfWeek[dayName].trades += s.trades ?? 0;
    byDayOfWeek[dayName].wins += s.wins?.total ?? 0;
    byDayOfWeek[dayName].losses += s.wins?.losses ?? 0;
  }
  for (const v of Object.values(byDayOfWeek)) {
    v.winRate = pct(v.wins, v.trades);
  }

  // Weekly trend (by calendar week number within the month)
  const weekMap = {};
  for (const s of summaries) {
    const d = new Date(s.date + 'T12:00:00Z');
    const weekOfMonth = Math.ceil(d.getUTCDate() / 7);
    if (!weekMap[weekOfMonth]) weekMap[weekOfMonth] = { trades: 0, wins: 0, netRR: 0, qualities: [] };
    weekMap[weekOfMonth].trades += s.trades ?? 0;
    weekMap[weekOfMonth].wins += s.wins?.total ?? 0;
    weekMap[weekOfMonth].netRR += s.dailyRR?.netRR ?? 0;
    if (s.dailyRR?.bestSetup?.quality) weekMap[weekOfMonth].qualities.push(s.dailyRR.bestSetup.quality);
  }
  const weeklyTrend = Object.entries(weekMap)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([week, v]) => ({
      week: Number(week),
      trades: v.trades,
      wins: v.wins,
      winRate: pct(v.wins, v.trades),
      netRR: r(v.netRR),
      bestQuality: v.qualities.includes('A+') ? 'A+' : v.qualities.includes('A') ? 'A' : v.qualities[0] ?? null,
    }));

  // Average confluence
  const allConfluences = allTrades.map(t => t.confluenceCount).filter(v => v != null && v > 0);
  const avgConfluence = allConfluences.length
    ? r(allConfluences.reduce((s, v) => s + v, 0) / allConfluences.length)
    : null;

  const setupBreakdown = Object.fromEntries(
    ['A+', 'A', 'B', 'no-trade'].map(q => [
      q,
      summaries.reduce((s, d) => s + (d.setups?.[q] ?? 0), 0),
    ])
  );
  const dirBreakdown = {
    long: summaries.reduce((s, d) => s + (d.directions?.long ?? 0), 0),
    short: summaries.reduce((s, d) => s + (d.directions?.short ?? 0), 0),
  };

  const report = {
    month: yearMonth,
    generatedAt: new Date().toISOString(),
    summary: {
      totalDays: summaries.length,
      totalHours: totalPlans,
      totalPlans,
      totalTrades,
      totalNoTrades,
      tradeRate: pct(totalTrades, totalPlans),
      setupBreakdown,
      directionBreakdown: dirBreakdown,
    },
    winLoss: {
      wins: wins.length,
      losses: losses.length,
      partialWins: partialWins.length,
      expired: expired.length,
      winRate: pct(wins.length + partialWins.length, resolvedCount),
      profitFactor,
      avgWinRR,
      avgLossRR,
      expectancy,
      ...streaks,
    },
    rrAnalysis: {
      totalNetRR: netRR,
      avgRR_TP1: avgTP1,
      avgRR_TP2: avgTP2,
      avgRR_TP3: avgTP3,
      avgActualRR,
      bestDay: bestDay ? { date: bestDay.date, netRR: r(bestDay.netRR), wins: bestDay.wins, losses: bestDay.losses } : null,
      worstDay: worstDay ? { date: worstDay.date, netRR: r(worstDay.netRR), wins: worstDay.wins, losses: worstDay.losses } : null,
      bestSingleTrade: bestTrade
        ? { date: bestTrade.date, hour: bestTrade.hour, actualRR: bestTrade.actualRR, quality: bestTrade.setupQuality }
        : null,
      avgConfluence,
      qualityVsRR: Object.fromEntries(
        Object.entries(byQuality).map(([q, v]) => [q, { count: v.count, avgRR_TP1: v.avgRR }])
      ),
    },
    breakdowns: { byQuality, bySession, byDirection, byDayOfWeek },
    weeklyTrend,
    insights: [],
  };

  report.insights = generateInsights(report);
  return report;
}

export async function saveMonthlyReport(yearMonth, report) {
  const dir = path.join(PLANS_DIR, yearMonth);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'monthly-report.json');
  await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[monthly] report saved to plans/${yearMonth}/monthly-report.json`);
  return filePath;
}
