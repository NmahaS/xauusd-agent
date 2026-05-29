import 'dotenv/config';
import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { placeHLOrder } from '../src/broker/hyperliquid.js';

// Pass --full to test the complete placeHLOrder flow (entry + SL + TPs).
// Warning: --full places a REAL entry order that will auto-cancel via IOC,
// then attempts SL and TP placement if it fills.
const FULL_TEST = process.argv.includes('--full');

function actionHash(action, nonce) {
  const msgPackBytes = msgpackEncode(action);
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  data[msgPackBytes.length + 8] = 0; // no vault
  return ethers.keccak256(data);
}

const BASE_URL = process.env.HL_DEMO === 'true'
  ? 'https://api.hyperliquid-testnet.xyz'
  : 'https://api.hyperliquid.xyz';

async function testOrder() {
  console.log('=== HYPERLIQUID ORDER TEST ===\n');

  // Step 1: Check wallet
  let pk = process.env.HL_PRIVATE_KEY || '';
  if (!pk.startsWith('0x')) pk = '0x' + pk;
  const wallet = new ethers.Wallet(pk);
  console.log('API wallet:', wallet.address);
  console.log('Main wallet:', process.env.HL_WALLET_ADDRESS);

  // Step 2: Check balance on both wallets (trading margin comes from HL_WALLET_ADDRESS)
  console.log('\nChecking balance...');
  async function fetchBalance(address) {
    const r = await fetch(`${BASE_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    });
    const d = await r.json();
    return parseFloat(d.marginSummary?.accountValue || 0);
  }

  const apiBalance  = await fetchBalance(wallet.address);
  const mainBalance = process.env.HL_WALLET_ADDRESS
    ? await fetchBalance(process.env.HL_WALLET_ADDRESS)
    : 0;

  console.log('API wallet balance:  $' + apiBalance.toFixed(2));
  console.log('Main wallet balance: $' + mainBalance.toFixed(2));

  const balance = Math.max(apiBalance, mainBalance);
  if (balance < 5) {
    console.error('❌ Balance too low for test (both wallets have < $5)');
    console.error('   Deposit USDC to HL_WALLET_ADDRESS on app.hyperliquid.xyz');
    process.exit(1);
  }

  // Step 3: Get PAXG current price
  console.log('\nFetching PAXG price...');
  const metaRes = await fetch(`${BASE_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const [meta, assetCtxs] = await metaRes.json();
  const paxgIdx = meta.universe.findIndex(a => a.name === 'PAXG');

  if (paxgIdx === -1) {
    console.log('Available coins:', meta.universe.map(a => a.name).join(', '));
    console.error('❌ PAXG not found');
    process.exit(1);
  }

  // API returns markPx (not markPrice)
  const markPrice = parseFloat(assetCtxs[paxgIdx].markPx);
  console.log('PAXG index:', paxgIdx);
  console.log('PAXG mark price: $' + markPrice.toFixed(2));

  // Get tick size and size decimals for PAXG
  const paxgAsset = meta.universe[paxgIdx];
  const tickSize = parseFloat(paxgAsset.tickSize || '1');
  const szDecimals = paxgAsset.szDecimals || 0;

  console.log('PAXG tick size:', tickSize);
  console.log('PAXG size decimals:', szDecimals);

  // Step 4: Place IOC test order far below market (auto-cancels if not filled)
  // 50% slippage = won't fill; IOC = immediately cancelled if unfilled
  // Same order type as real orders (which use 5% slippage to guarantee fill)

  const slippage = 0.50; // 50% below market — won't fill
  const rawTestPrice = markPrice * (1 - slippage);
  const roundedTestPrice = Math.round(rawTestPrice / tickSize) * tickSize;
  const pxDecimals = tickSize < 1 ? Math.abs(Math.floor(Math.log10(tickSize))) : 0;
  const testPrice = String(parseFloat(roundedTestPrice.toFixed(pxDecimals)));

  console.log('Rounded test price:', testPrice, `(${slippage * 100}% below market — IOC, auto-cancels)`);

  // Minimum size to meet Hyperliquid's $10 notional minimum
  const minSize = Math.ceil(10 / roundedTestPrice * Math.pow(10, szDecimals)) / Math.pow(10, szDecimals);
  const testSize = minSize.toFixed(szDecimals);

  console.log('\nPlacing test IOC BUY order...');
  console.log('Size:', testSize, 'PAXG');
  console.log('Price: $' + testPrice, '(IOC — will auto-cancel if not filled)');
  console.log('Purpose: verify signing + submission chain works end-to-end');

  // Build order action — IOC same as real market orders
  const orderAction = {
    type: 'order',
    orders: [{
      a: paxgIdx,
      b: true,          // buy
      p: testPrice,
      s: testSize,
      r: false,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  };

  // Sign order
  const nonce = Date.now();

  // Hyperliquid EIP-712 signing
  const domain = {
    chainId: 1337,
    name: 'Exchange',
    verifyingContract: '0x0000000000000000000000000000000000000000',
    version: '1',
  };

  const phantomAgent = {
    source: 'a',
    connectionId: actionHash(orderAction, nonce),
  };

  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };

  console.log('\nSigning order with API wallet...');
  const signature = await wallet.signTypedData(domain, types, phantomAgent);
  const r = '0x' + signature.slice(2, 66);
  const s = '0x' + signature.slice(66, 130);
  const v = parseInt(signature.slice(130, 132), 16);

  // Submit order
  console.log('Submitting order...');
  const submitRes = await fetch(`${BASE_URL}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: orderAction,
      nonce,
      signature: { r, s, v },
    }),
  });

  const result = await submitRes.json();
  console.log('\nResult:', JSON.stringify(result, null, 2));

  if (result.status === 'ok') {
    const statusObj = result.response?.data?.statuses?.[0] ?? {};
    const filled = statusObj.filled;
    const cancelled = statusObj.cancelled;
    const resting = statusObj.resting;

    if (filled) {
      console.log('\n⚠️  ORDER FILLED (unexpected — test price was 50% below market)');
      console.log('Fill price:', filled.avgPx, '  Size:', filled.totalSz);
      console.log('orderId:', filled.oid);
    } else if (cancelled) {
      console.log('\n✅ ORDER SUBMITTED + AUTO-CANCELLED (IOC — price not reached)');
      console.log('orderId:', cancelled.oid);
      console.log('The full execution chain works end-to-end: sign → submit → IOC auto-cancel.');
    } else if (resting) {
      console.log('\n⚠️  ORDER IS RESTING (expected IOC — check order type)');
      console.log('orderId:', resting.oid);
    } else if (statusObj.error?.includes('could not immediately match')) {
      console.log('\n✅ ORDER SUBMITTED + IOC REJECTED (no match at test price — expected)');
      console.log('The full execution chain works end-to-end: sign → submit → IOC auto-cancel.');
    } else {
      console.log('\n✅ ORDER ACCEPTED (status:', JSON.stringify(statusObj), ')');
      console.log('Execution chain verified.');
    }
  } else {
    console.log('\n❌ ORDER FAILED');
    console.log('Error:', JSON.stringify(result));

    if (JSON.stringify(result).includes('does not exist')) {
      console.log('\n🔧 FIX REQUIRED:');
      console.log('Your API wallet is not authorized on Hyperliquid.');
      console.log('Steps:');
      console.log('1. Go to app.hyperliquid.xyz');
      console.log('2. Connect MetaMask (' + process.env.HL_WALLET_ADDRESS + ')');
      console.log('3. Settings → API Wallets');
      console.log('4. Find: ' + wallet.address);
      console.log('5. Click Authorize → Sign with MetaMask');
    }

    if (JSON.stringify(result).includes('insufficient')) {
      console.log('\n🔧 FIX: Insufficient margin — check balance');
    }
  }

  return markPrice;
}

async function testFullOrder(markPrice) {
  const slOffset = 50;
  const tp1Offset = 80;
  const tp2Offset = 150;
  const tp3Offset = 250;

  // Long test: entry near mark, SL 50pts below, TPs above
  const testPlan = {
    direction: 'long',
    stopLoss: { price: markPrice - slOffset, reasoning: 'test SL' },
    takeProfits: [
      { level: 'TP1', price: markPrice + tp1Offset, rr: 1.6, reasoning: 'test TP1' },
      { level: 'TP2', price: markPrice + tp2Offset, rr: 3.0, reasoning: 'test TP2' },
      { level: 'TP3', price: markPrice + tp3Offset, rr: 5.0, reasoning: 'test TP3' },
    ],
  };

  console.log('\n=== FULL ORDER TEST (placeHLOrder) ===');
  console.log('Plan:', JSON.stringify(testPlan, null, 2));
  console.log('\nPlacing entry + SL + TPs via placeHLOrder...');
  console.log('NOTE: Entry uses 5% slippage — may fill at market price.');

  const result = await placeHLOrder({
    coin: process.env.HL_COIN || 'PAXG',
    direction: 'long',
    size: 0.001, // minimum size
    markPrice,
    plan: testPlan,
  });

  console.log('\nplaceHLOrder result:', JSON.stringify(result, null, 2));
  if (result.status === 'placed') {
    console.log(`✅ Entry filled | SL placed: ${result.slPlaced} | TPs placed: ${result.tpCount}`);
  } else if (result.status === 'unfilled') {
    console.log('⚠️  Entry did not fill — SL/TP skipped');
  }
}

testOrder()
  .then(async (markPrice) => {
    if (FULL_TEST && markPrice) {
      await testFullOrder(markPrice);
    }
  })
  .catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
