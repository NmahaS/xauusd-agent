import express from 'express';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { processWebhookUpdate } from './telegram/webhook.js';

/* inline Wilder ATR — avoids importing technicalindicators in the server */
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  if (trs.length < period) return 0;
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.redirect('/dashboard');
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    autoTrade: process.env.AUTO_TRADE === 'true',
  });
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('ok');
  try {
    await processWebhookUpdate(req.body);
  } catch (err) {
    console.error('[webhook] error:', err.message);
  }
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
});

app.get('/api/dashboard', async (_req, res) => {
  try {
    const { getHLBalance, getHLPositions, getHLAllFills, getHLPrice } =
      await import('./broker/hyperliquid.js');
    const { fetchHLCandles } = await import('./data/hyperliquid.js');
    const { readRiskState } = await import('./risk/manager.js');

    const [priceData, balance, positions, fills, m15Candles, state] = await Promise.all([
      getHLPrice('PAXG'),
      getHLBalance(),
      getHLPositions(),
      getHLAllFills('PAXG'),
      fetchHLCandles('PAXG', '15m', 50).catch(() => []),
      readRiskState(),
    ]);

    /* ── ATR from live M15 candles ──────────────────────────── */
    const atr = parseFloat(calcATR(m15Candles, 14).toFixed(2));

    /* ── P&L aggregation ────────────────────────────────────── */
    const today = new Date().toISOString().slice(0, 10);
    const todayFills = fills.filter(f =>
      new Date(f.time).toISOString().slice(0, 10) === today
    );
    const dailyPL = parseFloat((
      todayFills.filter(f => f.isClose).reduce((s, f) => s + (f.closedPnl || 0), 0) -
      todayFills.reduce((s, f) => s + (f.fee || 0), 0)
    ).toFixed(3));

    // Weekly REALIZED P&L — identical math to weeklyGoal.js (Monday 00:00 UTC →
    // now). Reuses already-fetched `fills`; no unrealized runner P&L added.
    const { computeWeeklyPnl } = await import('./utils/weeklyPnl.js');
    const week = computeWeeklyPnl(fills);
    const weeklyPL = week.net;
    const weeklyGross = week.gross;
    const weeklyFees = week.fees;

    /* ── Weekly history (last 5 days for chart) ─────────────── */
    const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const now = new Date();
    const weeklyHistory = [];
    for (let i = 4; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setUTCDate(now.getUTCDate() - i);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCHours(23, 59, 59, 999);
      const dayFills = fills.filter(f => {
        const t = new Date(f.time);
        return t >= dayStart && t <= dayEnd;
      });
      const pl = dayFills.filter(f => f.isClose).reduce((s, f) => s + (f.closedPnl || 0), 0)
               - dayFills.reduce((s, f) => s + (f.fee || 0), 0);
      weeklyHistory.push({ label: DAY[dayStart.getUTCDay()], pl: parseFloat(pl.toFixed(2)) });
    }

    /* ── Monthly history (CURRENT calendar month, grouped by week) ───
       Always starts at the 1st of this month and builds W1, W2, … up to the
       current week. Resets automatically on a new month; weeks with no trades
       still show ($0). W1 = 1st–7th, W2 = 8th–14th, etc. */
    const monthlyHistory = [];
    {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      monthStart.setUTCHours(0, 0, 0, 0);

      let weekNumber = 1;
      let wkStart = new Date(monthStart);
      while (wkStart <= now) {
        const wkEnd = new Date(wkStart);
        wkEnd.setUTCDate(wkStart.getUTCDate() + 6);
        wkEnd.setUTCHours(23, 59, 59, 999);

        const wFills = fills.filter(f => {
          const t = new Date(f.time);
          return t >= wkStart && t <= wkEnd;
        });
        const weekPL = wFills.filter(f => f.isClose).reduce((s, f) => s + (f.closedPnl || 0), 0)
                     - wFills.reduce((s, f) => s + (f.fee || 0), 0);

        monthlyHistory.push({
          label: 'W' + weekNumber + ' ' + wkStart.toISOString().slice(5, 10),
          pnl: parseFloat(weekPL.toFixed(2)),
        });

        // advance to the next week (day after this week's end)
        wkStart = new Date(wkEnd);
        wkStart.setUTCDate(wkStart.getUTCDate() + 1);
        wkStart.setUTCHours(0, 0, 0, 0);
        weekNumber++;
      }

      console.log('[dashboard] month:', monthStart.toISOString().slice(0, 7),
        '| weeks built:', monthlyHistory.length);
    }

    /* ── Recent closed trades — group fills into orders ─────────
       HL returns individual fills; one order can split across 2-5
       makers. Group by (minute + direction + open/close) so the
       dashboard shows one row per order with combined size. */
    const fillGroups = {};
    fills
      .filter(f => f.isClose || Math.abs(parseFloat(f.closedPnl)) > 0.001)
      .forEach(f => {
        const minuteKey = new Date(f.time).toISOString().slice(0, 16);
        const key = minuteKey + '_' + f.direction + '_' + (f.isClose ? 'C' : 'O');
        if (!fillGroups[key]) {
          fillGroups[key] = {
            time: f.time,
            direction: f.direction,
            isClose: f.isClose,
            size: 0,
            notional: 0,
            pnl: 0,
            fee: 0,
          };
        }
        const g = fillGroups[key];
        g.size += parseFloat(f.size || f.sz);
        g.notional += parseFloat(f.size || f.sz) * parseFloat(f.price || f.px);
        g.pnl += parseFloat(f.closedPnl) || 0;
        g.fee += parseFloat(f.fee) || 0;
      });

    const recentTrades = Object.values(fillGroups)
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 10)
      .map(g => ({
        time:   new Date(g.time).toISOString().slice(5, 16).replace('T', ' '),
        dir:    g.direction === 'long' ? 'LONG' : 'SHORT',
        entry:  parseFloat((g.notional / g.size).toFixed(2)),
        size:   parseFloat(g.size.toFixed(4)),
        pnl:    parseFloat(g.pnl.toFixed(2)),
        status: g.pnl > 0.01 ? 'WIN' : g.pnl < -0.01 ? 'LOSS' : 'BE',
      }));

    /* ── Signal (file-cache → filesystem → fallback) ───────── */
    let signal   = null;
    let planMeta = null;

    /* Resolve TF alignment to an "X/2" string — H1 + M15 only (H4 is context, not scored).
       Handles a persisted tfAlignment in any shape (string | number | {score,total} |
       {h1,m15} booleans), and otherwise DERIVES it from threeLayer.layers.technical biases
       vs the trade direction — which is what last-plan.json actually contains. */
    function resolveTfAlignment(p) {
      const tfa = p.tfAlignment;
      if (typeof tfa === 'string') return tfa;
      if (typeof tfa === 'number') return tfa + '/2';
      if (tfa && typeof tfa.score === 'number') return tfa.score + '/' + (tfa.total ?? 2);
      if (tfa && (tfa.h1 !== undefined || tfa.m15 !== undefined)) {
        return ((tfa.h1 ? 1 : 0) + (tfa.m15 ? 1 : 0)) + '/2';
      }
      const tech = p.threeLayer?.layers?.technical;
      const target =
        p.direction === 'long'     ? 'bullish' :
        p.direction === 'short'    ? 'bearish' :
        tech?.h1Bias === 'bullish' ? 'bullish' :
        tech?.h1Bias === 'bearish' ? 'bearish' : null;
      if (tech && target) {
        return ((tech.h1Bias  === target ? 1 : 0)
              + (tech.m15Bias === target ? 1 : 0)) + '/2';
      }
      return '0/2';
    }

    /* H4 status — context only, shown as a separate badge (agrees | disagrees | unknown). */
    function resolveH4Status(p) {
      const tfa = p.tfAlignment;
      if (tfa && typeof tfa.h4Status === 'string') return tfa.h4Status;
      const tech = p.threeLayer?.layers?.technical;
      const target =
        p.direction === 'long'  ? 'bullish' :
        p.direction === 'short' ? 'bearish' : null;
      if (!tech || !target || tech.h4Bias == null) return 'unknown';
      return tech.h4Bias === target ? 'agrees' : 'disagrees';
    }

    /* helper: build signal + planMeta from a raw plan object */
    function planToSignal(p, source) {
      const ageMin = p._cachedAt
        ? (Date.now() - new Date(p._cachedAt).getTime()) / 60000
        : null;
      const tfaResolved = resolveTfAlignment(p);
      const _tech = p.threeLayer?.layers?.technical;
      console.log('[dashboard] tfAlignment raw:', JSON.stringify(p.tfAlignment),
        '| technical:', _tech ? `h4=${_tech.h4Bias} h1=${_tech.h1Bias} m15=${_tech.m15Bias} dir=${p.direction}` : 'none',
        '→ resolved:', tfaResolved);
      return {
        signal: {
          bias:          p.direction === 'long'  ? 'BULLISH' :
                         p.direction === 'short' ? 'BEARISH' :
                         p.bias === 'bearish'    ? 'BEARISH' :
                         p.bias === 'bullish'    ? 'BULLISH' : 'NEUTRAL',
          tier:          p.threeLayer?.tier       || p.tier || 3,
          confluence:    p.confluenceCount        || 0,
          direction:     p.direction              || null,
          factors:       p.confluenceFactors      || [],
          tfAlignment:   tfaResolved,
          h4Status:      resolveH4Status(p),
          session:       p._session || (typeof p.session === 'object' ? p.session?.current : p.session) || 'unknown',
          regime:        p._regime  || p.threeLayer?.layers?.flow?.regime || p.regime || p.marketRegime || 'unknown',
          quality:       p.setupQuality           || 'unknown',
          biasReasoning: p.biasReasoning          || '',
          blockedReason: p.execution?.reason      || p.blockedReason || null,
          executed:      p.execution?.executed    || false,
          entry:         p.entry?.price           || null,
          sl:            p.stopLoss?.price        || null,
          tp:            p.takeProfits?.[0]?.price || p.takeProfit?.price || null,
          warnings:      (p.warnings || []).slice(0, 3),
          age:           ageMin !== null ? Math.round(ageMin) + 'min ago' : null,
          source,
        },
        planMeta: {
          sl:  p.stopLoss?.price            || 0,
          tp1: p.takeProfits?.[0]?.price    || 0,
          tp2: p.takeProfits?.[1]?.price    || 0,
        },
      };
    }

    // Tier 1: file cache written by pipeline after each run — works across processes
    try {
      const cacheFile = path.join(process.cwd(), 'data', 'last-plan.json');
      if (fs.existsSync(cacheFile)) {
        const p      = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const ageMin = p._cachedAt
          ? (Date.now() - new Date(p._cachedAt).getTime()) / 60000
          : 999;
        console.log('[dashboard] last-plan.json age:', ageMin.toFixed(1), 'min',
                    '| bias:', p.bias, 'direction:', p.direction,
                    'confluence:', p.confluenceCount);
        const built  = planToSignal(p, 'file-cache');
        signal   = built.signal;
        planMeta = built.planMeta;
      }
    } catch (e) {
      console.log('[dashboard] cache read error:', e.message);
    }

    // Tier 2: plans filesystem (works locally / Railway if volume persists)
    if (!signal) {
      try {
        const plansDir = path.join(process.cwd(), 'plans');
        if (fs.existsSync(plansDir)) {
          const dates = fs.readdirSync(plansDir)
            .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
            .sort().slice(-1);
          if (dates[0]) {
            const dayDir = path.join(plansDir, dates[0]);
            const files  = fs.readdirSync(dayDir)
              .filter(f => f.endsWith('.json') && f !== 'daily-summary.json')
              .sort().slice(-1);
            if (files[0]) {
              const p     = JSON.parse(fs.readFileSync(path.join(dayDir, files[0]), 'utf8'));
              const built = planToSignal(p, 'filesystem');
              signal   = built.signal;
              planMeta = built.planMeta;
            }
          }
        }
      } catch (e) {
        console.log('[dashboard] filesystem error:', e.message);
      }
    }

    // Tier 3: RAG DB — persistent across deploys; surfaces the most recent real
    // signal (executed OR blocked) when both the file cache and plans/ are empty
    // (e.g. right after a Railway deploy, before the next 15-min pipeline run).
    if (!signal) {
      try {
        const { getLatestSignal } = await import('./memory/tradeDB.js');
        const row = getLatestSignal();
        if (row) {
          const p = {
            direction: row.direction,
            bias: row.direction === 'long' ? 'bullish'
                : row.direction === 'short' ? 'bearish' : 'neutral',
            threeLayer: {
              tier: row.tier,
              layers: { technical: { h4Bias: row.h4Bias, h1Bias: row.h1Bias, m15Bias: row.m15Bias } },
            },
            confluenceCount: row.confluence,
            confluenceFactors: [],
            setupQuality: row.quality,
            biasReasoning: row.isExecuted
              ? `Executed ${row.direction || ''} (${row.outcome || 'OPEN'}) — from trade memory`
              : `Latest signal${row.blockReason ? ' — ' + row.blockReason : ''} (from trade memory)`,
            blockedReason: row.blockReason || null,
            execution: { executed: row.isExecuted === 1, reason: row.blockReason || null },
            entry: { price: row.entryPrice || null },
            _cachedAt: row.openTime,
            _session: row.session || null,
          };
          const built = planToSignal(p, 'rag-db');
          signal   = built.signal;
          planMeta = built.planMeta;
          console.log('[dashboard] RAG DB fallback:', row.openTime, row.direction,
                      'T' + row.tier, 'C' + row.confluence);
        }
      } catch (e) {
        console.log('[dashboard] RAG DB fallback error:', e.message);
      }
    }

    // Tier 4: minimal fallback — agent running, no analysis produced yet
    if (!signal) {
      signal = {
        bias:          'NEUTRAL',
        tier:          null,
        confluence:    0,
        direction:     null,
        factors:       [],
        tfAlignment:   '—',
        h4Status:      'unknown',
        session:       'unknown',
        regime:        'unknown',
        quality:       'waiting',
        biasReasoning: 'Agent is running — next analysis in ~15 minutes.',
        blockedReason: null,
        executed:      false,
        source:        'fallback',
      };
    }

    console.log('[dashboard] signal source:', signal.source,
                '| bias:', signal.bias, '| confluence:', signal.confluence);

    /* ── Position with compound history + weighted entry + total risk ── */
    const pos = positions[0];
    let posOut = null;
    if (pos) {
      // Identify the CURRENT position's fills via Hyperliquid's `startPosition` (signed position
      // size BEFORE each fill). The position opened at the most recent fill where the book was NOT
      // already in this direction — i.e. startPosition was flat (0) or opposite-signed. Everything
      // from that fill forward belongs to the current position. This is exact: it ignores partial
      // closes (the 50% TP at 2R, trailing-stop fills) and never bleeds into older closed
      // positions — unlike a last-Close cutoff (which a partial TP resets, hiding compounds) or a
      // net-size walk (which drifts on float error and swept in weeks of fills).
      const coinSign = pos.direction === 'short' ? -1 : 1;
      const coinFills = fills
        .filter(f => f.coin === pos.coin)
        .sort((a, b) => new Date(a.time) - new Date(b.time));

      let startIdx = 0;
      for (let i = coinFills.length - 1; i >= 0; i--) {
        const sp = coinFills[i].startPosition;
        const spSign = sp > 1e-9 ? 1 : sp < -1e-9 ? -1 : 0;
        if (spSign !== coinSign) { startIdx = i; break; }   // flat/opposite before this fill → opened here
      }
      const currentFills = coinFills.slice(startIdx);
      const openFills = currentFills.filter(f => f.isOpen);   // entry + each compound add

      // Reconcile: opens − closes inside the detected window must equal the live position size
      // (all opens here are the same direction; closes are partial/full reductions, so magnitude
      // nets cleanly). If it doesn't (truncated fills history, an unexpected flip fill), fall back
      // to a single entry at HL's reported price rather than render a misleading breakdown.
      const netInWindow = currentFills.reduce(
        (s, f) => s + (f.isOpen ? 1 : -1) * f.size, 0);
      const reconciles = openFills.length > 0 && Math.abs(netInWindow - pos.size) < 1e-6;
      if (!reconciles) {
        console.log('[dashboard] position-fill reconcile failed:',
          'net', netInWindow.toFixed(4), 'vs size', pos.size, '— showing single entry');
      }

      const sourceOpens = reconciles ? openFills : [];
      const compoundTrades = sourceOpens.map((f, i) => ({
        time:     new Date(f.time).toISOString().slice(11, 16) + ' UTC',
        type:     i === 0 ? 'ENTRY' : 'COMPOUND ' + i,
        size:     f.size,
        price:    f.price,
        notional: parseFloat((f.size * f.price).toFixed(2)),
        fee:      f.fee || 0,
      }));

      // Weighted-average entry across all opens; fall back to HL's entryPrice if reconcile failed.
      const totalOpened = compoundTrades.reduce((s, t) => s + t.size, 0);
      const weightedEntry = totalOpened > 0
        ? compoundTrades.reduce((s, t) => s + t.size * t.price, 0) / totalOpened
        : pos.entryPrice;

      // Live SL/TP from resting reduce-only orders (the HL position itself has no SL field).
      let slPrice = null, tpPrice = null;
      try {
        const { getOpenOrdersDetailed } = await import('./broker/hyperliquid.js');
        const coinOrders = (await getOpenOrdersDetailed())
          .filter(o => o.coin === pos.coin && o.reduceOnly);
        const slOrder = coinOrders.find(o =>
          o.isTrigger === true || o.orderType === 'Stop Market' || o.orderType === 'Stop Limit');
        const tpOrder = coinOrders.find(o => o.orderType === 'Limit' && o.isTrigger !== true);
        slPrice = slOrder ? (slOrder.triggerPx || slOrder.limitPx) : null;
        tpPrice = tpOrder ? tpOrder.limitPx : null;
      } catch (e) {
        console.log('[dashboard] live SL/TP fetch error:', e.message);
      }

      // Trailing state from the executor's persisted position file (authoritative R label).
      // 0 = stop at breakeven, n = stop locked +nR. Absent for positions opened before the feature.
      let trailLevel = null, firstSLDistance = null;
      try {
        const ps = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'position-state.json'), 'utf8'));
        if (ps && ps.coin === pos.coin && ps.direction === pos.direction) {
          if (typeof ps.trailLevel === 'number') trailLevel = ps.trailLevel;
          if (ps.firstSLDistance > 0) firstSLDistance = ps.firstSLDistance;
        }
      } catch { /* no state file → derive from price levels below */ }

      const effSize = pos.size || totalOpened;

      // Stop economics relative to entry. A trailing stop past breakeven LOCKS profit — it is not
      // downside risk. stopLockedPts > 0 ⇒ profit secured if stopped; < 0 ⇒ risk if stopped.
      const stopLockedPts = slPrice != null
        ? (pos.direction === 'long' ? slPrice - weightedEntry : weightedEntry - slPrice)
        : 0;
      const stopLocked = slPrice != null && stopLockedPts >= 0;
      const slDist     = slPrice != null ? Math.abs(weightedEntry - slPrice) : 0;
      const stopPnl    = effSize * stopLockedPts;        // signed $ realised if the stop fills
      const bal        = balance.balance || 100;
      const riskAmt    = stopLocked ? 0 : effSize * slDist;   // downside only — 0 once locked
      const riskPct    = bal > 0 ? (riskAmt / bal) * 100 : 0;

      posOut = {
        direction:        pos.direction,
        size:             pos.size,
        entryPrice:       parseFloat(weightedEntry.toFixed(2)),   // weighted avg = displayed entry
        weightedEntry:    parseFloat(weightedEntry.toFixed(2)),
        unrealizedPnl:    parseFloat((pos.unrealizedPnl || 0).toFixed(2)),
        leverage:         pos.leverage,
        liquidationPrice: pos.liquidationPrice,
        notional:         parseFloat((pos.size * weightedEntry).toFixed(2)),
        sl:               slPrice != null ? parseFloat(slPrice.toFixed(2)) : null,
        tp:               tpPrice != null ? parseFloat(tpPrice.toFixed(2)) : null,
        compoundTrades,
        compoundCount:    compoundTrades.length,
        totalRisk:        parseFloat(riskAmt.toFixed(2)),
        riskPct:          parseFloat(riskPct.toFixed(2)),
        // Trailing-stop state
        trailLevel,                                              // 0 = breakeven, n = +nR (or null)
        stopLocked,                                              // true ⇒ stop secures profit
        stopLockedPts:    parseFloat(stopLockedPts.toFixed(1)),  // signed pts at the stop vs entry
        stopPnl:          parseFloat(stopPnl.toFixed(2)),        // signed $ if the stop fills
        slDistPts:        parseFloat(slDist.toFixed(1)),         // |entry − SL| in points
        rUnitPts:         firstSLDistance != null ? parseFloat(firstSLDistance.toFixed(1)) : null, // 1R in pts
        isRunner:         slPrice != null && tpPrice == null,    // runner phase: no TP, rides trail
      };
    }

    res.json({
      price:          priceData?.markPrice  || 0,
      funding:        priceData?.funding    || 0,
      balance:        balance.balance       || 0,
      dailyPL,
      weeklyPL,
      weeklyGross,
      weeklyFees,
      dailyTrades:    state?.dailyTrades    || 0,
      atr,
      position:       posOut,
      plan:           planMeta,
      signal,
      trades:         recentTrades,
      weeklyHistory,
      monthlyHistory,
      weeklyGoal:     5.00,
    });
  } catch (err) {
    console.error('[dashboard] API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on port ${PORT}`);
});
