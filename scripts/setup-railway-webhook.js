import 'dotenv/config';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RAILWAY_URL = process.argv[2] || process.env.RAILWAY_PUBLIC_DOMAIN;

if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}
if (!RAILWAY_URL) {
  console.error('Usage: node scripts/setup-railway-webhook.js <https://your-app.up.railway.app>');
  console.error('Or set RAILWAY_PUBLIC_DOMAIN in .env');
  process.exit(1);
}

const baseUrl = RAILWAY_URL.replace(/\/$/, '');
const webhookUrl = `${baseUrl}/webhook`;
const tgBase = `https://api.telegram.org/bot${TOKEN}`;

async function run() {
  // 1. Delete any existing webhook
  console.log('Removing existing webhook...');
  const del = await fetch(`${tgBase}/deleteWebhook?drop_pending_updates=true`);
  const delJson = await del.json();
  console.log(' delete:', delJson.description);

  // 2. Set new Railway webhook
  console.log(`Setting webhook → ${webhookUrl}`);
  const set = await fetch(`${tgBase}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    }),
  });
  const setJson = await set.json();
  console.log(' set:', setJson.description);

  // 3. Verify
  const info = await fetch(`${tgBase}/getWebhookInfo`);
  const infoJson = await info.json();
  const w = infoJson.result;
  console.log('\nWebhook info:');
  console.log(' url:', w.url);
  console.log(' pending_update_count:', w.pending_update_count);
  console.log(' last_error_message:', w.last_error_message ?? 'none');
  console.log('\nDone. Railway webhook is active.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
