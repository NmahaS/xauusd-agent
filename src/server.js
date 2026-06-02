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

    const weekStart = new Date();
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekFills = fills.filter(f => new Date(f.time) >= weekStart);
    const weeklyPL = parseFloat((
      weekFills.filter(f => f.isClose).reduce((s, f) => s + (f.closedPnl || 0), 0) -
      weekFills.reduce((s, f) => s + (f.fee || 0), 0)
    ).toFixed(3));

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

    /* ── Monthly history (last 4 weeks grouped by week) ─────── */
    const monthlyHistory = [];
    for (let w = 3; w >= 0; w--) {
      const weekEnd = new Date();
      weekEnd.setUTCDate(weekEnd.getUTCDate() - (w * 7));
      weekEnd.setUTCHours(23, 59, 59, 999);
      const weekStart = new Date(weekEnd);
      weekStart.setUTCDate(weekEnd.getUTCDate() - 6);
      weekStart.setUTCHours(0, 0, 0, 0);

      const wFills = fills.filter(f => {
        const t = new Date(f.time);
        return t >= weekStart && t <= weekEnd;
      });
      const weekPL = wFills.filter(f => f.isClose).reduce((s, f) => s + (f.closedPnl || 0), 0)
                   - wFills.reduce((s, f) => s + (f.fee || 0), 0);
      const weekLabel = 'W' + (4 - w) + ' ' + weekStart.toISOString().slice(5, 10);
      monthlyHistory.push({ label: weekLabel, pnl: parseFloat(weekPL.toFixed(2)) });
    }

    /* ── Recent closed trades ───────────────────────────────── */
    const recentTrades = [...fills]
      .filter(f => f.isClose)
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 8)
      .map(f => ({
        time:   new Date(f.time).toISOString().slice(5, 16).replace('T', ' '),
        dir:    f.direction === 'long' ? 'LONG' : 'SHORT',
        entry:  f.price,
        size:   f.size,
        pnl:    f.closedPnl || 0,
        status: (f.closedPnl || 0) > 0.01 ? 'WIN' :
                (f.closedPnl || 0) < -0.01 ? 'LOSS' : 'BE',
      }));

    /* ── Signal (file-cache → filesystem → fallback) ───────── */
    let signal   = null;
    let planMeta = null;

    /* Resolve TF alignment to an "X/3" string. Handles a persisted tfAlignment in
       any shape (string | number | {score} | {h4,h1,m15} booleans), and otherwise
       DERIVES it from threeLayer.layers.technical biases vs the trade direction —
       which is what last-plan.json actually contains (tfAlignment is not persisted). */
    function resolveTfAlignment(p) {
      const tfa = p.tfAlignment;
      if (typeof tfa === 'string') return tfa;
      if (typeof tfa === 'number') return tfa + '/3';
      if (tfa && typeof tfa.score === 'number') return tfa.score + '/3';
      if (tfa && (tfa.h4 !== undefined || tfa.h1 !== undefined || tfa.m15 !== undefined)) {
        return ((tfa.h4 ? 1 : 0) + (tfa.h1 ? 1 : 0) + (tfa.m15 ? 1 : 0)) + '/3';
      }
      const tech = p.threeLayer?.layers?.technical;
      const target =
        p.direction === 'long'     ? 'bullish' :
        p.direction === 'short'    ? 'bearish' :
        tech?.h4Bias === 'bullish' ? 'bullish' :
        tech?.h4Bias === 'bearish' ? 'bearish' : null;
      if (tech && target) {
        return ((tech.h4Bias  === target ? 1 : 0)
              + (tech.h1Bias  === target ? 1 : 0)
              + (tech.m15Bias === target ? 1 : 0)) + '/3';
      }
      return '0/3';
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
      // HL positions carry no openTime — everything filled after the last CLOSE of this
      // coin belongs to the current position. Cap the lookback at 24h as a safety net.
      const fallbackOpen = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const lastClose = [...fills]
        .filter(f => f.coin === pos.coin && f.isClose)
        .sort((a, b) => new Date(b.time) - new Date(a.time))[0];
      const positionOpenTime = lastClose ? new Date(lastClose.time) : fallbackOpen;

      const positionFills = fills
        .filter(f => f.coin === pos.coin && !f.isClose && new Date(f.time) >= positionOpenTime)
        .sort((a, b) => new Date(a.time) - new Date(b.time));

      const compoundTrades = positionFills.map((f, i) => ({
        time:     new Date(f.time).toISOString().slice(11, 16) + ' UTC',
        type:     i === 0 ? 'ENTRY' : 'COMPOUND ' + i,
        size:     parseFloat(f.size),
        price:    parseFloat(f.price),
        notional: parseFloat((parseFloat(f.size) * parseFloat(f.price)).toFixed(2)),
        fee:      parseFloat(f.fee) || 0,
      }));

      // Weighted-average entry across all opens; fall back to HL's entryPrice if no fills found.
      const totalSize = compoundTrades.reduce((s, t) => s + t.size, 0);
      const weightedEntry = totalSize > 0
        ? compoundTrades.reduce((s, t) => s + t.size * t.price, 0) / totalSize
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

      const effSize   = pos.size || totalSize;
      const slDist    = slPrice ? Math.abs(weightedEntry - slPrice) : 0;
      const totalRisk = effSize * slDist;
      const bal       = balance.balance || 100;
      const riskPct   = bal > 0 ? (totalRisk / bal) * 100 : 0;

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
        totalRisk:        parseFloat(totalRisk.toFixed(2)),
        riskPct:          parseFloat(riskPct.toFixed(2)),
      };
    }

    res.json({
      price:          priceData?.markPrice  || 0,
      funding:        priceData?.funding    || 0,
      balance:        balance.balance       || 0,
      dailyPL,
      weeklyPL,
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
