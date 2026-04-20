import { runPipeline } from './pipeline.js';
import { writeFileSync } from 'fs';

const force = process.argv.includes('--force');

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

runPipeline()
  .then(() => {
    writeFileSync('plans/.last-run', new Date().toISOString() + '\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('[run] pipeline fatal error:', err);
    process.exit(2);
  });
