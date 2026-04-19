// Sessions (UTC): Asia 00-07, London 07-12, NY 12-17, Off 17-24
// Kill zones: London 07-10, NY 12-15

export function detectSession(date = new Date()) {
  const h = date.getUTCHours();
  let current;
  if (h >= 0 && h < 7) current = 'asia';
  else if (h >= 7 && h < 12) current = 'london';
  else if (h >= 12 && h < 17) current = 'ny';
  else current = 'off';

  const inKillZone =
    (h >= 7 && h < 10) || (h >= 12 && h < 15);
  const killZone = h >= 7 && h < 10 ? 'london-killzone'
                 : h >= 12 && h < 15 ? 'ny-killzone'
                 : null;

  let recommendedWindow;
  if (current === 'london' || current === 'ny') {
    recommendedWindow = inKillZone ? 'NOW (kill zone active)' : `current ${current} session`;
  } else if (current === 'asia') {
    recommendedWindow = 'wait for London open (07:00 UTC)';
  } else {
    recommendedWindow = 'wait for next London session';
  }

  return { current, inKillZone, killZone, recommendedWindow };
}

function rangeHighLow(candles) {
  if (!candles.length) return { high: null, low: null };
  let h = -Infinity, l = Infinity;
  for (const c of candles) {
    if (c.high > h) h = c.high;
    if (c.low < l) l = c.low;
  }
  return { high: h, low: l };
}

function startOfUtcDay(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return d;
}

function filterByUtcWindow(candles, startDate, startHourInclusive, endHourExclusive) {
  return candles.filter(c => {
    const t = new Date(c.time);
    if (isNaN(t.getTime())) return false;
    if (t.getUTCFullYear() !== startDate.getUTCFullYear()) return false;
    if (t.getUTCMonth() !== startDate.getUTCMonth()) return false;
    if (t.getUTCDate() !== startDate.getUTCDate()) return false;
    const h = t.getUTCHours();
    return h >= startHourInclusive && h < endHourExclusive;
  });
}

export function computeSessionLevels(h1Candles, now = new Date()) {
  const today = startOfUtcDay(now);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const asiaToday = filterByUtcWindow(h1Candles, today, 0, 7);
  const londonToday = filterByUtcWindow(h1Candles, today, 7, 12);
  const nyToday = filterByUtcWindow(h1Candles, today, 12, 17);

  const priorDay = h1Candles.filter(c => {
    const t = new Date(c.time);
    return t >= yesterday && t < today;
  });

  const priorWeek = h1Candles.filter(c => {
    const t = new Date(c.time);
    return t >= weekAgo && t < today;
  });

  return {
    asiaToday: rangeHighLow(asiaToday),
    londonToday: rangeHighLow(londonToday),
    nyToday: rangeHighLow(nyToday),
    priorDay: rangeHighLow(priorDay),
    priorWeek: rangeHighLow(priorWeek),
  };
}
