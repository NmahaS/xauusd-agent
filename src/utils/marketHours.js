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

const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
console.log(`[market] day=${dayNames[day]}(${day}) hour=${hour} min=${minute} → ${isOpen ? 'open' : 'closed'}`);

if (!isOpen) {
  console.log(`Gold market is closed (UTC: ${now.toISOString()}). Skipping run.`);
  process.exit(1);
}

console.log(`Gold market is open (UTC: ${now.toISOString()}). Proceeding.`);
