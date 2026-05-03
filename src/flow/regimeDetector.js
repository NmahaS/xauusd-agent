// Market regime classifier: trending / ranging / volatile / transitioning.
// SMC is effective in trending markets; unreliable in ranging/volatile ones.

function simpleATR(candles) {
  if (candles.length < 2) return 1;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    sum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  }
  return sum / (candles.length - 1);
}

export function detectRegime(h1Candles, h4Candles, indicators) {
  if (!h1Candles?.length || !indicators) {
    return { regime: 'unknown', confidence: 0, smc_effective: true, reasoning: 'Insufficient data for regime detection' };
  }

  const ema20 = indicators.ema20;
  const ema50 = indicators.ema50;
  const ema200 = indicators.ema200;
  const atr = indicators.atr || 1;

  const bullishAlignment = ema20 > ema50 && ema50 > ema200;
  const bearishAlignment = ema20 < ema50 && ema50 < ema200;
  const emaSpread = Math.abs(ema20 - ema50) / atr;

  const recentCandles = h1Candles.slice(-14);
  const olderCandles = h1Candles.slice(-56, -14);
  const recentATR = simpleATR(recentCandles);
  const olderATR = simpleATR(olderCandles.length >= 5 ? olderCandles : recentCandles);
  const volatilityRatio = olderATR > 0 ? recentATR / olderATR : 1;

  const last20 = h1Candles.slice(-20);
  const last20High = Math.max(...last20.map(c => c.high));
  const last20Low = Math.min(...last20.map(c => c.low));
  const rangeToATR = atr > 0 ? (last20High - last20Low) / atr : 0;

  let regime, confidence, smc_effective, trendDirection, reasoning;

  if (volatilityRatio > 2.0) {
    regime = 'volatile';
    confidence = 85;
    smc_effective = false;
    reasoning = `Volatility ${volatilityRatio.toFixed(1)}x above normal — avoid trading`;
  } else if ((bullishAlignment || bearishAlignment) && emaSpread > 1.5 && rangeToATR > 8) {
    regime = 'trending';
    confidence = 80;
    smc_effective = true;
    trendDirection = bullishAlignment ? 'bullish' : 'bearish';
    reasoning = `${bullishAlignment ? 'Bullish' : 'Bearish'} trend — EMAs aligned, price making progress`;
  } else if (rangeToATR < 4) {
    regime = 'ranging';
    confidence = 75;
    smc_effective = false;
    reasoning = `Ranging market — 20-candle range only ${rangeToATR.toFixed(1)}×ATR — SMC signals unreliable`;
  } else {
    regime = 'transitioning';
    confidence = 50;
    smc_effective = true;
    reasoning = 'Market transitioning — proceed with caution, require higher confluence';
  }

  console.log(`[regime] ${regime} (SMC effective: ${smc_effective}) — ${reasoning}`);

  return { regime, confidence, smc_effective, trendDirection: trendDirection ?? null, reasoning };
}
