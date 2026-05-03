import cron from 'node-cron';
import fs from 'node:fs/promises';
import 'dotenv/config';
import { syncFileToGithub } from './utils/gitSync.js';

console.log('[cron] starting scheduler...');

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return !(
    (day === 5 && hour >= 22) || // Friday 22:00+
    day === 6 ||                  // All Saturday
    (day === 0 && hour < 22)     // Sunday before 22:00
  );
}

// Full pipeline every 15 minutes — :00, :15, :30, :45
cron.schedule('*/15 * * * *', async () => {
  const now = new Date();
  console.log(`\n[cron] ⏰ triggered at ${now.toISOString()}`);

  if (!isMarketOpen()) {
    console.log('[cron] market closed — skipping run');
    return;
  }

  try {
    const { runPipeline } = await import('./pipeline.js');
    await runPipeline();

    // Write and sync .last-run
    const lastRun = now.toISOString() + '\n';
    await fs.mkdir('plans', { recursive: true });
    await fs.writeFile('plans/.last-run', lastRun);
    syncFileToGithub('plans/.last-run', lastRun).catch(() => {});
  } catch (err) {
    console.error('[cron] pipeline error:', err.message);
    await sendTelegram(
      `🔴 <b>Pipeline crashed</b>\n<code>${err.message}</code>\n<i>${now.toISOString()}</i>`
    );
  }
}, { timezone: 'UTC' });

// Daily heartbeat at 08:00 UTC
cron.schedule('0 8 * * *', async () => {
  const uptime = Math.floor(process.uptime() / 3600);
  const dayOfWeek = new Date().getUTCDay();
  const blockedToday = dayOfWeek === 3; // Wednesday
  const dayLine = blockedToday
    ? '⚠️ Wednesday — no auto-execution today'
    : '✅ Trading day — A/A+ full consensus will auto-execute';
  await sendTelegram(
    `💚 <b>Agent online</b> — uptime ${uptime}h\n` +
    `Auto-trade: ${process.env.AUTO_TRADE === 'true' ? '✅ ON' : '❌ OFF'}\n` +
    `${dayLine}\n` +
    `Next run: within 15 min`
  );
}, { timezone: 'UTC' });

// Monthly report on the 1st at 00:10 UTC
cron.schedule('10 0 1 * *', async () => {
  console.log('[cron] monthly report triggered');
  try {
    const { runMonthlyReport } = await import('./plan/generateMonthlyReport.js');
    await runMonthlyReport();
  } catch (err) {
    console.error('[cron] monthly report error:', err.message);
  }
}, { timezone: 'UTC' });

// Monday 21:00 UTC — refresh weekly macro state (1 hour before market open + cache warmup)
cron.schedule('0 21 * * 1', async () => {
  console.log('[cron] Monday macro refresh...');
  try {
    // Clear macro caches to force fresh weekly data
    const fsSync = (await import('node:fs')).default;
    ['cache/macro_state.json', 'cache/cot.json', 'cache/weekly_macro.json'].forEach(f => {
      try { fsSync.unlinkSync(f); } catch {}
    });
    const { getWeeklyMacroState } = await import('./macro/macroState.js');
    const state = await getWeeklyMacroState();

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text:
            `📊 <b>Weekly Macro Update</b>\n\n` +
            `Bias: <b>${(state.weeklyBias || 'unknown').toUpperCase()}</b>\n` +
            `Score: ${state.bullishPoints}B / ${state.bearishPoints}Br\n\n` +
            `<b>Factors:</b>\n${(state.factors || []).map(f => `• ${f}`).join('\n') || 'none'}\n\n` +
            `<i>COT: ${state.cot?.cotSignal || 'unavailable'}</i>`,
          parse_mode: 'HTML',
        }),
      });
    }
    console.log(`[cron] weekly macro: ${state.weeklyBias}`);
  } catch (err) {
    console.error('[cron] macro refresh failed:', err.message);
  }
}, { timezone: 'UTC' });

// Friday 16:00 UTC — COT data releases at 15:30 ET (20:30 UTC), fetch 30 min after
cron.schedule('0 16 * * 5', async () => {
  console.log('[cron] Friday COT refresh...');
  try {
    const fsSync = (await import('node:fs')).default;
    try { fsSync.unlinkSync('cache/cot.json'); } catch {}
    const { fetchCOTReport } = await import('./macro/cot.js');
    const cot = await fetchCOTReport();

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `📋 <b>COT Report Updated</b>\n\n${cot.cotSignal}\n\nBias: <b>${(cot.cotBias || 'neutral').toUpperCase()}</b>`,
          parse_mode: 'HTML',
        }),
      });
    }
  } catch (err) {
    console.error('[cron] COT refresh failed:', err.message);
  }
}, { timezone: 'UTC' });

// Monday 22:05 UTC — clear stale cache and warm up with fresh weekly data
cron.schedule('5 22 * * 1', async () => {
  console.log('[cron] Monday market open — clearing cache for fresh weekly data');
  try {
    const fsModule = await import('node:fs');
    const fsSyn = fsModule.default;
    if (fsSyn.existsSync('cache')) {
      const files = fsSyn.readdirSync('cache').filter(f => f.endsWith('.json'));
      files.forEach(f => fsSyn.unlinkSync(`cache/${f}`));
      console.log(`[cron] cleared ${files.length} cache files — cold start on next run`);
    }

    const { fetchAllIGData } = await import('./data/ig.js');
    await fetchAllIGData();
    console.log('[cron] Monday cache warmup complete');

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '📊 <b>Weekly cache refreshed</b>\nFresh 200-candle history loaded.\nReady to trade this week. ✅',
          parse_mode: 'HTML',
        }),
      });
    }
  } catch (err) {
    console.error('[cron] Monday warmup failed:', err.message);
  }
}, { timezone: 'UTC' });

console.log('[cron] scheduler ready — pipeline every 15 min during market hours');
console.log('[cron] daily heartbeat at 08:00 UTC');
console.log('[cron] monthly report on 1st at 00:10 UTC');
console.log('[cron] Monday 21:00 UTC — weekly macro refresh');
console.log('[cron] Friday 16:00 UTC — COT report refresh');
console.log('[cron] Monday 22:05 UTC — weekly candle cache warmup');
