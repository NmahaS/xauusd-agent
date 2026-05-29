const end = Date.now();
const start = end - (120 * 24 * 60 * 60 * 1000); // 120 days back

// Fetch in chunks (HL returns max ~500 candles per request)
async function fetchAllCandles(coin, interval, startTime, endTime) {
  const all = [];
  const intervalMs = interval === '15m' ? 15*60*1000 : 60*60*1000;
  const chunkSize = 500 * intervalMs;
  let cur = startTime;

  while (cur < endTime) {
    const chunkEnd = Math.min(cur + chunkSize, endTime);
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin, interval, startTime: cur, endTime: chunkEnd }
      })
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) all.push(...data);
    cur = chunkEnd;
    await new Promise(r => setTimeout(r, 200));
  }

  // Deduplicate
  const seen = new Set();
  return all.filter(c => seen.has(c.t) ? false : seen.add(c.t))
    .sort((a,b) => a.t - b.t)
    .map(x => ({
      time: new Date(x.t).toISOString(),
      open: parseFloat(x.o),
      high: parseFloat(x.h),
      low: parseFloat(x.l),
      close: parseFloat(x.c),
    }));
}

console.log('Fetching 120 days of M15 candles...');
const c = await fetchAllCandles('PAXG', '15m', start, end);
console.log('Total candles:', c.length);

function ema(data, period) {
  const k = 2 / (period + 1);
  let v = data[0];
  return data.map(d => (v = d * k + v * (1 - k)));
}

function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const p = candles[i-1];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });
  let val = trs.slice(0, period).reduce((a,b) => a+b) / period;
  const result = [];
  for (let i = period; i < trs.length; i++) {
    val = (val * (period-1) + trs[i]) / period;
    result.push({ idx: i, atr: val });
  }
  return result;
}

const closes = c.map(x => x.close);
const ema20 = ema(closes, 20);
const ema50 = ema(closes, 50);
const atrs = calcATR(c, 14);
const atrMap = new Map(atrs.map(a => [a.idx, a.atr]));

let wins = 0, losses = 0, trades = [];

for (let i = 60; i < c.length - 40; i++) {
  const atrVal = atrMap.get(i);
  if (!atrVal) continue;
  if (trades.length >= 100) break;

  let direction = null;
  if (ema20[i-1] < ema50[i-1] && ema20[i] >= ema50[i]) direction = 'long';
  if (ema20[i-1] > ema50[i-1] && ema20[i] <= ema50[i]) direction = 'short';
  if (!direction) continue;

  const entry = c[i].close;
  const sl = direction === 'long' ? entry - atrVal : entry + atrVal;
  const tp = direction === 'long' ? entry + (atrVal * 2) : entry - (atrVal * 2);

  let result = 'open';
  for (let j = i+1; j < Math.min(i+81, c.length); j++) {
    if (direction === 'long') {
      if (c[j].low <= sl)  { result = 'loss'; break; }
      if (c[j].high >= tp) { result = 'win';  break; }
    } else {
      if (c[j].high >= sl) { result = 'loss'; break; }
      if (c[j].low <= tp)  { result = 'win';  break; }
    }
  }

  if (result === 'open') continue;
  if (result === 'win') wins++;
  if (result === 'loss') losses++;
  trades.push({
    time: c[i].time.slice(0,16),
    direction,
    entry: entry.toFixed(2),
    sl: sl.toFixed(2),
    tp: tp.toFixed(2),
    atr: atrVal.toFixed(2),
    result,
  });
}

const total = wins + losses;
const wr = total > 0 ? ((wins/total)*100).toFixed(1) : 0;
const exp = total > 0 ? ((wins/total * 2) - (losses/total * 1)).toFixed(3) : 0;
const netR = (wins*2 - losses).toFixed(1);

console.log('');
console.log('═══════════════════════════════════════');
console.log('  BACKTEST — PAXG/USDC M15 (120 days)');
console.log('  Entry: EMA20/50 cross on M15');
console.log('  SL: 1x ATR | TP: 2R');
console.log('  Max hold: 20 hours (80 candles)');
console.log('═══════════════════════════════════════');
console.log('  Trades:     ', total);
console.log('  Wins:       ', wins);
console.log('  Losses:     ', losses);
console.log('  Win Rate:   ', wr + '%');
console.log('  Expectancy: ', exp, 'R per trade');
console.log('  Net R:      ', netR + 'R');
console.log('═══════════════════════════════════════');

if (parseFloat(exp) > 0) {
  console.log('  POSITIVE EV at 2R TP');
  console.log('  At 1% risk: +' + (parseFloat(exp)*100).toFixed(2) + '% per trade avg');
} else {
  console.log('  NEGATIVE EV at 2R TP');
  const breakEvenWR = (1 / (1 + 2) * 100).toFixed(1);
  console.log('  Break-even WR needed: ' + breakEvenWR + '%');
  console.log('  Actual WR: ' + wr + '%');
  if (parseFloat(wr) > 40) {
    console.log('  Try 1.5R TP: EV = ' + ((wins/total*1.5) - (losses/total)).toFixed(3));
  }
}

console.log('');
console.log('All trades:');
trades.forEach((t, i) => {
  const n = String(i+1).padStart(3);
  const r = t.result === 'win' ? 'WIN ' : 'LOSS';
  console.log(n, r, t.time, t.direction.toUpperCase(), 'entry:'+t.entry, 'atr:'+t.atr);
});
