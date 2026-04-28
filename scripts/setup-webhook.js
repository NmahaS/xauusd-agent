// Registers a Cloudflare Worker URL as the Telegram webhook.
// Usage: node scripts/setup-webhook.js https://xauusd-bot.YOUR-NAME.workers.dev
import 'dotenv/config';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WORKER_URL = process.argv[2];

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}
if (!WORKER_URL) {
  console.error('Usage: node scripts/setup-webhook.js https://xauusd-bot.YOUR-NAME.workers.dev');
  process.exit(1);
}

console.log(`Setting webhook → ${WORKER_URL}`);

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: WORKER_URL,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  }),
});
const data = await res.json();
console.log('setWebhook:', JSON.stringify(data, null, 2));

const infoRes = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
const info = await infoRes.json();
console.log('getWebhookInfo:', JSON.stringify(info.result, null, 2));
