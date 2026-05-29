// Weekly macro state: combines COT + weekly structure into one bias signal.
// Cached 24h — computed fresh every Monday, reused through the week.
import fs from 'node:fs';
import { fetchCOTReport } from './cot.js';
import { fetchWeeklyMacro } from './weeklyStructure.js';

const CACHE_FILE = 'cache/macro_state.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function loadMacroCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const age = Date.now() - new Date(data.computedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    console.log(`[macro] using cached weekly state (age: ${Math.round(age / 60000)}m)`);
    return data;
  } catch { return null; }
}

function saveMacroCache(state) {
  try {
    fs.mkdirSync('cache', { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(state));
  } catch (err) {
    console.warn(`[macro] cache write failed: ${err.message}`);
  }
}

export async function getWeeklyMacroState() {
  const cached = loadMacroCache();
  if (cached) return cached;

  console.log('[macro] computing fresh weekly macro state...');

  const [cot, weeklyMacro] = await Promise.all([
    fetchCOTReport().catch(err => {
      console.warn(`[macro] COT fetch failed: ${err.message}`);
      return null;
    }),
    fetchWeeklyMacro().catch(err => {
      console.warn(`[macro] weekly macro fetch failed: ${err.message}`);
      return null;
    }),
  ]);

  let bullishPoints = 0;
  let bearishPoints = 0;
  const factors = [];

  if (cot && !cot.error) {
    if (cot.cotBias === 'bullish') { bullishPoints += 2; factors.push('COT: commercials accumulating'); }
    if (cot.cotBias === 'bearish') { bearishPoints += 2; factors.push('COT: commercials distributing'); }
    if (cot.speculatorExtremeLow) { bullishPoints += 1; factors.push('COT: speculators extremely short (contrarian bullish)'); }
    if (cot.speculatorExtremeHigh) { bearishPoints += 1; factors.push('COT: speculators extremely long (contrarian bearish)'); }
  }

  if (weeklyMacro) {
    const dxyBias = weeklyMacro.weeklyDXYBias || 'neutral';
    if (dxyBias.includes('bullish')) {
      const pts = dxyBias.includes('strongly') ? 2 : 1;
      bullishPoints += pts;
      factors.push(`DXY weekly: ${weeklyMacro.weeklyDXYTrend} (dollar weakening → bullish gold)`);
    }
    if (dxyBias.includes('bearish')) {
      const pts = dxyBias.includes('strongly') ? 2 : 1;
      bearishPoints += pts;
      factors.push(`DXY weekly: ${weeklyMacro.weeklyDXYTrend} (dollar strengthening → bearish gold)`);
    }
    if (weeklyMacro.weeklyYieldBias === 'bullish_gold') {
      bullishPoints += 1;
      factors.push('Yields falling (bullish gold)');
    }
    if (weeklyMacro.weeklyYieldBias === 'bearish_gold') {
      bearishPoints += 1;
      factors.push('Yields rising (bearish gold)');
    }
  }

  const weeklyBias =
    bullishPoints >= 3 ? 'strongly_bullish' :
    bullishPoints >= 2 ? 'bullish' :
    bearishPoints >= 3 ? 'strongly_bearish' :
    bearishPoints >= 2 ? 'bearish' : 'neutral';

  const state = {
    computedAt: new Date().toISOString(),
    weeklyBias,
    bullishPoints,
    bearishPoints,
    factors,
    cot,
    weeklyMacro,
    summary: `Weekly macro: ${weeklyBias.toUpperCase()} (${bullishPoints}B/${bearishPoints}Br points)`,
  };

  console.log(`[macro] ${state.summary}`);
  if (factors.length) console.log(`[macro] factors: ${factors.join(' | ')}`);

  saveMacroCache(state);
  return state;
}
