import { config } from '../config.js';

const BASE_URL = 'https://api.twelvedata.com';

async function fetchTimeSeries(symbol, interval, outputsize = 200) {
  const url = new URL(`${BASE_URL}/time_series`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', String(outputsize));
  url.searchParams.set('apikey', config.TWELVEDATA_API_KEY);
  url.searchParams.set('timezone', 'UTC');

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TwelveData HTTP ${res.status}: ${res.statusText}`);
  }
  const json = await res.json();
  if (json.status === 'error' || json.code) {
    throw new Error(`TwelveData API error: ${json.message || JSON.stringify(json)}`);
  }
  if (!Array.isArray(json.values)) {
    throw new Error(`TwelveData unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
  }

  // TwelveData returns newest first — reverse to chronological order
  return json.values
    .slice()
    .reverse()
    .map(c => ({
      time: c.datetime,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: c.volume != null ? parseFloat(c.volume) : 0,
    }));
}

export async function fetchXauCandles({ interval, outputsize } = {}) {
  const tf = interval || config.EXECUTION_TF;
  const size = outputsize || config.CANDLES_LOOKBACK;
  try {
    const candles = await fetchTimeSeries(config.SYMBOL, tf, size);
    console.log(`[twelvedata] fetched ${candles.length} ${config.SYMBOL} ${tf} candles`);
    return { ok: true, interval: tf, candles };
  } catch (err) {
    console.warn(`[twelvedata] failed ${config.SYMBOL} ${tf}: ${err.message}`);
    return { ok: false, interval: tf, candles: [], error: err.message };
  }
}

export async function fetchXauBothTimeframes() {
  const [h1, h4] = await Promise.all([
    fetchXauCandles({ interval: config.EXECUTION_TF, outputsize: config.CANDLES_LOOKBACK }),
    fetchXauCandles({ interval: config.BIAS_TF, outputsize: config.CANDLES_LOOKBACK }),
  ]);
  return { h1, h4 };
}

export async function fetchSymbolCandles(symbol, interval, outputsize) {
  try {
    const candles = await fetchTimeSeries(symbol, interval, outputsize);
    console.log(`[twelvedata] fetched ${candles.length} ${symbol} ${interval} candles`);
    return { ok: true, symbol, interval, candles };
  } catch (err) {
    console.warn(`[twelvedata] failed ${symbol} ${interval}: ${err.message}`);
    return { ok: false, symbol, interval, candles: [], error: err.message };
  }
}
