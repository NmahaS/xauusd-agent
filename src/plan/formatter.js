// Telegram HTML message formatting.
// Emojis: 🟢 bullish, 🔴 bearish, ⚪ neutral, ⏸ no-trade, 🔥 kill zone, ⚠ warning, 📅 calendar.

import { config } from '../config.js';

const CURRENCY_PREFIX = {
  AUD: 'A$',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

function currencyPrice(v, currency, d = 2) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  const prefix = CURRENCY_PREFIX[currency] ?? `${currency} `;
  const num = typeof v === 'number' ? v.toFixed(d) : String(v);
  return `${prefix}${num}`;
}

const BIAS_EMOJI = {
  bullish: '🟢',
  bearish: '🔴',
  neutral: '⚪',
};

const QUALITY_EMOJI = {
  'A+': '⭐⭐⭐',
  'A': '⭐⭐',
  'B': '⭐',
  'no-trade': '⏸',
};

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(v, d = 2) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  return typeof v === 'number' ? v.toFixed(d) : String(v);
}

function pct(v) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function minsUntilNextRun(timestampIso) {
  const min = new Date(timestampIso).getUTCMinutes();
  return min < 5 ? 5 - min : 65 - min;
}

function fmtSign(v) {
  if (v == null) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}R`;
}

export function formatPlanForTelegram(plan, extras = {}) {
  const { dxy, metals, sentiment, fred, calendar, session, dailySummary } = extras;
  const biasEmoji = BIAS_EMOJI[plan.bias] ?? '⚪';
  const qualityEmoji = QUALITY_EMOJI[plan.setupQuality] ?? '';
  const killZoneIcon = session?.inKillZone ? ' 🔥' : '';

  const currency = extras.currency ?? config.CURRENCY ?? 'USD';
  const cp = (v, d = 2) => currencyPrice(v, currency, d);

  const lines = [];
  lines.push(`<b>${biasEmoji} 🥇 ${esc(plan.symbol)} Futures — ${esc(plan.bias.toUpperCase())} | ${esc(plan.setupQuality)} ${qualityEmoji}</b>`);
  lines.push(`<i>${esc(plan.timestamp)} UTC</i>${killZoneIcon}`);
  lines.push('');

  // Cross-asset context line
  const xsParts = [];
  if (dxy?.last != null) xsParts.push(`${esc(dxy.symbol ?? 'DXY')} ${fmt(dxy.last, 5)} (${pct(dxy.change24hPct)})`);
  if (metals?.auAg != null) xsParts.push(`Au/Ag ${fmt(metals.auAg, 1)}`);
  if (metals?.auPt != null) xsParts.push(`Au/Pt ${fmt(metals.auPt, 2)}`);
  if (sentiment?.value != null) xsParts.push(`F&amp;G ${fmt(sentiment.value, 0)}`);
  if (fred?.tenYearYield != null) xsParts.push(`10Y ${fmt(fred.tenYearYield, 2)}%`);
  if (xsParts.length) {
    lines.push(`<b>Cross-asset:</b> ${xsParts.join(' | ')}`);
    lines.push('');
  }

  lines.push(`<b>Macro:</b> ${esc(plan.macroContext)}`);
  lines.push('');

  lines.push(`<b>Confluence:</b> ${plan.confluenceCount}`);
  if (plan.confluenceFactors.length) {
    for (const f of plan.confluenceFactors) {
      lines.push(`  • ${esc(f)}`);
    }
  }
  lines.push('');

  lines.push(`<b>Bias rationale:</b> ${esc(plan.biasReasoning)}`);
  lines.push('');

  if (plan.direction && plan.poi && plan.entry && plan.stopLoss) {
    lines.push(`<b>Direction:</b> ${esc(plan.direction.toUpperCase())}`);
    lines.push(`<b>POI:</b> ${esc(plan.poi.type)} @ [${cp(plan.poi.zone[0])} – ${cp(plan.poi.zone[1])}]`);
    lines.push(`  <i>${esc(plan.poi.reasoning)}</i>`);
    lines.push(`<b>Entry:</b> ${esc(plan.entry.trigger)} @ ${cp(plan.entry.price)}`);
    lines.push(`  <i>${esc(plan.entry.confirmation)}</i>`);
    lines.push(`<b>Stop Loss:</b> ${cp(plan.stopLoss.price)}${plan.stopLoss.pips != null ? ` (${fmt(plan.stopLoss.pips, 1)} pips)` : ''}`);
    lines.push(`  <i>${esc(plan.stopLoss.reasoning)}</i>`);
    if (plan.takeProfits?.length) {
      plan.takeProfits.forEach((tp, i) => {
        lines.push(`<b>TP${i + 1}:</b> ${cp(tp.price)} (RR ${fmt(tp.rr, 2)})`);
        lines.push(`  <i>${esc(tp.reasoning)}</i>`);
      });
    }
    if (plan.invalidation) {
      lines.push(`<b>Invalidation:</b> ${cp(plan.invalidation.price)}`);
      lines.push(`  <i>${esc(plan.invalidation.reasoning)}</i>`);
    }
  } else {
    lines.push(`<b>⏸ No trade this hour.</b>`);
  }
  lines.push('');

  lines.push(`<b>Session:</b> ${esc(plan.session.current)} — ${esc(plan.session.recommendedExecutionWindow)}`);
  lines.push(`<b>Risk:</b> ${fmt(plan.risk.suggestedRiskPct, 2)}% — ${esc(plan.risk.positionSizeHint)}`);

  const upcoming = (calendar?.events || []).slice(0, 3);
  if (upcoming.length) {
    lines.push('');
    lines.push(`<b>📅 Upcoming events:</b>`);
    for (const e of upcoming) {
      const flag = e.goldRelevant ? '⚠ ' : '';
      lines.push(`  ${flag}+${e.minutesAway}m ${esc(e.country)} ${esc(e.title)} (${esc(e.impact)})`);
    }
  }

  if (plan.warnings.length) {
    lines.push('');
    lines.push(`<b>⚠ Warnings:</b>`);
    for (const w of plan.warnings) {
      lines.push(`  • ${esc(w)}`);
    }
  }

  // Daily stats footer
  lines.push('');
  if (dailySummary) {
    const { trades, noTrades, wins: w, dailyRR: rr } = dailySummary;
    const nextMin = minsUntilNextRun(plan.timestamp);

    if (trades === 0) {
      lines.push(`<i>📊 Today: 0 trades · ${noTrades} skip | Waiting for setup... · ~${nextMin}m</i>`);
    } else if (w.open > 0 && (w.total + w.losses) === 0) {
      lines.push(`<i>📊 Today: ${w.open} open · ${noTrades} skip | Tracking... · ~${nextMin}m</i>`);
    } else {
      const longN = dailySummary.directions?.long ?? 0;
      const shortN = dailySummary.directions?.short ?? 0;
      const dirStr = [longN && `${longN} long`, shortN && `${shortN} short`].filter(Boolean).join(' · ');
      const rrStr = [rr.avgRR_TP1, rr.avgRR_TP2, rr.avgRR_TP3]
        .map(v => v != null ? v.toFixed(1) : '-')
        .join('/');
      lines.push(
        `<i>📊 Today: ${dirStr} | ${w.total}W ${w.losses}L (${w.winRate}) · Net: ${fmtSign(rr.netRR)} · Avg: ${rrStr}R (TP1/2/3) | ${noTrades} skip · ~${nextMin}m</i>`
      );
      if (rr.bestSetup) {
        const b = rr.bestSetup;
        lines.push(`<i>🏆 Best: ${b.hour}:00 ${esc(b.quality)} ${esc(b.direction)} ${fmtSign(b.rr)}</i>`);
      }
    }
  } else {
    lines.push(`<i>📊 ~${minsUntilNextRun(plan.timestamp)}m to next run</i>`);
  }

  return lines.join('\n');
}

export function formatMonthlyReportForTelegram(report) {
  const { month, summary: s, winLoss: wl, rrAnalysis: rr, breakdowns: bd, insights } = report;
  const year = month.slice(0, 4);
  const monthName = new Date(`${month}-01`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const lines = [];

  lines.push(`<b>📊 XAUUSD Monthly Report — ${monthName} ${year}</b>`);
  lines.push('');
  lines.push(`📈 ${s.totalDays} days · ${s.totalTrades} trades · ${s.totalNoTrades} skip`);
  lines.push('');
  lines.push(`<b>🏆 Performance:</b>`);
  lines.push(`  Win rate: ${wl.winRate} (${wl.wins}W / ${wl.losses}L${wl.partialWins ? ` / ${wl.partialWins}P` : ''})`);
  lines.push(`  Net RR: ${fmtSign(rr.totalNetRR)}`);
  lines.push(`  Avg win: +${(wl.avgWinRR ?? 0).toFixed(2)}R | Avg loss: ${(wl.avgLossRR ?? 0).toFixed(2)}R`);
  lines.push(`  Expectancy: +${(wl.expectancy ?? 0).toFixed(2)}R per trade`);
  lines.push(`  Profit factor: ${(wl.profitFactor ?? 0).toFixed(1)}x`);
  lines.push('');

  if (bd?.byQuality) {
    lines.push(`<b>📊 By Quality:</b>`);
    for (const [q, v] of Object.entries(bd.byQuality)) {
      lines.push(`  ${q}: ${v.winRate} WR · ${(v.avgRR ?? 0).toFixed(1)}R avg (${v.count} trades)`);
    }
    lines.push('');
  }

  if (bd?.bySession) {
    lines.push(`<b>🕐 By Session:</b>`);
    const sessions = Object.entries(bd.bySession).sort((a, b) => (b[1].netRR ?? 0) - (a[1].netRR ?? 0));
    for (const [sess, v] of sessions) {
      const tag = sess === sessions[0][0] ? ' (best)' : sess === sessions[sessions.length - 1][0] ? ' (worst)' : '';
      lines.push(`  ${sess}: ${v.winRate} WR · ${fmtSign(v.netRR)} net${tag}`);
    }
    lines.push('');
  }

  if (bd?.byDayOfWeek) {
    const days = Object.entries(bd.byDayOfWeek);
    const best = days.reduce((a, b) => parseFloat(b[1].winRate) > parseFloat(a[1].winRate) ? b : a);
    const worst = days.reduce((a, b) => parseFloat(b[1].winRate) < parseFloat(a[1].winRate) ? b : a);
    lines.push(`<b>📅 By Day:</b>`);
    lines.push(`  Best: ${best[0]} (${best[1].winRate} WR)`);
    lines.push(`  Worst: ${worst[0]} (${worst[1].winRate} WR)`);
    lines.push('');
  }

  if (rr.bestSingleTrade) {
    const bt = rr.bestSingleTrade;
    lines.push(`🔥 Best: ${bt.date} ${bt.hour}:00 ${esc(bt.quality ?? '')} +${(bt.actualRR ?? 0).toFixed(1)}R`);
  }
  if (wl.longestLoseStreak?.count > 1) {
    lines.push(`💀 Worst streak: ${wl.longestLoseStreak.count} consecutive losses`);
  }

  if (insights?.length) {
    lines.push('');
    for (const ins of insights) {
      lines.push(`💡 ${esc(ins)}`);
    }
  }

  return lines.join('\n');
}
