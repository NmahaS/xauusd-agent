import 'dotenv/config';

// Gold trades Sun 22:00 UTC → Fri 22:00 UTC. Exit 1 if market is closed.

const now = new Date();
const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
const hour = now.getUTCHours();
const minute = now.getUTCMinutes();
const timeInMinutes = hour * 60 + minute;

const OPEN_SUN = 22 * 60;   // Sun 22:00 UTC
const CLOSE_FRI = 22 * 60;  // Fri 22:00 UTC

let isOpen;

if (day === 6) {
  // Saturday: always closed
  isOpen = false;
} else if (day === 0) {
  // Sunday: open from 22:00 UTC
  isOpen = timeInMinutes >= OPEN_SUN;
} else if (day === 5) {
  // Friday: open until 22:00 UTC
  isOpen = timeInMinutes < CLOSE_FRI;
} else {
  // Mon–Thu: always open
  isOpen = true;
}

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
console.log(`[market] day=${dayNames[day]}(${day}) hour=${hour} min=${minute} → ${isOpen ? 'open' : 'closed'}`);

if (!isOpen) {
  console.log(`Gold market is closed (UTC: ${now.toISOString()}). Skipping run.`);

  // Weekend heartbeat: once per day at 12:00 UTC (Sat all day, Sun before 22:00)
  const isWeekend = day === 6 || (day === 0 && timeInMinutes < OPEN_SUN);
  if (isWeekend && hour === 12 && minute < 10) {
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    if (TOKEN && CHAT_ID) {
      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: '💤 XAUUSD Agent — market closed. Resumes Sunday 22:00 UTC (Mon 08:00 AEST)',
            parse_mode: 'HTML',
          }),
        });
        console.log('[market] weekend heartbeat sent');
      } catch (e) {
        console.warn('[market] heartbeat send failed:', e.message);
      }
    }
  }

  process.exit(1);
}

console.log(`Gold market is open (UTC: ${now.toISOString()}). Proceeding.`);
