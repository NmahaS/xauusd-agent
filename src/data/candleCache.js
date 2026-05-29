/*
QUOTA BUDGET:
  IG free tier: ~10,000 candles/week

  Cold start (Monday): 200 H1 + 200 H4 + 100 M15 + 50 EUR/USD = 550 calls

  Hot runs (Tue-Fri): 2 H1 + 2 H4 + 2 M15 + 2 EUR/USD = 8 calls per run
  Hot run budget: 8 × 96 runs/day × 4 days = 3,072 calls

  Total weekly: 550 + 3,072 = 3,622 calls
  Quota used: 3,622 / 10,000 = 36% ← safe margin

  Even if IG quota is lower (some accounts get 5,000/week):
  3,622 / 5,000 = 72% ← still within budget
*/
import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = 'cache';

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCacheKey(epic, resolution) {
  return `${epic}_${resolution}`.replace(/[^a-zA-Z0-9]/g, '_');
}

function getCachePath(epic, resolution) {
  ensureCacheDir();
  return path.join(CACHE_DIR, `${getCacheKey(epic, resolution)}.json`);
}

export function saveCache(epic, resolution, candles) {
  const filePath = getCachePath(epic, resolution);
  const data = {
    epic,
    resolution,
    lastUpdated: new Date().toISOString(),
    count: candles.length,
    candles: candles.slice(-200),
  };
  fs.writeFileSync(filePath, JSON.stringify(data));
  console.log(`[cache] saved ${candles.length} ${resolution} candles → ${filePath}`);
}

export function loadCache(epic, resolution) {
  try {
    const filePath = getCachePath(epic, resolution);
    if (!fs.existsSync(filePath)) {
      console.log(`[cache] no cache for ${epic} ${resolution}`);
      return null;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const ageMinutes = (Date.now() - new Date(data.lastUpdated).getTime()) / 60000;
    console.log(`[cache] loaded ${data.candles.length} ${resolution} candles (age: ${ageMinutes.toFixed(0)}m)`);
    return data.candles;
  } catch (err) {
    console.warn(`[cache] load failed: ${err.message}`);
    return null;
  }
}

export function isCacheReady(epic, resolution, minCandles = 10) {
  try {
    const filePath = getCachePath(epic, resolution);
    if (!fs.existsSync(filePath)) return false;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const count = data.candles?.length || 0;
    if (count >= minCandles) {
      console.log(`[cache] ${epic} ${resolution}: ${count} candles — ready`);
      return true;
    }
    console.log(`[cache] ${epic} ${resolution}: only ${count} candles (need ${minCandles}) — cold`);
    return false;
  } catch {
    return false;
  }
}

export function appendToCache(epic, resolution, newCandles) {
  const existing = loadCache(epic, resolution) || [];

  if (existing.length === 0) {
    saveCache(epic, resolution, newCandles);
    return newCandles;
  }

  const lastTime = new Date(existing[existing.length - 1].time).getTime();

  const newer = newCandles.filter(c => new Date(c.time).getTime() > lastTime);

  if (newer.length === 0) {
    const updated = [...existing];
    const latestNew = newCandles[newCandles.length - 1];
    if (latestNew && new Date(latestNew.time).getTime() === lastTime) {
      updated[updated.length - 1] = latestNew;
    }
    saveCache(epic, resolution, updated);
    return updated;
  }

  console.log(`[cache] appending ${newer.length} new ${resolution} candles`);
  const merged = [...existing, ...newer].slice(-200);
  saveCache(epic, resolution, merged);
  return merged;
}

export function getCacheStats() {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.json'))
      .filter(f => !f.includes('macro') && !f.includes('cot') && !f.includes('sync-test'));

    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
        if (!Array.isArray(data.candles)) return null;
        const ageMin = (Date.now() - new Date(data.lastUpdated).getTime()) / 60000;
        const isSynthetic = data.candles.length > 0 && data.candles[0].synthetic === true;
        return {
          key: f.replace('.json', ''),
          count: data.candles.length,
          ageMinutes: Math.round(ageMin),
          resolution: data.resolution || 'unknown',
          epic: data.epic || 'unknown',
          synthetic: isSynthetic,
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
