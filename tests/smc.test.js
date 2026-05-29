import { detectSwings } from '../src/smc/swings.js';
import { analyzeStructure } from '../src/smc/structure.js';
import { detectFVGs, unfilledFVGs } from '../src/smc/fvg.js';
import { detectOrderBlocks } from '../src/smc/orderBlocks.js';
import { detectLiquidity } from '../src/smc/liquidity.js';
import { computePremiumDiscount } from '../src/smc/premiumDiscount.js';
import { sampleCandles, eqhFixture } from './fixtures/sampleCandles.js';

describe('detectSwings', () => {
  test('returns empty array when not enough candles', () => {
    expect(detectSwings([], 3)).toEqual([]);
    expect(detectSwings(sampleCandles.slice(0, 4), 3)).toEqual([]);
  });

  test('finds expected swings with n=3 in sample fixture', () => {
    const swings = detectSwings(sampleCandles, 3);
    const types = swings.map(s => s.type);
    expect(types).toContain('high');
    expect(types).toContain('low');
    // Expect a swing low near idx 17 (price ~2015)
    const low = swings.find(s => s.type === 'low' && s.price === 2015);
    expect(low).toBeDefined();
    expect(low.index).toBe(17);
    // Expect a swing high at idx 24 (price 2068)
    const high = swings.find(s => s.type === 'high' && s.price === 2068);
    expect(high).toBeDefined();
    expect(high.index).toBe(24);
  });
});

describe('analyzeStructure', () => {
  test('detects CHoCH-bullish after prior lower-low then higher-high', () => {
    const res = analyzeStructure(sampleCandles, 3);
    expect(res.bias).toBe('bullish');
    expect(res.lastEvent).toBe('CHoCH-bullish');
    expect(res.brokenLevel).toBe(2060);
  });

  test('neutral bias when no structure swings present', () => {
    const flat = Array.from({ length: 10 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      open: 2000, high: 2001, low: 1999, close: 2000, volume: 100,
    }));
    const res = analyzeStructure(flat, 3);
    expect(res.bias).toBe('neutral');
    expect(res.lastEvent).toBeNull();
  });
});

describe('detectFVGs', () => {
  test('finds bullish FVG at impulse around idx 20', () => {
    const fvgs = detectFVGs(sampleCandles);
    const bullish = fvgs.filter(f => f.type === 'bullish');
    expect(bullish.length).toBeGreaterThan(0);
    const fvg20 = bullish.find(f => f.index === 20);
    expect(fvg20).toBeDefined();
    expect(fvg20.bottom).toBe(2025);
    expect(fvg20.top).toBe(2030);
    expect(fvg20.filled).toBe(false);
  });

  test('unfilledFVGs excludes filled gaps', () => {
    const all = detectFVGs(sampleCandles);
    const unfilled = unfilledFVGs(sampleCandles);
    expect(unfilled.length).toBeLessThanOrEqual(all.length);
    expect(unfilled.every(f => f.filled === false)).toBe(true);
  });
});

describe('detectOrderBlocks', () => {
  test('finds active bullish OB at idx 19 (last down-close before impulse)', () => {
    const obs = detectOrderBlocks(sampleCandles, 3);
    expect(obs.length).toBeGreaterThan(0);
    const bullish = obs.find(o => o.type === 'bullish' && o.index === 19);
    expect(bullish).toBeDefined();
    expect(bullish.low).toBe(2020);
    expect(bullish.high).toBe(2025);
  });

  test('returns at most 3 order blocks', () => {
    const obs = detectOrderBlocks(sampleCandles, 3);
    expect(obs.length).toBeLessThanOrEqual(3);
  });
});

describe('detectLiquidity', () => {
  test('finds equal highs cluster in eqhFixture', () => {
    const res = detectLiquidity(eqhFixture, 3);
    expect(res.atr).toBeGreaterThan(0);
    // We engineered tops around 2050, should cluster at least once
    expect(res.eqh.length + res.eql.length).toBeGreaterThanOrEqual(1);
    if (res.eqh.length) {
      expect(res.eqh[0].count).toBeGreaterThanOrEqual(2);
    }
  });

  test('returns safe defaults on short series', () => {
    const res = detectLiquidity(sampleCandles.slice(0, 5), 3);
    expect(res.atr).toBeNull();
    expect(res.eqh).toEqual([]);
    expect(res.eql).toEqual([]);
  });
});

describe('computePremiumDiscount', () => {
  test('current price in premium zone for sample fixture', () => {
    const pd = computePremiumDiscount(sampleCandles, 3);
    expect(pd.ok).toBe(true);
    expect(pd.low).toBe(2015);
    expect(pd.high).toBe(2068);
    expect(pd.range).toBe(53);
    // Current close 2056 → (2056-2015)/53 ≈ 77.4%
    expect(pd.positionPct).toBeCloseTo(77.36, 1);
    expect(pd.zone).toBe('premium');
    expect(pd.ote.long[0]).toBeLessThan(pd.ote.long[1]);
    expect(pd.ote.short[0]).toBeLessThan(pd.ote.short[1]);
  });

  test('returns ok=false with insufficient swings', () => {
    const pd = computePremiumDiscount(sampleCandles.slice(0, 3), 3);
    expect(pd.ok).toBe(false);
  });
});
