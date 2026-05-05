// Telegram HTML message formatting for XAU/USDC perpetual on Hyperliquid.
// Emojis: 🟢 bullish, 🔴 bearish, ⚪ neutral, ⏸ no-trade, 🔥 kill zone, ⚠ warning, 📅 calendar.

function usdPrice(v, d = 2) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  const num = typeof v === 'number' ? v.toFixed(d) : String(v);
  return `$${num}`;
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
  const { dxy, sentiment, fred, calendar, session, dailySummary, funding, oraclePrice, currentPrice } = extras;
  const biasEmoji = BIAS_EMOJI[plan.bias] ?? '⚪';
  const qualityEmoji = QUALITY_EMOJI[plan.setupQuality] ?? '';
  const killZoneIcon = session?.inKillZone ? ' 🔥' : '';

  const cp = usdPrice;

  const lines = [];
  lines.push(`<b>${biasEmoji} 🥇 ${esc(plan.symbol)} Perp — ${esc(plan.bias.toUpperCase())} | ${esc(plan.setupQuality)} ${qualityEmoji}</b>`);
  lines.push(`<i>${esc(plan.timestamp)} UTC</i>${killZoneIcon}`);

  // Price + funding line
  if (currentPrice != null) {
    const fundingPct = funding != null ? `${funding >= 0 ? '+' : ''}${(funding * 100).toFixed(4)}%/hr` : 'n/a';
    const fundingSignal = funding > 0.0001 ? '⚠ crowded long' : funding < -0.0001 ? '⚠ crowded short' : '✅ balanced';
    lines.push(`Price: <b>${cp(currentPrice)}</b>  Funding: ${fundingPct} ${fundingSignal}`);
    if (oraclePrice != null) {
      const gap = Math.abs(currentPrice - oraclePrice).toFixed(2);
      lines.push(`Oracle: ${cp(oraclePrice)}  Gap: ${gap}pts`);
    }
  }
  lines.push('');

  // Cross-asset context line
  const xsParts = [];
  if (dxy?.last != null) xsParts.push(`EUR/USD ${fmt(dxy.last, 5)} (${pct(dxy.change24hPct)})`);
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
    const shownC = plan.confluenceFactors.slice(0, 8);
    const remainC = plan.confluenceFactors.length - shownC.length;
    for (const f of shownC) lines.push(`  • ${esc(f)}`);
    if (remainC > 0) lines.push(`  <i>... +${remainC} more</i>`);
  }
  lines.push('');

  lines.push(`<b>Bias rationale:</b> ${esc(plan.biasReasoning)}`);
  lines.push('');

  if (plan.consensus) {
    const c = plan.consensus;
    const agreeIcon = c.agreement === 'full' ? '🤝' : c.agreement === 'split' ? '⚔️' : '🔔';
    lines.push(
      `<b>${agreeIcon} Consensus:</b> ${c.agreement} (${c.confidence}) ` +
      `— Claude: ${c.claudeDirection ?? c.claudeQuality ?? 'n/a'} ` +
      `/ DeepSeek: ${c.deepseekDirection ?? 'n/a'}`
    );
    if (c.newsRisk && c.newsRisk !== 'low') {
      lines.push(`  <i>News risk: ${esc(c.newsRisk)}${c.newsHeadline ? ` — ${esc(c.newsHeadline)}` : ''}</i>`);
    }
    lines.push('');
  }

  // Three-layer analysis block
  if (plan.threeLayer) {
    const tl = plan.threeLayer;
    const aaT3 = tl.tier === 3 && ['A+', 'A'].includes(plan.setupQuality);
    const tierIcon = tl.tier === 1 ? '⚡' : tl.tier === 2 ? '✅' : aaT3 ? '✅' : tl.tier === 3 ? '📋' : '⛔';
    const tierRisk = tl.tier === 1 ? 'Risk: 1.5%' : tl.tier === 2 ? 'Risk: 1%' : aaT3 ? 'Risk: 0.5% (reduced)' : tl.tier === 3 ? 'Manual only' : 'No trade';
    const macro = tl.layers?.macro?.bias?.toUpperCase() || 'n/a';
    const regime = tl.layers?.flow?.regime || 'unknown';
    const techCount = tl.layers?.technical?.confluenceCount ?? 0;
    lines.push(`<b>🔬 3-Layer:</b> Macro ${esc(macro)} | ${esc(regime)} | ${techCount}/12 confluence`);
    lines.push(`${tierIcon} <b>${esc(tl.tierLabel)}</b> — ${tierRisk}`);
    if (tl.blockingFactors?.length) lines.push(`  ⛔ ${esc(tl.blockingFactors[0])}`);
    lines.push('');
  }

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

  // M15 + execution status
  const m15 = plan.m15;
  const exec = plan.execution;
  if (m15?.status && m15.status !== 'N/A') {
    const m15icon = m15.status === 'CONFIRMED' ? '✅' : m15.status === 'PENDING' ? '⏳' : '⏸';
    lines.push(`<b>${m15icon} M15:</b> ${m15.status}${m15.reason ? ` — ${esc(m15.reason)}` : ''}`);
  }
  if (exec) {
    if (exec.executed) {
      lines.push(
        `<b>🚀 Executed:</b> Order ${esc(exec.orderId ?? 'n/a')} | ` +
        `${exec.size} XAU | $${exec.riskAmount} (${exec.riskPct}%)`
      );
    } else if (exec.autoTradeEnabled) {
      lines.push(`<b>⏸ Auto-trade blocked:</b> ${esc(exec.reason)}`);
    }
  }
  if ((m15?.status && m15.status !== 'N/A') || exec) lines.push('');

  // Manual-only signal banners
  if (plan.direction && plan.entry && plan.stopLoss) {
    if (plan.setupQuality === 'B') {
      const bTier = plan.threeLayer?.tier ?? 4;
      if (bTier <= 2) {
        const bRisk = bTier === 1 ? '1.0%' : '0.5%';
        lines.push(
          `🟡 <b>B SIGNAL — Tier ${bTier} auto-execute</b>\n` +
          `⚡ 3-layer alignment qualifies B for execution\n` +
          `Risk: ${bRisk} (half size — B quality caution)`
        );
      } else {
        const bReason = bTier === 3
          ? 'Macro not aligned — technical signal only'
          : 'Insufficient alignment for execution';
        lines.push(
          `📋 <b>B SIGNAL — Tier ${bTier} manual only</b>\n` +
          `${bReason}`
        );
      }
      lines.push('');
    } else if (['A+', 'A'].includes(plan.setupQuality) && plan.threeLayer?.tier === 3) {
      lines.push(
        `⚡ <b>${esc(plan.setupQuality)} Tier 3 — technical only</b>\n` +
        `Auto-executing at reduced risk (0.5%)\n` +
        `⚠️ Macro not aligned — proceed with caution`
      );
      lines.push('');
    } else if (['A+', 'A'].includes(plan.setupQuality) && plan.consensus?.agreement !== 'full' && plan.consensus) {
      const c = plan.consensus;
      lines.push(
        `⚠️ <b>SPLIT SIGNAL — manual only</b>\n` +
        `Claude: ${esc(c.claudeDirection ?? 'n/a')} | DeepSeek: ${esc(c.deepseekDirection ?? 'n/a')}\n` +
        `Entry: ${cp(plan.entry.price)} if you agree`
      );
      lines.push('');
    }
  }

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
    const shownW = plan.warnings.slice(0, 5);
    const remainW = plan.warnings.length - shownW.length;
    for (const w of shownW) lines.push(`  • ${esc(w)}`);
    if (remainW > 0) lines.push(`  <i>... +${remainW} more</i>`);
  }

  const newsResult = extras.newsResult;
  if (newsResult?.hasBreakingNews) {
    lines.push('');
    lines.push(
      `<b>📰 Breaking news:</b> ${esc(newsResult.headline ?? newsResult.sentiment)} ` +
      `(risk: ${esc(newsResult.riskLevel)})`
    );
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

  const msg = truncateMessage(lines.join('\n'));
  console.log(`[telegram] message length: ${msg.length}`);
  return msg;
}

function truncateMessage(msg, maxLength = 4000) {
  if (msg.length <= maxLength) return msg;
  const truncated = msg.slice(0, maxLength - 100);
  const lastNewline = truncated.lastIndexOf('\n');
  return truncated.slice(0, lastNewline) + '\n\n<i>... message truncated (too long)</i>';
}

export function formatOutcomeMessage(outcome, dailySummary = null) {
  const dirIcon = outcome.direction === 'long' ? '🟢' : '🔴';
  const resultIcon = outcome.outcome === 'WIN' ? '🏆' : outcome.outcome === 'LOSS' ? '💀' : '⏸';
  const lines = [
    `<b>${resultIcon} Trade Closed — ${esc(outcome.symbol ?? 'XAU/USDC')}</b>`,
    '',
    `${dirIcon} ${(outcome.direction ?? '').toUpperCase()} @ $${outcome.entry?.toFixed(2) ?? 'n/a'}`,
    `Exit: $${outcome.exit?.toFixed(2) ?? 'n/a'} | Result: <b>${outcome.outcome ?? 'UNKNOWN'}</b>`,
    `Actual RR: ${outcome.actualRR != null ? (outcome.actualRR >= 0 ? '+' : '') + outcome.actualRR.toFixed(2) + 'R' : 'n/a'}`,
  ];
  if (dailySummary) {
    const { wins: w = {} } = dailySummary;
    lines.push('');
    lines.push(`<i>Today: ${w.total ?? 0}W / ${w.losses ?? 0}L</i>`);
  }
  return lines.join('\n');
}

export function formatM15ConfirmedMessage(plan) {
  const dirIcon = plan.direction === 'long' ? '🟢' : '🔴';
  const lines = [
    `<b>🎯 M15 Confirmed — ${esc(plan.symbol ?? 'XAU/USDC')}</b>`,
    '',
    `${dirIcon} ${(plan.direction ?? '').toUpperCase()} entry refined`,
    `Entry: $${plan.entry?.price?.toFixed(2) ?? 'n/a'} (${esc(plan.entry?.trigger ?? '')})`,
    `SL: $${plan.stopLoss?.price?.toFixed(2) ?? 'n/a'}`,
  ];
  if (plan.takeProfits?.length) {
    const tp1 = plan.takeProfits[0];
    lines.push(`TP1: $${tp1.price?.toFixed(2) ?? 'n/a'} (${tp1.rr?.toFixed(1) ?? '?'}R)`);
  }
  if (plan.m15?.reason) lines.push(`<i>${esc(plan.m15.reason)}</i>`);
  return lines.join('\n');
}

export function formatMonthlyReportForTelegram(report) {
  const { month, summary: s, winLoss: wl, rrAnalysis: rr, breakdowns: bd, insights } = report;
  const year = month.slice(0, 4);
  const monthName = new Date(`${month}-01`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const lines = [];

  lines.push(`<b>📊 XAU/USDC Monthly Report — ${monthName} ${year}</b>`);
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
