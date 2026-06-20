import Database from 'better-sqlite3';
import { resolveDBPath, seedFromRepo } from '../utils/dataDir.js';

// Railway-persistent when /data volume is mounted, ./data locally. resolveDataDir()
// (called inside resolveDBPath) ensures the directory exists. seedFromRepo copies
// the committed ./data/trades.db into a freshly mounted volume on first boot so the
// 78-trade history isn't lost.
seedFromRepo('trades.db');
const DB_PATH = resolveDBPath();

let db;

export function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    initSchema();
    // Log row count on startup so deploy-time data loss is immediately visible.
    try {
      const { c } = db.prepare('SELECT COUNT(*) as c FROM trades').get();
      console.log('[db] trades.db loaded:', c, 'rows at', DB_PATH);
    } catch (e) {
      console.log('[db] fresh database created at', DB_PATH);
    }
  }
  return db;
}

export { resolveDBPath };

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Trade identification
      orderId TEXT UNIQUE,
      openTime TEXT NOT NULL,
      closeTime TEXT,

      -- Market conditions at entry
      session TEXT,
      inKillZone INTEGER,
      direction TEXT,
      entryPrice REAL,
      exitPrice REAL,

      -- SMC context
      h4Bias TEXT,
      h1Bias TEXT,
      m15Bias TEXT,
      m15Event TEXT,

      -- Quality metrics
      tier INTEGER,
      confluence INTEGER,
      quality TEXT,
      consensus TEXT,

      -- Risk metrics
      atr REAL,
      slDistance REAL,
      riskPct REAL,

      -- Outcome
      outcome TEXT,
      rr REAL,
      pnl REAL,
      fees REAL,
      netPnl REAL,

      -- Blocked signal tracking
      isExecuted INTEGER DEFAULT 0,
      blockReason TEXT,
      wouldHaveOutcome TEXT,
      wouldHaveRR REAL,
      priceAtSignal REAL,
      priceAfter15m REAL,
      priceAfter1h REAL,
      priceAfter4h REAL,

      -- Meta
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session ON trades(session);
    CREATE INDEX IF NOT EXISTS idx_direction ON trades(direction);
    CREATE INDEX IF NOT EXISTS idx_outcome ON trades(outcome);
    CREATE INDEX IF NOT EXISTS idx_openTime ON trades(openTime);
  `);
  // Migrate existing databases to add new columns if missing
  const migrations = [
    'ALTER TABLE trades ADD COLUMN isExecuted INTEGER DEFAULT 0',
    'ALTER TABLE trades ADD COLUMN blockReason TEXT',
    'ALTER TABLE trades ADD COLUMN wouldHaveOutcome TEXT',
    'ALTER TABLE trades ADD COLUMN wouldHaveRR REAL',
    'ALTER TABLE trades ADD COLUMN priceAtSignal REAL',
    'ALTER TABLE trades ADD COLUMN priceAfter15m REAL',
    'ALTER TABLE trades ADD COLUMN priceAfter1h REAL',
    'ALTER TABLE trades ADD COLUMN priceAfter4h REAL',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }

  // Backfill isExecuted=1 for historical trades that have real outcomes
  db.exec(`
    UPDATE trades SET isExecuted = 1
    WHERE isExecuted = 0 AND outcome IN ('WIN','LOSS','BREAKEVEN','OPEN')
      AND orderId NOT LIKE 'blocked_%'
  `);

  // Backfill NULL tier on executed trades — default to Tier 3 (technical-only signals)
  try {
    const changed = db.prepare(
      "UPDATE trades SET tier = 3 WHERE tier IS NULL AND isExecuted = 1 AND outcome != 'BLOCKED'"
    ).run();
    if (changed.changes > 0) {
      console.log(`[tradeDB] migrated ${changed.changes} null tier(s) to default Tier 3`);
    }
  } catch (e) {}

  console.log('[tradeDB] database initialized at:', DB_PATH);
}

export function saveTrade(trade) {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO trades (
      orderId, openTime, closeTime,
      session, inKillZone, direction, entryPrice, exitPrice,
      h4Bias, h1Bias, m15Bias, m15Event,
      tier, confluence, quality, consensus,
      atr, slDistance, riskPct,
      outcome, rr, pnl, fees, netPnl,
      isExecuted, blockReason, wouldHaveOutcome, wouldHaveRR,
      priceAtSignal, priceAfter15m, priceAfter1h, priceAfter4h,
      updatedAt
    ) VALUES (
      @orderId, @openTime, @closeTime,
      @session, @inKillZone, @direction, @entryPrice, @exitPrice,
      @h4Bias, @h1Bias, @m15Bias, @m15Event,
      @tier, @confluence, @quality, @consensus,
      @atr, @slDistance, @riskPct,
      @outcome, @rr, @pnl, @fees, @netPnl,
      @isExecuted, @blockReason, @wouldHaveOutcome, @wouldHaveRR,
      @priceAtSignal, @priceAfter15m, @priceAfter1h, @priceAfter4h,
      datetime('now')
    )
  `);

  stmt.run(trade);
  console.log('[tradeDB] saved trade:', trade.orderId, trade.outcome);
}

export function updateTradeOutcome(orderId, outcome) {
  const db = getDB();
  db.prepare(`
    UPDATE trades SET
      outcome = @outcome,
      closeTime = @closeTime,
      exitPrice = @exitPrice,
      rr = @rr,
      pnl = @pnl,
      fees = @fees,
      netPnl = @netPnl,
      updatedAt = datetime('now')
    WHERE orderId = @orderId
  `).run({ orderId, ...outcome });
  console.log('[tradeDB] updated outcome:', orderId, outcome.outcome);
}

export function getRecentTrades(limit = 100) {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM trades
    WHERE outcome IN ('WIN', 'LOSS', 'BREAKEVEN')
    ORDER BY openTime DESC
    LIMIT ?
  `).all(limit);
}

// Most recent signal of ANY kind — executed, open, or blocked. Used as the
// dashboard's persistent fallback when the file cache and plans/ folder are empty
// (e.g. right after a Railway deploy, before the next 15-min pipeline run).
export function getLatestSignal() {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM trades
    ORDER BY openTime DESC
    LIMIT 1
  `).get();
}

export function getSimilarTrades(conditions, limit = 10) {
  const db = getDB();
  const {
    session, direction, tier, confluence,
    atr, h4Bias, m15Event,
  } = conditions;

  return db.prepare(`
    SELECT *,
      CASE
        WHEN isExecuted = 1 THEN outcome
        WHEN isExecuted = 0 AND wouldHaveOutcome IS NOT NULL
          THEN 'WOULD_' || wouldHaveOutcome
        ELSE NULL
      END as effectiveOutcome,
      (
        CASE WHEN session = ? THEN 3 ELSE 0 END +
        CASE WHEN direction = ? THEN 3 ELSE 0 END +
        CASE WHEN h4Bias = ? THEN 2 ELSE 0 END +
        CASE WHEN m15Event = ? THEN 2 ELSE 0 END +
        CASE WHEN tier = ? THEN 2 ELSE 0 END +
        CASE WHEN ABS(confluence - ?) <= 2 THEN 1 ELSE 0 END +
        CASE WHEN ABS(atr - ?) <= 3 THEN 1 ELSE 0 END
      ) as similarityScore
    FROM trades
    WHERE (
      (isExecuted = 1 AND outcome IN ('WIN','LOSS','BREAKEVEN'))
      OR
      (isExecuted = 0 AND wouldHaveOutcome IN ('WIN','LOSS'))
    )
    ORDER BY similarityScore DESC, openTime DESC
    LIMIT ?
  `).all(
    session ?? null, direction ?? null, h4Bias ?? null, m15Event ?? null,
    tier ?? null, confluence ?? 0, atr ?? 0, limit
  );
}

export function getStats(conditions = {}) {
  const db = getDB();
  const { session, direction } = conditions;

  let where = "WHERE outcome IN ('WIN','LOSS','BREAKEVEN')";
  const params = [];

  if (session) { where += ' AND session = ?'; params.push(session); }
  if (direction) { where += ' AND direction = ?'; params.push(direction); }

  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
      AVG(CASE WHEN outcome='WIN' THEN rr END) as avgWinRR,
      AVG(CASE WHEN outcome='LOSS' THEN rr END) as avgLossRR,
      AVG(netPnl) as avgNetPnl,
      SUM(netPnl) as totalNetPnl
    FROM trades ${where}
  `).get(...params);
}
