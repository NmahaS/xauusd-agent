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

    /* ── Last trading plan ──────────────────────────────────── */
    let lastPlan = null;
    let signal   = null;
    let planMeta = null;

    try {
      const plansDir = path.join(process.cwd(), 'plans');
      if (fs.existsSync(plansDir)) {
        const dates = fs.readdirSync(plansDir)
          .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort()
          .slice(-1);

        if (dates[0]) {
          const dayDir = path.join(plansDir, dates[0]);
          const files  = fs.readdirSync(dayDir)
            .filter(f => f.endsWith('.json') && f !== 'daily-summary.json')
            .sort()
            .slice(-1);

          if (files[0]) {
            lastPlan = JSON.parse(fs.readFileSync(path.join(dayDir, files[0]), 'utf8'));
          }
        }
      }
    } catch (e) {
      console.error('[dashboard] plan read error:', e.message);
    }

    if (lastPlan) {
      signal = {
        bias:          lastPlan.direction === 'long'  ? 'BULLISH' :
                       lastPlan.direction === 'short' ? 'BEARISH' : 'NEUTRAL',
        tier:          lastPlan.threeLayer?.tier       || 3,
        confluence:    lastPlan.confluenceCount        || 0,
        direction:     lastPlan.direction              || null,
        factors:       lastPlan.confluenceFactors      || [],
        tfAlignment:   (lastPlan.tfAlignment?.score    || 0) + '/3',
        session:       lastPlan.session                || 'Unknown',
        regime:        lastPlan.threeLayer?.layers?.flow?.regime || 'unknown',
        quality:       lastPlan.setupQuality           || 'no-trade',
        executed:      lastPlan.execution?.executed    || false,
        blockedReason: lastPlan.execution?.reason      || null,
      };
      planMeta = {
        sl:  lastPlan.stopLoss?.price    || 0,
        tp1: lastPlan.takeProfits?.[0]?.price || 0,
        tp2: lastPlan.takeProfits?.[1]?.price || 0,
      };
    }

    console.log('[dashboard] price:', priceData?.markPrice, '| atr:', atr,
                '| plan keys:', lastPlan ? Object.keys(lastPlan).slice(0, 8).join(',') : 'none');

    /* ── Position with correct field names ──────────────────── */
    const pos = positions[0];
    const posOut = pos ? {
      direction:        pos.direction,
      size:             pos.size,
      entryPrice:       pos.entryPrice,
      unrealizedPnl:    parseFloat((pos.unrealizedPnl || 0).toFixed(2)),
      leverage:         pos.leverage,
      liquidationPrice: pos.liquidationPrice,
      notional:         parseFloat((pos.size * pos.entryPrice).toFixed(2)),
    } : null;

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
