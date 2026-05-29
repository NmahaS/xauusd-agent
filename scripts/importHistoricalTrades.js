import 'dotenv/config';
import { saveTrade } from '../src/memory/tradeDB.js';

const wallet = process.env.HL_WALLET_ADDRESS;
if (!wallet) {
  console.error('HL_WALLET_ADDRESS not set');
  process.exit(1);
}

console.log('Fetching userFills for', wallet);

const res = await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'userFills',
    user: wallet,
  }),
});

const fills = await res.json();
const paxg = fills.filter(f => f.coin === 'PAXG').sort((a, b) => a.time - b.time);
console.log('PAXG fills:', paxg.length);

const opens = paxg.filter(f => f.dir.startsWith('Open'));
const closes = paxg.filter(f => f.dir.startsWith('Close'));
console.log('Opens:', opens.length, 'Closes:', closes.length);

const usedCloses = new Set();
let imported = 0;

for (const open of opens) {
  const openTime = new Date(open.time).toISOString();
  const isLong = open.dir.includes('Long');
  const direction = isLong ? 'long' : 'short';
  const entryPrice = parseFloat(open.px);

  // Find matching close (chronologically after open, same direction, unused)
  const matchingClose = closes.find(c =>
    !usedCloses.has(c.oid) &&
    c.time > open.time &&
    c.dir.includes(isLong ? 'Long' : 'Short')
  );

  if (!matchingClose) continue;
  usedCloses.add(matchingClose.oid);

  const exitPrice = parseFloat(matchingClose.px);
  const closedPnl = parseFloat(matchingClose.closedPnl);
  const fees = (parseFloat(open.fee) || 0) + (parseFloat(matchingClose.fee) || 0);
  const netPnl = closedPnl - fees;

  const hour = new Date(open.time).getUTCHours();
  const session =
    hour >= 7 && hour < 12 ? 'london' :
    hour >= 12 && hour < 21 ? 'ny' :
    hour >= 21 ? 'late_ny' : 'dead';

  const outcome =
    closedPnl > 0.01 ? 'WIN' :
    closedPnl < -0.01 ? 'LOSS' : 'BREAKEVEN';

  saveTrade({
    orderId: String(open.oid),
    openTime,
    closeTime: new Date(matchingClose.time).toISOString(),
    session,
    inKillZone: (hour >= 7 && hour < 10) || (hour >= 12 && hour < 15) ? 1 : 0,
    direction,
    entryPrice,
    exitPrice,
    h4Bias: null,
    h1Bias: null,
    m15Bias: null,
    m15Event: null,
    tier: null,
    confluence: null,
    quality: null,
    consensus: null,
    atr: null,
    slDistance: null,
    riskPct: null,
    outcome,
    rr: null,
    pnl: closedPnl,
    fees,
    netPnl,
  });

  imported++;
  console.log('Imported:', open.oid, direction, session, outcome, netPnl.toFixed(3));
}

console.log('Total imported:', imported, 'trades');
