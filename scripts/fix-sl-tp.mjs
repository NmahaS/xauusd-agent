import 'dotenv/config';
import { getHLPositions, placeSL, placeTP } from '../src/broker/hyperliquid.js';

const positions = await getHLPositions();
console.log('Open positions:', positions.length);

if (positions.length === 0) {
  console.log('No open positions found.');
  process.exit(0);
}

for (const p of positions) {
  console.log(`\n${p.coin} ${p.direction.toUpperCase()} ${p.size} @ entry $${p.entryPrice}`);

  const entryPrice = p.entryPrice;
  const atr = 9;
  const slDistance = atr * 1.0;
  const tpDistance = slDistance * 2.0;

  const slPrice = p.direction === 'long'
    ? entryPrice - slDistance
    : entryPrice + slDistance;

  const tpPrice = p.direction === 'long'
    ? entryPrice + tpDistance
    : entryPrice - tpDistance;

  console.log(`SL: $${slPrice.toFixed(2)} (${slDistance}pts from entry)`);
  console.log(`TP: $${tpPrice.toFixed(2)} (${tpDistance}pts from entry, 2R)`);

  console.log('Placing SL...');
  const slResult = await placeSL({ coin: p.coin, direction: p.direction, size: p.size, slPrice });
  console.log('SL placed:', slResult);

  await new Promise(r => setTimeout(r, 1000));

  console.log('Placing TP...');
  const tpResult = await placeTP({ coin: p.coin, direction: p.direction, size: p.size, tpPrice });
  console.log('TP placed:', tpResult);
}
