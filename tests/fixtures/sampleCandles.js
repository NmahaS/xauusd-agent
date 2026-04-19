// Realistic XAUUSD H1 fixture: 30 candles.
// Story: downtrend from ~2060 → local bounce at idx 6-8 → continued decline to swing low at idx 17 (2015) →
// DOWN-close candle at idx 19 (bullish OB candidate) → impulsive up-move with bullish FVG at idx 20 →
// breaks prior swing high of 2060 (CHoCH-bullish at idx 24, high 2068) → pullback to ~2052 → current close 2056.

export const sampleCandles = [
  { time: '2026-04-18T00:00:00Z', open: 2060, high: 2062, low: 2058, close: 2060 },
  { time: '2026-04-18T01:00:00Z', open: 2060, high: 2061, low: 2058, close: 2059 },
  { time: '2026-04-18T02:00:00Z', open: 2059, high: 2060, low: 2056, close: 2057 },
  { time: '2026-04-18T03:00:00Z', open: 2057, high: 2058, low: 2054, close: 2055 },
  { time: '2026-04-18T04:00:00Z', open: 2055, high: 2056, low: 2052, close: 2053 },
  { time: '2026-04-18T05:00:00Z', open: 2053, high: 2054, low: 2050, close: 2051 },
  { time: '2026-04-18T06:00:00Z', open: 2051, high: 2053, low: 2049, close: 2050 },
  { time: '2026-04-18T07:00:00Z', open: 2050, high: 2053, low: 2050, close: 2052 },
  { time: '2026-04-18T08:00:00Z', open: 2052, high: 2060, low: 2051, close: 2058 },
  { time: '2026-04-18T09:00:00Z', open: 2058, high: 2059, low: 2055, close: 2056 },
  { time: '2026-04-18T10:00:00Z', open: 2056, high: 2057, low: 2052, close: 2053 },
  { time: '2026-04-18T11:00:00Z', open: 2053, high: 2054, low: 2048, close: 2049 },
  { time: '2026-04-18T12:00:00Z', open: 2049, high: 2050, low: 2044, close: 2045 },
  { time: '2026-04-18T13:00:00Z', open: 2045, high: 2046, low: 2040, close: 2041 },
  { time: '2026-04-18T14:00:00Z', open: 2041, high: 2042, low: 2035, close: 2036 },
  { time: '2026-04-18T15:00:00Z', open: 2036, high: 2037, low: 2030, close: 2032 },
  { time: '2026-04-18T16:00:00Z', open: 2032, high: 2034, low: 2020, close: 2023 },
  { time: '2026-04-18T17:00:00Z', open: 2023, high: 2025, low: 2015, close: 2020 },
  { time: '2026-04-18T18:00:00Z', open: 2020, high: 2024, low: 2019, close: 2023 },
  { time: '2026-04-18T19:00:00Z', open: 2023, high: 2025, low: 2020, close: 2022 },
  { time: '2026-04-18T20:00:00Z', open: 2022, high: 2040, low: 2022, close: 2038 },
  { time: '2026-04-18T21:00:00Z', open: 2038, high: 2050, low: 2030, close: 2048 },
  { time: '2026-04-18T22:00:00Z', open: 2048, high: 2058, low: 2045, close: 2055 },
  { time: '2026-04-18T23:00:00Z', open: 2055, high: 2065, low: 2052, close: 2062 },
  { time: '2026-04-19T00:00:00Z', open: 2062, high: 2068, low: 2060, close: 2064 },
  { time: '2026-04-19T01:00:00Z', open: 2064, high: 2066, low: 2058, close: 2060 },
  { time: '2026-04-19T02:00:00Z', open: 2060, high: 2061, low: 2054, close: 2055 },
  { time: '2026-04-19T03:00:00Z', open: 2055, high: 2056, low: 2050, close: 2052 },
  { time: '2026-04-19T04:00:00Z', open: 2052, high: 2055, low: 2051, close: 2053 },
  { time: '2026-04-19T05:00:00Z', open: 2053, high: 2057, low: 2052, close: 2056 },
].map((c, i) => ({ ...c, volume: 1000 + i * 10 }));

// Fixture with three pivot highs clustering near 2050 (for liquidity/EQH test).
// Swing highs at idx 6 (2050), idx 16 (2051), idx 26 (2050).
export const eqhFixture = [
  { open: 2018, high: 2020, low: 2015, close: 2019 },
  { open: 2019, high: 2022, low: 2018, close: 2021 },
  { open: 2021, high: 2025, low: 2020, close: 2024 },
  { open: 2024, high: 2028, low: 2023, close: 2027 },
  { open: 2027, high: 2035, low: 2026, close: 2033 },
  { open: 2033, high: 2043, low: 2032, close: 2041 },
  { open: 2041, high: 2050, low: 2040, close: 2047 },
  { open: 2047, high: 2048, low: 2042, close: 2044 },
  { open: 2044, high: 2045, low: 2038, close: 2040 },
  { open: 2040, high: 2041, low: 2033, close: 2035 },
  { open: 2035, high: 2036, low: 2028, close: 2030 },
  { open: 2030, high: 2031, low: 2023, close: 2025 },
  { open: 2025, high: 2030, low: 2024, close: 2028 },
  { open: 2028, high: 2035, low: 2027, close: 2033 },
  { open: 2033, high: 2042, low: 2032, close: 2040 },
  { open: 2040, high: 2047, low: 2039, close: 2045 },
  { open: 2045, high: 2051, low: 2044, close: 2048 },
  { open: 2048, high: 2049, low: 2042, close: 2044 },
  { open: 2044, high: 2045, low: 2038, close: 2040 },
  { open: 2040, high: 2041, low: 2032, close: 2034 },
  { open: 2034, high: 2035, low: 2028, close: 2030 },
  { open: 2030, high: 2031, low: 2022, close: 2024 },
  { open: 2024, high: 2030, low: 2023, close: 2028 },
  { open: 2028, high: 2038, low: 2027, close: 2035 },
  { open: 2035, high: 2044, low: 2034, close: 2041 },
  { open: 2041, high: 2049, low: 2040, close: 2046 },
  { open: 2046, high: 2050, low: 2045, close: 2048 },
  { open: 2048, high: 2049, low: 2044, close: 2045 },
  { open: 2045, high: 2046, low: 2038, close: 2040 },
  { open: 2040, high: 2041, low: 2032, close: 2034 },
].map((c, i) => ({
  time: new Date(Date.UTC(2026, 3, 17, i)).toISOString(),
  ...c,
  volume: 1000,
}));

// Larger synthetic series (80 candles) for classical indicator tests.
export function generateSyntheticCandles(n = 80, seed = 2050) {
  const candles = [];
  let price = seed;
  for (let i = 0; i < n; i++) {
    // sinusoidal trend + small random walk (deterministic via sine)
    const trend = Math.sin(i / 10) * 15;
    const noise = Math.sin(i * 1.37) * 2;
    const close = seed + trend + noise;
    const open = i === 0 ? close : candles[i - 1].close;
    const high = Math.max(open, close) + Math.abs(Math.sin(i * 2.3)) * 2 + 0.5;
    const low = Math.min(open, close) - Math.abs(Math.sin(i * 1.9)) * 2 - 0.5;
    candles.push({
      time: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: 1000 + i,
    });
  }
  return candles;
}
