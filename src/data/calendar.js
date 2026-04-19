const URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

const GOLD_KEYWORDS = [
  'nfp', 'non-farm', 'non farm', 'nonfarm',
  'cpi', 'ppi', 'pce',
  'fomc', 'rate decision', 'interest rate', 'powell',
  'jobless', 'unemployment',
  'gdp', 'ism', 'inflation',
  'retail sales', 'consumer confidence',
];

function isGoldRelevant(title) {
  const lower = (title || '').toLowerCase();
  return GOLD_KEYWORDS.some(k => lower.includes(k));
}

function parseEventDate(event) {
  // faireconomy mirror: `date` ISO string (UTC), plus `country`, `title`, `impact`
  if (!event.date) return null;
  const d = new Date(event.date);
  if (isNaN(d.getTime())) return null;
  return d;
}

export async function fetchCalendar() {
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('Calendar unexpected shape');

    const now = Date.now();
    const next24h = now + 24 * 60 * 60 * 1000;
    const next2h = now + 2 * 60 * 60 * 1000;

    const upcoming = [];
    const warnings = [];

    for (const ev of json) {
      const when = parseEventDate(ev);
      if (!when) continue;
      const ts = when.getTime();
      if (ts < now || ts > next24h) continue;
      const impact = (ev.impact || '').toLowerCase();
      if (impact !== 'high' && impact !== 'medium') continue;

      const goldRelevant = isGoldRelevant(ev.title);
      const entry = {
        time: when.toISOString(),
        minutesAway: Math.round((ts - now) / 60000),
        country: ev.country || '',
        title: ev.title || '',
        impact: ev.impact || '',
        forecast: ev.forecast || '',
        previous: ev.previous || '',
        goldRelevant,
      };
      upcoming.push(entry);

      if (goldRelevant && ts <= next2h) {
        warnings.push(
          `High-impact gold event in ${entry.minutesAway}min: ${entry.country} ${entry.title} (${entry.impact})`
        );
      }
    }

    upcoming.sort((a, b) => a.minutesAway - b.minutesAway);
    console.log(`[calendar] ${upcoming.length} events in next 24h, ${warnings.length} warnings`);
    return { ok: true, events: upcoming, warnings };
  } catch (err) {
    console.warn(`[calendar] failed: ${err.message}`);
    return { ok: false, events: [], warnings: [], error: err.message };
  }
}
