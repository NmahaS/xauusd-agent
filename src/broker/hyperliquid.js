import { ethers } from 'ethers';

const HL_BASE = 'https://api.hyperliquid.xyz';

function getWallet() {
  let privateKey = process.env.HL_PRIVATE_KEY;
  if (!privateKey) throw new Error('HL_PRIVATE_KEY not set');
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
  if (privateKey.length !== 66) {
    throw new Error(
      `HL_PRIVATE_KEY invalid length: got ${privateKey.length} chars, need 66 (0x + 64 hex). ` +
      `Check env var — copy the full private key from Hyperliquid API wallet.`
    );
  }
  return new ethers.Wallet(privateKey);
}

async function getAssetIndex(coin) {
  const res = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  const meta = await res.json();
  const idx = meta.universe.findIndex(a => a.name === coin);
  if (idx === -1) throw new Error(`${coin} not found on Hyperliquid`);
  return idx;
}

async function signHLAction(wallet, action, nonce) {
  const domain = {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };

  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };

  const phantomAgent = {
    source: 'a',
    connectionId: ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(action) + nonce)
    ),
  };

  const signature = await wallet.signTypedData(domain, types, phantomAgent);
  return {
    r: '0x' + signature.slice(2, 66),
    s: '0x' + signature.slice(66, 130),
    v: parseInt(signature.slice(130, 132), 16),
  };
}

async function placeHLStopLoss({ assetIdx, direction, size, stopLoss, wallet, nonce }) {
  const isBuy = direction === 'short'; // opposite to close position
  const stopAction = {
    type: 'order',
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: stopLoss.toFixed(2),
      s: size.toFixed(4),
      r: true,
      t: {
        trigger: {
          isMarket: true,
          triggerPx: stopLoss.toFixed(2),
          tpsl: 'sl',
        },
      },
    }],
    grouping: 'na',
  };

  const signature = await signHLAction(wallet, stopAction, nonce);
  const res = await fetch(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: stopAction, nonce, signature }),
  });
  const result = await res.json();
  console.log(`[hl-exec] stop loss placed at ${stopLoss} status=${result.status}`);
  return result;
}

export async function placeHLOrder({ coin, direction, size, limitPrice, stopLoss }) {
  const wallet = getWallet();
  const assetIdx = await getAssetIndex(coin);
  const isBuy = direction === 'long';
  const nonce = Date.now();

  const orderAction = {
    type: 'order',
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: limitPrice.toFixed(2),
      s: size.toFixed(4),
      r: false,
      t: { limit: { tif: 'Gtc' } },
    }],
    grouping: 'na',
  };

  const signature = await signHLAction(wallet, orderAction, nonce);

  const res = await fetch(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: orderAction, nonce, signature }),
  });

  const result = await res.json();
  console.log(`[hl-exec] order result:`, JSON.stringify(result));

  if (result.status !== 'ok') {
    throw new Error(`Order failed: ${JSON.stringify(result)}`);
  }

  const orderId =
    result.response?.data?.statuses?.[0]?.resting?.oid ??
    result.response?.data?.statuses?.[0]?.filled?.oid ??
    null;

  if (stopLoss) {
    try {
      await placeHLStopLoss({ assetIdx, direction, size, stopLoss, wallet, nonce: nonce + 1 });
    } catch (err) {
      console.warn(`[hl-exec] stop loss placement failed: ${err.message}`);
    }
  }

  return { orderId, direction, size, limitPrice, status: 'placed' };
}

export async function getHLPositions() {
  const wallet = getWallet();
  const address = wallet.address;

  const res = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
  });

  const data = await res.json();
  return (data.assetPositions || [])
    .filter(p => parseFloat(p.position?.szi ?? 0) !== 0)
    .map(p => ({
      coin: p.position.coin,
      direction: parseFloat(p.position.szi) > 0 ? 'long' : 'short',
      size: Math.abs(parseFloat(p.position.szi)),
      entryPrice: parseFloat(p.position.entryPx),
      unrealizedPnl: parseFloat(p.position.unrealizedPnl),
      leverage: p.position.leverage?.value || 1,
    }));
}

export async function getHLBalance() {
  const wallet = getWallet();
  const address = wallet.address;

  const res = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
  });

  const data = await res.json();
  const balance = parseFloat(data.marginSummary?.accountValue ?? 0);
  const available = parseFloat(data.marginSummary?.withdrawable ?? 0);
  const unrealizedPnl = parseFloat(data.marginSummary?.totalUnrealizedPnl ?? 0);

  console.log(`[hl] balance=$${balance.toFixed(2)} available=$${available.toFixed(2)} pnl=$${unrealizedPnl.toFixed(2)}`);

  return { balance, available, unrealizedPnl };
}

// Closes an open position using a reduce-only market order.
export async function closeHLPosition(coin, direction, size) {
  const wallet = getWallet();
  const assetIdx = await getAssetIndex(coin);
  const isBuy = direction === 'short'; // opposite to close
  const nonce = Date.now();

  const markRes = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const [meta2, assetCtxs] = await markRes.json();
  const idx2 = meta2.universe.findIndex(a => a.name === coin);
  const markPrice = parseFloat(assetCtxs[idx2]?.markPx ?? 0);
  const closePrice = isBuy ? markPrice * 1.005 : markPrice * 0.995;

  const closeAction = {
    type: 'order',
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: closePrice.toFixed(2),
      s: size.toFixed(4),
      r: true,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  };

  const signature = await signHLAction(wallet, closeAction, nonce);
  const res = await fetch(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: closeAction, nonce, signature }),
  });
  return res.json();
}
