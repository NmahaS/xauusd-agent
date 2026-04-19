const URL = 'https://api.alternative.me/fng/?limit=7&format=json';

function classify(value) {
  if (value == null) return 'unknown';
  if (value <= 24) return 'extreme fear';
  if (value <= 45) return 'fear';
  if (value <= 55) return 'neutral';
  if (value <= 74) return 'greed';
  return 'extreme greed';
}

function goldImpact(value) {
  if (value == null) return 'unknown';
  if (value <= 24) return 'bullish for gold (safe haven demand)';
  if (value >= 75) return 'bearish for gold (risk-on)';
  return 'neutral for gold';
}

function trend(series) {
  if (series.length < 2) return 'unknown';
  const first = series[series.length - 1];
  const last = series[0];
  const diff = last - first;
  if (Math.abs(diff) < 3) return 'stable';
  return diff > 0 ? 'rising (risk-on)' : 'falling (risk-off)';
}

export async function fetchSentiment() {
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Sentiment HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.data) || json.data.length === 0) {
      throw new Error('Sentiment unexpected shape');
    }
    const series = json.data.map(d => parseInt(d.value, 10));
    const current = series[0];
    const classification = classify(current);
    const impact = goldImpact(current);
    const t = trend(series);
    console.log(`[sentiment] F&G=${current} (${classification}) 7d trend=${t}`);
    return {
      ok: true,
      value: current,
      classification,
      trend: t,
      goldImpact: impact,
      series,
    };
  } catch (err) {
    console.warn(`[sentiment] failed: ${err.message}`);
    return {
      ok: false,
      value: null,
      classification: 'unknown',
      trend: 'unknown',
      goldImpact: 'unknown',
      series: [],
      error: err.message,
    };
  }
}
