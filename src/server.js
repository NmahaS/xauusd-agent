import express from 'express';
import path from 'path';
import 'dotenv/config';
import { processWebhookUpdate } from './telegram/webhook.js';

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
    const { getHLBalance, getHLPositions, getHLAllFills } =
      await import('./broker/hyperliquid.js');
    const { readRiskState } = await import('./risk/manager.js');
    const fs = await import('fs');

    const [balance, positions, fills, state] = await Promise.all([
      getHLBalance(),
      getHLPositions(),
      getHLAllFills('PAXG'),
      readRiskState(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const todayFills = fills.filter(f =>
      new Date(f.time).toISOString().slice(0, 10) === today
    );
    const dailyPL =
      todayFills.filter(f => f.isClose).reduce((s, f) => s + (f.closedPnl || 0), 0) -
      todayFills.reduce((s, f) => s + (f.fee || 0), 0);

    const weekStart = new Date();
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekFills = fills.filter(f => new Date(f.time) >= weekStart);
    const weeklyPL =
      weekFills.filter(f => f.isClose).reduce((s, f) => s + (f.closedPnl || 0), 0) -
      weekFills.reduce((s, f) => s + (f.fee || 0), 0);

    const recentTrades = [...fills]
      .filter(f => f.isClose)
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 8)
      .map(f => ({
        time: new Date(f.time).toISOString().slice(5, 16).replace('T', ' '),
        dir: f.direction === 'long' ? 'LONG' : 'SHORT',
        entry: f.price,
        size: f.size,
        pnl: f.closedPnl || 0,
        status: (f.closedPnl || 0) > 0.01 ? 'WIN' :
                (f.closedPnl || 0) < -0.01 ? 'LOSS' : 'BE',
      }));

    let lastPlan = null;
    try {
      const plansDir = path.join(process.cwd(), 'plans');
      const dates = fs.default.readdirSync(plansDir).sort().slice(-1);
      if (dates[0]) {
        const files = fs.default
          .readdirSync(path.join(plansDir, dates[0]))
          .filter(f => f.endsWith('.json') && f !== 'daily-summary.json')
          .sort()
          .slice(-1);
        if (files[0]) {
          lastPlan = JSON.parse(
            fs.default.readFileSync(path.join(plansDir, dates[0], files[0]), 'utf8')
          );
        }
      }
    } catch (_e) {}

    res.json({
      price: positions[0]?.markPrice || lastPlan?.currentPrice || 0,
      balance: balance.balance || 0,
      dailyPL,
      weeklyPL,
      dailyTrades: state?.dailyTrades || 0,
      position: positions[0] || null,
      signal: lastPlan ? {
        bias: lastPlan.direction === 'long' ? 'BULLISH' :
              lastPlan.direction === 'short' ? 'BEARISH' : 'NEUTRAL',
        tier: lastPlan.threeLayer?.tier || 3,
        confluence: lastPlan.confluenceCount || 0,
        direction: lastPlan.direction,
        factors: lastPlan.confluenceFactors || [],
        tfAlignment: (lastPlan.tfAlignment?.score || 0) + '/3',
        session: lastPlan.session || 'Unknown',
      } : null,
      trades: recentTrades,
      atr: lastPlan?.m15Indicators?.atr || 0,
    });
  } catch (err) {
    console.error('[dashboard] API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on port ${PORT}`);
});
