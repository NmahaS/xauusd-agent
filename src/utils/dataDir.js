// Single source of truth for the persistent data directory.
//
// Railway wipes the project filesystem on every deploy, but a mounted volume
// survives. Mount a Railway volume at /data and the RAG trade DB + state files
// (trades.db, last-plan.json, position-state.json) persist across deploys.
// Locally (no /data) we fall back to ./data so development is unchanged.
//
// Resolved once and cached so the choice — and its log line — happens a single
// time per process.

import fs from 'fs';
import path from 'path';

let cachedDir = null;

export function resolveDataDir() {
  if (cachedDir) return cachedDir;

  // Railway persistent volume mounted at /data
  const volumePath = '/data';
  try {
    if (fs.existsSync(volumePath)) {
      fs.accessSync(volumePath, fs.constants.W_OK);
      cachedDir = volumePath;
      console.log('[data] using Railway volume: /data');
      return cachedDir;
    }
  } catch (e) {
    // volume not available or not writable — fall through to local
  }

  // Local development fallback
  const localPath = path.join(process.cwd(), 'data');
  if (!fs.existsSync(localPath)) {
    fs.mkdirSync(localPath, { recursive: true });
  }
  cachedDir = localPath;
  console.log('[data] using local: ' + localPath);
  return cachedDir;
}

// Absolute path to a file inside the persistent data directory.
export function dataPath(filename) {
  return path.join(resolveDataDir(), filename);
}

// One-time seed for the persistent volume. The repo ships a committed
// ./data/trades.db (78 trades of history). The first time we boot on a freshly
// mounted /data volume that file is absent, so copy the repo-bundled copy in —
// otherwise the RAG history resets to 0 on that deploy. No-op locally (source ===
// target) and once the volume already has the file (volume is then authoritative).
export function seedFromRepo(filename) {
  const dir = resolveDataDir();
  const repoDataDir = path.join(process.cwd(), 'data');
  if (dir === repoDataDir) return false; // local dev — nothing to seed

  const target = path.join(dir, filename);
  const source = path.join(repoDataDir, filename);
  try {
    if (!fs.existsSync(target) && fs.existsSync(source)) {
      fs.copyFileSync(source, target);
      console.log('[data] seeded ' + filename + ' from repo → ' + target);
      return true;
    }
  } catch (e) {
    console.warn('[data] seed failed for ' + filename + ':', e.message);
  }
  return false;
}

// Convenience for the RAG trade database specifically.
export function resolveDBPath() {
  return dataPath('trades.db');
}
