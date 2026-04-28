// Telegram bot polling entry point. Runs as a one-shot pass: load offset, call
// getUpdates, process each update, save new offset, exit. Designed for GitHub
// Actions cron (*/3 * * * *) — no long-running process needed.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { processCommand } from './commands.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_BASE = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = path.resolve('plans/.last-update-id');

async function loadOffset() {
  try {
    const raw = await fs.readFile(OFFSET_FILE, 'utf8');
    return parseInt(raw.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function saveOffset(offset) {
  await fs.mkdir(path.dirname(OFFSET_FILE), { recursive: true });
  await fs.writeFile(OFFSET_FILE, String(offset));
}

async function getUpdates(offset) {
  const url = `${TG_BASE}/getUpdates?timeout=0&offset=${offset}&allowed_updates=message`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`getUpdates HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.result || [];
}

async function run() {
  if (!TOKEN) {
    console.error('[bot] TELEGRAM_BOT_TOKEN not set — exiting');
    process.exit(1);
  }

  const offset = await loadOffset();
  console.log(`[bot] polling offset=${offset}`);

  let updates;
  try {
    updates = await getUpdates(offset + 1);
  } catch (err) {
    console.error(`[bot] getUpdates failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`[bot] ${updates.length} update(s)`);
  if (!updates.length) return;

  for (const update of updates) {
    const msg = update.message ?? update.channel_post;
    if (!msg?.text) continue;
    const fromChatId = String(msg.chat?.id ?? '');
    await processCommand(msg.text, fromChatId).catch(err =>
      console.error(`[bot] processCommand error: ${err.message}`)
    );
  }

  const lastId = updates[updates.length - 1].update_id;
  await saveOffset(lastId);
  console.log(`[bot] saved offset=${lastId}`);
}

run().catch(err => {
  console.error(`[bot] fatal: ${err.message}`);
  process.exit(1);
});
