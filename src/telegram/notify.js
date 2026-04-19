import { config } from '../config.js';

const TG_BASE = 'https://api.telegram.org/bot';

export async function sendTelegramMessage(text, { parseMode = 'HTML', disablePreview = true } = {}) {
  if (config.DRY_RUN) {
    console.log('[telegram] DRY_RUN — skipping Telegram send. Message preview:\n' + text.slice(0, 800));
    return { ok: true, skipped: true };
  }

  const url = `${TG_BASE}${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: config.TELEGRAM_CHAT_ID,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: disablePreview,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      throw new Error(`Telegram HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    console.log(`[telegram] message sent (id=${json.result?.message_id})`);
    return { ok: true, messageId: json.result?.message_id };
  } catch (err) {
    console.warn(`[telegram] send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
