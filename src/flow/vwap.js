// VWAP (Volume Weighted Average Price) with standard deviation bands.
// Institutional benchmark: buy below VWAP, sell above.

export function computeVWAP(candles, period = 'day') {
  const now = new Date();
  let cutoff;
  if (period === 'week') {
    cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else {
    cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  const relevant = candles.filter(c => new Date(c.time) >= cutoff);
  if (relevant.length === 0) return null;

  let sumPV = 0;
  let sumV = 0;
  for (const c of relevant) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    sumPV += tp * vol;
    sumV += vol;
  }
  const vwap = sumPV / sumV;

  let sumSqDev = 0;
  for (const c of relevant) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    sumSqDev += vol * (tp - vwap) ** 2;
  }
  const stdDev = Math.sqrt(sumSqDev / sumV);

  return {
    vwap: parseFloat(vwap.toFixed(2)),
    upper1: parseFloat((vwap + stdDev).toFixed(2)),
    upper2: parseFloat((vwap + 2 * stdDev).toFixed(2)),
    lower1: parseFloat((vwap - stdDev).toFixed(2)),
    lower2: parseFloat((vwap - 2 * stdDev).toFixed(2)),
    period,
    candleCount: relevant.length,
  };
}

export function getVWAPSignal(currentPrice, dailyVWAP, weeklyVWAP) {
  const signals = [];

  if (dailyVWAP && currentPrice != null) {
    const pctFromVWAP = ((currentPrice - dailyVWAP.vwap) / dailyVWAP.vwap * 100).toFixed(2);
    if (currentPrice > dailyVWAP.upper2) signals.push(`2σ above daily VWAP (${dailyVWAP.vwap}) — extremely overbought`);
    else if (currentPrice > dailyVWAP.upper1) signals.push(`1σ above daily VWAP (${dailyVWAP.vwap}) — overbought`);
    else if (currentPrice < dailyVWAP.lower2) signals.push(`2σ below daily VWAP (${dailyVWAP.vwap}) — extremely oversold`);
    else if (currentPrice < dailyVWAP.lower1) signals.push(`1σ below daily VWAP (${dailyVWAP.vwap}) — oversold`);
    else signals.push(`Near daily VWAP (${pctFromVWAP}% from ${dailyVWAP.vwap})`);
  }

  if (weeklyVWAP && currentPrice != null) {
    if (currentPrice > weeklyVWAP.vwap) signals.push(`Above weekly VWAP ${weeklyVWAP.vwap} — bullish institutional bias`);
    else signals.push(`Below weekly VWAP ${weeklyVWAP.vwap} — bearish institutional bias`);
  }

  const institutionalBias = weeklyVWAP && currentPrice != null
    ? (currentPrice > weeklyVWAP.vwap ? 'bullish' : 'bearish')
    : 'unknown';

  if (dailyVWAP || weeklyVWAP) {
    console.log(`[vwap] daily=${dailyVWAP?.vwap ?? 'n/a'} weekly=${weeklyVWAP?.vwap ?? 'n/a'} institutionalBias=${institutionalBias}`);
  }

  return {
    dailyVWAP: dailyVWAP?.vwap ?? null,
    weeklyVWAP: weeklyVWAP?.vwap ?? null,
    dailyUpper1: dailyVWAP?.upper1 ?? null,
    dailyLower1: dailyVWAP?.lower1 ?? null,
    signals,
    institutionalBias,
  };
}
