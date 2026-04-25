import 'dotenv/config';
import fs from 'fs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IG_ENV_LABEL = process.env.IG_DEMO === 'false' ? 'LIVE' : 'DEMO';

async function sendEmergencyTelegram(msg) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('Emergency Telegram failed:', e.message);
  }
}

const force = process.argv.includes('--force');

try {
  if (!force) {
    const now = new Date();
    const day = now.getUTCDay();
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const isOpen =
      day !== 6 &&
      !(day === 0 && mins < 22 * 60) &&
      !(day === 5 && mins >= 22 * 60);

    if (!isOpen) {
      console.log(`Gold market is closed (UTC: ${now.toISOString()}). Skipping run. Use --force to override.`);
      process.exit(0);
    }
  }

  if (force) console.log('[run] --force: skipping market hours check');

  const { runPipeline } = await import('./pipeline.js');
  await runPipeline();

  fs.mkdirSync('plans', { recursive: true });
  fs.writeFileSync('plans/.last-run', new Date().toISOString() + '\n');
  process.exit(0);
} catch (err) {
  console.error('FATAL:', err.message, err.stack);
  await sendEmergencyTelegram(`🔴 <b>XAUUSD Agent Error [${IG_ENV_LABEL}]</b>\n<code>${err.message}</code>`);
  process.exit(1);
}
