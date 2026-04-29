import express from 'express';
import 'dotenv/config';
import { processWebhookUpdate } from './telegram/webhook.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on port ${PORT}`);
});
