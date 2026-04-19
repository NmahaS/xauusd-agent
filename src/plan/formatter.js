// Telegram HTML message formatting.
// Emojis: 🟢 bullish, 🔴 bearish, ⚪ neutral, ⏸ no-trade, 🔥 kill zone, ⚠ warning, 📅 calendar.

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

export function formatPlanForTelegram(plan, extras = {}) {
  const { dxy, metals, sentiment, fred, calendar, session } = extras;
  const biasEmoji = BIAS_EMOJI[plan.bias] ?? '⚪';
  const qualityEmoji = QUALITY_EMOJI[plan.setupQuality] ?? '';
  const killZoneIcon = session?.inKillZone ? ' 🔥' : '';

  const lines = [];
  lines.push(`<b>${biasEmoji} XAU/USD — ${esc(plan.bias.toUpperCase())} | ${esc(plan.setupQuality)} ${qualityEmoji}</b>`);
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
    lines.push(`<b>POI:</b> ${esc(plan.poi.type)} @ [${fmt(plan.poi.zone[0])} – ${fmt(plan.poi.zone[1])}]`);
    lines.push(`  <i>${esc(plan.poi.reasoning)}</i>`);
    lines.push(`<b>Entry:</b> ${esc(plan.entry.trigger)} @ ${fmt(plan.entry.price)}`);
    lines.push(`  <i>${esc(plan.entry.confirmation)}</i>`);
    lines.push(`<b>Stop Loss:</b> ${fmt(plan.stopLoss.price)}${plan.stopLoss.pips != null ? ` (${fmt(plan.stopLoss.pips, 1)} pips)` : ''}`);
    lines.push(`  <i>${esc(plan.stopLoss.reasoning)}</i>`);
    if (plan.takeProfits?.length) {
      plan.takeProfits.forEach((tp, i) => {
        lines.push(`<b>TP${i + 1}:</b> ${fmt(tp.price)} (RR ${fmt(tp.rr, 2)})`);
        lines.push(`  <i>${esc(tp.reasoning)}</i>`);
      });
    }
    if (plan.invalidation) {
      lines.push(`<b>Invalidation:</b> ${fmt(plan.invalidation.price)}`);
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

  return lines.join('\n');
}
