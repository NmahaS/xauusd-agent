import 'dotenv/config';
import { getSpotBalance, getHLBalance } from '../src/broker/hyperliquid.js';

console.log('Testing spot/perp balance check...');

const [spot, perp] = await Promise.all([getSpotBalance(), getHLBalance()]);

console.log('Spot USDC: ', spot.toFixed(2));
console.log('Perp USDC: ', perp.balance.toFixed(2));
console.log('Total:     ', (spot + perp.balance).toFixed(2));
console.log('');

const goalReward = parseFloat(process.env.WEEKLY_GOAL_REWARD || '100');
if (spot >= goalReward) {
  console.log('✅ Auto-transfer ready');
  console.log(`Transfer available: $${goalReward} USDC`);
} else {
  console.log('⚠️ Need more spot balance for auto-transfer');
  console.log(`Need: $${(goalReward - spot).toFixed(2)} more USDC in spot`);
  console.log(`Add at: app.hyperliquid.xyz`);
}
