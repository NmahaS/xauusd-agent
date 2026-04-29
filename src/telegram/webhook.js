// Bridges the Express POST /webhook body to the existing command handlers.
// Security check here; routeCommand in commands.js handles dispatch.
import { config } from '../config.js';
import { routeCommand } from './commands.js';

export async function processWebhookUpdate(update) {
  const msg = update.message ?? update.edited_message;
  if (!msg?.text) return;

  if (config.TELEGRAM_CHAT_ID && String(msg.chat.id) !== String(config.TELEGRAM_CHAT_ID)) {
    console.log(`[webhook] ignored message from chat ${msg.chat.id}`);
    return;
  }

  const text = msg.text.trim();
  const spaceIdx = text.indexOf(' ');
  const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  console.log(`[webhook] command: ${command} from chat ${msg.chat.id}`);
  await routeCommand(command, args, msg.chat.id);
}
