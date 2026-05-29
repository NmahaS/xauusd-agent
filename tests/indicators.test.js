import { computeClassicalIndicators } from '../src/indicators/classical.js';
import { detectSession, computeSessionLevels } from '../src/indicators/session.js';
import { generateSyntheticCandles, sampleCandles } from './fixtures/sampleCandles.js';

describe('computeClassicalIndicators', () => {
  test('rejects candle sets shorter than 50', () => {
    const res = computeClassicalIndicators(sampleCandles);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/need >=50/);
  });

  test('produces full output on synthetic 80-candle series', () => {
    const candles = generateSyntheticCandles(80);
    const res = computeClassicalIndicators(candles);
    expect(res.ok).toBe(true);
    expect(res.lastClose).toBe(candles[candles.length - 1].close);
    expect(typeof res.ema20).toBe('number');
    expect(typeof res.ema50).toBe('number');
    expect(typeof res.rsi).toBe('number');
    expect(res.rsi).toBeGreaterThan(0);
    expect(res.rsi).toBeLessThan(100);
    expect(typeof res.atr).toBe('number');
    expect(res.atr).toBeGreaterThan(0);
    expect(res.macd).not.toBeNull();
    expect(res.divergence).toHaveProperty('bullish');
    expect(res.divergence).toHaveProperty('bearish');
    expect(['bullish', 'bearish', 'neutral']).toContain(res.trend);
  });

  test('includes EMA 200 when ≥200 candles provided', () => {
    const res = computeClassicalIndicators(generateSyntheticCandles(220));
    expect(res.ok).toBe(true);
    expect(typeof res.ema200).toBe('number');
  });
});

describe('detectSession', () => {
  test('classifies asia 00-07', () => {
    const d = new Date(Date.UTC(2026, 3, 19, 3, 0, 0));
    const s = detectSession(d);
    expect(s.current).toBe('asia');
    expect(s.inKillZone).toBe(false);
    expect(s.killZone).toBeNull();
  });

  test('classifies london kill zone at 08 UTC', () => {
    const d = new Date(Date.UTC(2026, 3, 19, 8, 30, 0));
    const s = detectSession(d);
    expect(s.current).toBe('london');
    expect(s.inKillZone).toBe(true);
    expect(s.killZone).toBe('london-killzone');
  });

  test('classifies ny kill zone at 13 UTC', () => {
    const d = new Date(Date.UTC(2026, 3, 19, 13, 0, 0));
    const s = detectSession(d);
    expect(s.current).toBe('ny');
    expect(s.inKillZone).toBe(true);
    expect(s.killZone).toBe('ny-killzone');
  });

  test('classifies off-session at 18 UTC', () => {
    const d = new Date(Date.UTC(2026, 3, 19, 18, 0, 0));
    const s = detectSession(d);
    expect(s.current).toBe('off');
    expect(s.inKillZone).toBe(false);
  });
});

describe('computeSessionLevels', () => {
  test('computes high/low buckets without throwing', () => {
    const levels = computeSessionLevels(sampleCandles, new Date('2026-04-19T05:00:00Z'));
    expect(levels).toHaveProperty('asiaToday');
    expect(levels).toHaveProperty('londonToday');
    expect(levels).toHaveProperty('nyToday');
    expect(levels).toHaveProperty('priorDay');
    expect(levels).toHaveProperty('priorWeek');
    // priorDay should cover most of the fixture (2026-04-18)
    expect(levels.priorDay.high).toBeGreaterThan(0);
    expect(levels.priorDay.low).toBeGreaterThan(0);
  });
});
