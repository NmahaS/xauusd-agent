import { ethers } from 'ethers';
import { encode as msgpackEncode } from '@msgpack/msgpack';

const HL_BASE = 'https://api.hyperliquid.xyz';

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const wait = (i + 1) * 2000;
      console.warn(`[hl] rate limited (429) — waiting ${wait}ms before retry ${i + 1}/${maxRetries}`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    return res;
  }
  throw new Error('Hyperliquid rate limit — max retries exceeded');
}

let balanceCache = null;
let balanceCacheTime = 0;

// Strip trailing zeros to match Hyperliquid's internal normalization.
// "3270.00" → "3270", "4702.10" → "4702.1", "2344.35" → "2344.35"
function formatPrice(price) { return String(parseFloat(price.toFixed(2))); }
function formatSize(size, szDecimals = 4) { return String(parseFloat(size.toFixed(szDecimals))); }

function roundToTickSize(price, tickSize) {
  return Math.round(price / tickSize) * tickSize;
}

// Hyperliquid price precision (perps): at most 5 significant figures AND at most (6 - szDecimals)
// decimal places; integer prices are always valid. PAXG's meta exposes NO tickSize, so the old
// `tickSize || 1` fallback rounded every price (entry/SL/TP) to a whole dollar — which corrupted
// the SL distance, and therefore realized risk, by up to ~1pt. Round to the binding constraint
// instead. PAXG (szDecimals 3, ~$4000) → 1 decimal (e.g. 4068.3), matching how HL quotes it.
function roundHLPrice(price, szDecimals) {
  if (!isFinite(price) || price <= 0) return price;
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const sigFig = parseFloat(price.toPrecision(5));      // ≤ 5 significant figures
  const factor = Math.pow(10, maxDecimals);
  return Math.round(sigFig * factor) / factor;          // ≤ (6 - szDecimals) decimal places
}

async function getTickSize(assetIdx, meta) {
  const asset = meta.universe[assetIdx];
  const szDecimals = asset.szDecimals || 0;
  const tickSize = asset.tickSize || 1;
  return { tickSize: parseFloat(tickSize), szDecimals };
}

async function fetchMeta() {
  const res = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  return res.json();
}

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
  const meta = await fetchMeta();
  const idx = meta.universe.findIndex(a => a.name === coin);
  if (idx === -1) throw new Error(`${coin} not found on Hyperliquid`);
  return { idx, meta };
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

  // connectionId = keccak256(msgpack(action) || nonce_uint64_be || 0x00)
  const msgPackBytes = msgpackEncode(action);
  const data = new Uint8Array(msgPackBytes.length + 9);
  data.set(msgPackBytes);
  new DataView(data.buffer).setBigUint64(msgPackBytes.length, BigInt(nonce), false);
  data[msgPackBytes.length + 8] = 0; // no vault

  const phantomAgent = {
    source: 'a',
    connectionId: ethers.keccak256(data),
  };

  const signature = await wallet.signTypedData(domain, types, phantomAgent);
  return {
    r: '0x' + signature.slice(2, 66),
    s: '0x' + signature.slice(66, 130),
    v: parseInt(signature.slice(130, 132), 16),
  };
}

async function setLeverage(assetIdx, leverage, wallet) {
  const action = {
    type: 'updateLeverage',
    asset: assetIdx,
    isCross: true,
    leverage,
  };
  const nonce = Date.now();
  const signature = await signHLAction(wallet, action, nonce);
  const res = await fetchWithRetry(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const data = await res.json();
  console.log(`[hl] leverage set to ${leverage}x: ${data.status}`);
  return data;
}


async function verifyWallet() {
  const wallet = getWallet();
  const address = wallet.address.toLowerCase();
  console.log(`[hl] API wallet address: ${address}`);
  console.log(`[hl] Main wallet address: ${process.env.HL_WALLET_ADDRESS}`);

  try {
    const res = await fetchWithRetry(`${HL_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    });
    const data = await res.json();
    if (data.marginSummary) {
      console.log(`[hl] API wallet verified ✅`);
      return true;
    }

    // Check if registered as agent/builder for main wallet
    const agentRes = await fetchWithRetry(`${HL_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'isApprovedBuilder',
        user: process.env.HL_WALLET_ADDRESS,
        builder: address,
      }),
    });
    const agentData = await agentRes.json();
    console.log(`[hl] agent check:`, JSON.stringify(agentData));
  } catch (err) {
    console.warn(`[hl] wallet verification failed: ${err.message}`);
  }

  return false;
}

async function approveAPIWallet() {
  const apiAddr = getWallet().address;
  const mainAddr = process.env.HL_WALLET_ADDRESS;
  console.error('[hl] ❌ API WALLET NOT AUTHORIZED');
  console.error(`[hl] API wallet: ${apiAddr}`);
  console.error(`[hl] Main wallet: ${mainAddr}`);
  console.error('[hl] Fix: app.hyperliquid.xyz → Settings → API Wallets → Authorize');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text:
          `🔴 <b>API Wallet Not Authorized</b>\n\n` +
          `Go to app.hyperliquid.xyz\n` +
          `Settings → API Wallets → Authorize\n\n` +
          `API wallet to authorize:\n<code>${apiAddr}</code>\n\n` +
          `Sign with your main wallet:\n<code>${mainAddr}</code>`,
        parse_mode: 'HTML',
      }),
    }).catch(() => {});
  }
}

export async function placeHLOrder({ coin, direction, size, markPrice, plan, orderMode = 'taker', context, finalSL, finalTP }) {
  const stopLoss = finalSL ?? plan?.stopLoss?.price ?? null;

  const verified = await verifyWallet();
  if (!verified) {
    const apiAddr = getWallet().address;
    throw new Error(
      `API wallet not authorized on Hyperliquid. ` +
      `Fix: app.hyperliquid.xyz → Settings → API Wallets → Authorize. ` +
      `API wallet: ${apiAddr}`
    );
  }

  const wallet = getWallet();
  const { idx: assetIdx, meta } = await getAssetIndex(coin);
  const { tickSize, szDecimals } = await getTickSize(assetIdx, meta);

  await setLeverage(assetIdx, 5, wallet).catch(err =>
    console.warn(`[hl] leverage set failed (non-fatal): ${err.message}`)
  );
  console.log('[hl] leverage confirmed at 5x');

  const isBuy = direction === 'long';

  // Step 1: Entry order — maker (GTC at plan entry) or taker (GTC at current price)
  let orderPrice, tif;
  if (orderMode === 'maker') {
    const rawEntry = plan.entry?.price || markPrice;
    orderPrice = roundHLPrice(rawEntry, szDecimals);
    tif = 'Gtc';
    console.log(`[hl-exec] MAKER order @ $${orderPrice} (0.010% fee)`);
  } else {
    // GTC limit at the current price — rests on the book and waits for fill.
    // The next pipeline run keeps it (same direction) or cancels it (direction flip).
    orderPrice = roundHLPrice(markPrice, szDecimals);
    tif = 'Gtc';
    console.log(`[hl-exec] TAKER order (GTC @ current price $${orderPrice}) — resting, waits for fill`);
  }

  console.log(`[hl] tick size: ${tickSize} szDecimals: ${szDecimals}`);
  console.log(`[hl-exec] size=${size} markPrice=${markPrice} orderPrice=${orderPrice}`);
  console.log(`[hl-exec] SL=${stopLoss} TP=auto(${process.env.TARGET_RR || '2.0'}R)`);

  const entryNonce = Date.now();
  const orderAction = {
    type: 'order',
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: formatPrice(orderPrice),
      s: formatSize(size, szDecimals),
      r: false,
      t: { limit: { tif } },
    }],
    grouping: 'na',
  };

  const entrySignature = await signHLAction(wallet, orderAction, entryNonce);
  const res = await fetchWithRetry(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: orderAction, nonce: entryNonce, signature: entrySignature }),
  });

  const result = await res.json();
  console.log(`[hl-exec] order result:`, JSON.stringify(result));

  if (result.status !== 'ok') {
    const msg = JSON.stringify(result);
    if (msg.includes('does not exist') || msg.includes('User or API Wallet')) {
      await approveAPIWallet();
    }
    throw new Error(`Order failed: ${msg}`);
  }

  const entryStatus = result.response?.data?.statuses?.[0] ?? {};
  const restingOid = entryStatus?.resting?.oid;
  const filledData = entryStatus?.filled;

  let orderId, fillPrice, fillSize;

  if (orderMode === 'maker' && restingOid && !filledData) {
    console.log(`[hl-exec] maker order ${restingOid} resting — polling for fill`);

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⏳ <b>Maker order placed</b>\n` +
                `${direction.toUpperCase()} ${size} PAXG @ $${orderPrice}\n` +
                `Waiting for fill (max 30min)\n` +
                `Order: ${restingOid}`,
          parse_mode: 'HTML',
        }),
      }).catch(err => console.warn(`[hl-exec] maker Telegram notify failed: ${err.message}`));
    }

    let makerFilled = false;
    fillPrice = null;
    fillSize = null;
    orderId = restingOid;

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 60000));

      const ordersRes = await fetch(`${HL_BASE}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'openOrders', user: process.env.HL_WALLET_ADDRESS }),
      });
      const openOrders = await ordersRes.json();
      const stillOpen = Array.isArray(openOrders) && openOrders.find(o => o.oid === restingOid);

      if (!stillOpen) {
        const fillsRes = await fetch(`${HL_BASE}/info`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFills', user: process.env.HL_WALLET_ADDRESS }),
        });
        const fills = await fillsRes.json();
        const matchFill = Array.isArray(fills) && fills.find(f => f.oid === restingOid);

        if (matchFill) {
          makerFilled = true;
          fillPrice = parseFloat(matchFill.px);
          fillSize = parseFloat(matchFill.sz);
          console.log(`[hl-exec] maker FILLED @ $${fillPrice}`);
        } else {
          console.log(`[hl-exec] maker order gone but no fill — cancelled`);
        }
        break;
      }

      console.log(`[hl-exec] maker still waiting... ${attempt + 1}/30 min`);
    }

    if (!makerFilled) {
      console.log(`[hl-exec] maker timeout — cancelling order ${restingOid}`);
      const cancelAction = {
        type: 'cancel',
        cancels: [{ a: assetIdx, o: restingOid }],
      };
      const cancelNonce = Date.now();
      const cancelSig = await signHLAction(wallet, cancelAction, cancelNonce);
      await fetch(`${HL_BASE}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: cancelAction, nonce: cancelNonce, signature: cancelSig }),
      });

      console.log(`[hl-exec] falling back to taker order`);
      // Bug 3 fix: pass finalSL/finalTP so taker fallback uses ATR-based levels, not plan SL which may be null
      return await placeHLOrder({ coin, direction, size, markPrice, plan, orderMode: 'taker', context, finalSL, finalTP });
    }
  } else {
    orderId = filledData?.oid ?? restingOid ?? entryStatus?.cancelled?.oid ?? null;
    fillPrice = filledData?.avgPx ? parseFloat(filledData.avgPx) : markPrice;
    fillSize = filledData?.totalSz ? parseFloat(filledData.totalSz) : size;

    if (!filledData) {
      console.warn(`[hl-exec] entry GTC order resting (not filled yet) — SL/TP deferred until fill`);
      return { orderId, fillPrice, fillSize: 0, direction, slPlaced: false, tpCount: 0, coin, status: 'unfilled' };
    }
  }

  console.log(`[hl-exec] fill=$${fillPrice} fillSize=${fillSize} orderId=${orderId}`);

  // Step 2: Wait 1 second for position to register before reduce-only orders
  await new Promise(r => setTimeout(r, 1000));

  // Step 3: Place STOP LOSS first (full fill size, reduce-only, trigger order)
  let slPlaced = false;
  let actualSL = null;
  if (stopLoss != null) {
    if (finalSL != null) {
      actualSL = roundHLPrice(finalSL, szDecimals);
      console.log(`[hl-exec] ATR-based SL=${actualSL}`);
    } else {
      const slDistance = Math.abs(markPrice - stopLoss);
      actualSL = roundHLPrice(
        isBuy ? fillPrice - slDistance : fillPrice + slDistance,
        szDecimals
      );
      console.log(`[hl-exec] adjusted SL=${actualSL} (fill=${fillPrice} distance=${slDistance.toFixed(2)})`);
    }

    const slNonce = Date.now();
    const stopAction = {
      type: 'order',
      orders: [{
        a: assetIdx,
        b: !isBuy,
        p: formatPrice(actualSL),
        s: formatSize(fillSize, szDecimals),
        r: true,
        t: {
          trigger: {
            isMarket: true,
            triggerPx: formatPrice(actualSL),
            tpsl: 'sl',
          },
        },
      }],
      grouping: 'na',
    };

    const slSignature = await signHLAction(wallet, stopAction, slNonce);
    const slRes = await fetchWithRetry(`${HL_BASE}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: stopAction, nonce: slNonce, signature: slSignature }),
    });
    const slResult = await slRes.json();
    slPlaced = slResult.status === 'ok';
    if (slPlaced) {
      const slOid = slResult.response?.data?.statuses?.[0]?.resting?.oid ?? 'unknown';
      console.log(`[hl-exec] ✅ SL placed: order id ${slOid} @ ${actualSL}`);
    } else {
      console.warn(`[hl-exec] ❌ SL failed: ${JSON.stringify(slResult)}`);
    }
  }

  // Step 4: Place single TP — use finalTP if provided, otherwise compute from TARGET_RR
  let tpPlaced = false;
  let tpPricePlaced = null;
  let tpComputedPrice = null;
  if (finalTP != null) {
    tpComputedPrice = roundHLPrice(finalTP, szDecimals);
    console.log(`[hl-exec] single TP: $${tpComputedPrice} (ATR-based target)`);
  } else if (actualSL != null) {
    const targetRR = parseFloat(process.env.TARGET_RR || '2.0');
    const slDistFromFill = Math.abs(fillPrice - actualSL);
    const rawTPPrice = isBuy ? fillPrice + slDistFromFill * targetRR : fillPrice - slDistFromFill * targetRR;
    tpComputedPrice = roundHLPrice(rawTPPrice, szDecimals);
    console.log(`[hl-exec] single TP: $${tpComputedPrice} (${targetRR}R from entry)`);
  }

  if (tpComputedPrice != null) {
    const tpNonce = Date.now();
    const tpAction = {
      type: 'order',
      orders: [{
        a: assetIdx,
        b: !isBuy,
        p: formatPrice(tpComputedPrice),
        s: formatSize(fillSize, szDecimals),
        r: true,
        t: { limit: { tif: 'Gtc' } },
      }],
      grouping: 'na',
    };

    const tpSignature = await signHLAction(wallet, tpAction, tpNonce);
    const tpRes = await fetchWithRetry(`${HL_BASE}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: tpAction, nonce: tpNonce, signature: tpSignature }),
    });
    const tpResult = await tpRes.json();
    const tpStatus = tpResult.response?.data?.statuses?.[0];
    if (tpStatus?.resting) {
      console.log(`[hl-exec] ✅ TP placed at $${tpComputedPrice} id=${tpStatus.resting.oid}`);
      tpPlaced = true;
      tpPricePlaced = tpComputedPrice;
    } else {
      console.error(`[hl-exec] ❌ TP failed:`, JSON.stringify(tpStatus));
    }
  }

  // Step 5: Verify open orders after placement
  try {
    const verifyRes = await fetchWithRetry(`${HL_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'openOrders', user: process.env.HL_WALLET_ADDRESS }),
    });
    const openOrders = await verifyRes.json();
    const coinOrders = Array.isArray(openOrders) ? openOrders.filter(o => o.coin === coin) : [];
    console.log(`[hl-exec] open orders for ${coin}: ${coinOrders.length} (expected: 1 SL + 1 TP)`);
    coinOrders.forEach(o => console.log(`[hl-exec]   oid=${o.oid} side=${o.side} px=${o.limitPx} sz=${o.sz} type=${o.orderType}`));
  } catch (err) {
    console.warn(`[hl-exec] open orders verify failed (non-fatal): ${err.message}`);
  }

  return { orderId, fillPrice, fillSize, direction, slPlaced, tpPlaced, tpPrice: tpPricePlaced, coin, status: 'placed' };
}

export async function getHLPrice(coin = 'PAXG') {
  const res = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (!res.ok) throw new Error(`Hyperliquid price HTTP ${res.status}`);
  const [meta, ctxs] = await res.json();
  const idx = meta.universe.findIndex(a => a.name === coin);
  if (idx === -1) throw new Error(`${coin} not found on Hyperliquid`);
  return {
    markPrice:   parseFloat(ctxs[idx].markPx),
    oraclePrice: parseFloat(ctxs[idx].oraclePx),
    funding:     parseFloat(ctxs[idx].funding),
  };
}

export async function getHLBalance() {
  const now = Date.now();
  if (balanceCache && (now - balanceCacheTime) < 60000) {
    console.log('[hl] using cached balance');
    return balanceCache;
  }

  const address = process.env.HL_WALLET_ADDRESS;
  if (!address) throw new Error('HL_WALLET_ADDRESS not set — add your main Hyperliquid wallet address to env vars');

  const res = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid balance HTTP ${res.status}`);

  const data = await res.json();
  const balance = parseFloat(data.marginSummary?.accountValue ?? 0);
  const available = parseFloat(data.withdrawable ?? 0); // top-level field per HL API
  const unrealizedPnl = parseFloat(
    data.marginSummary?.totalUnrealizedPnl ?? data.marginSummary?.totalNtlPos ?? 0
  );
  // equity = balance (marginSummary.accountValue is the real USDC value;
  // crossMarginSummary.accountValue inflates with leveraged position notional)
  const equity = balance;

  console.log(`[hl] account value: $${balance.toFixed(2)}`);
  console.log(`[hl] available: $${available.toFixed(2)}`);
  console.log(`[hl] unrealized pnl: $${unrealizedPnl.toFixed(2)}`);

  balanceCache = { balance, available, unrealizedPnl, equity };
  balanceCacheTime = now;
  return balanceCache;
}

export async function getHLPositions() {
  const address = process.env.HL_WALLET_ADDRESS;
  if (!address) throw new Error('HL_WALLET_ADDRESS not set');

  const res = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid positions HTTP ${res.status}`);

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
      liquidationPrice: parseFloat(p.position.liquidationPx ?? 0),
    }));
}

function mapFill(f) {
  return {
    orderId: f.oid,
    coin: f.coin,
    direction: f.dir.includes('Long') ? 'long' : 'short',
    description: f.dir,
    isOpen: f.dir.startsWith('Open'),
    isClose: f.dir.startsWith('Close') || f.dir.includes('>'),
    size: parseFloat(f.sz),
    price: parseFloat(f.px),
    fee: parseFloat(f.fee || 0),
    time: new Date(f.time).toISOString(),
    closedPnl: parseFloat(f.closedPnl || 0),
    startPosition: parseFloat(f.startPosition),  // signed position size BEFORE this fill (0 = was flat)
  };
}

export async function getHLTradeHistory(coin = 'PAXG') {
  const address = process.env.HL_WALLET_ADDRESS;
  if (!address) throw new Error('HL_WALLET_ADDRESS not set');

  const res = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid fills HTTP ${res.status}`);
  const fills = await res.json();
  if (!Array.isArray(fills)) throw new Error('Invalid fills response');

  const today = new Date().toISOString().slice(0, 10);
  const todayFills = fills
    .filter(f => f.coin === coin && new Date(f.time).toISOString().slice(0, 10) === today)
    .sort((a, b) => a.time - b.time)
    .map(mapFill);

  console.log(`[hl] today fills for ${coin}: ${todayFills.length}`);
  return todayFills;
}

export async function getHLFillsHistory(coin = 'PAXG', days = 7) {
  const address = process.env.HL_WALLET_ADDRESS;
  if (!address) throw new Error('HL_WALLET_ADDRESS not set');

  const res = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid fills HTTP ${res.status}`);
  const fills = await res.json();
  if (!Array.isArray(fills)) return [];

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return fills
    .filter(f => f.coin === coin && f.time > cutoff)
    .sort((a, b) => a.time - b.time)
    .map(mapFill);
}

// Returns ALL fills for an address with no date filter.
// Callers filter by date range on their side.
export async function getHLAllFills(coin = 'PAXG') {
  const address = process.env.HL_WALLET_ADDRESS;
  if (!address) throw new Error('HL_WALLET_ADDRESS not set');

  const res = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid fills HTTP ${res.status}`);
  const fills = await res.json();
  if (!Array.isArray(fills)) return [];

  const result = fills
    .filter(f => !coin || f.coin === coin)
    .sort((a, b) => a.time - b.time)
    .map(mapFill);

  console.log(`[hl] all fills for ${coin}: ${result.length}`);
  return result;
}

// Closed-position history for the dashboard. Segments fills into positions using HL's
// `startPosition` (signed size BEFORE each fill) and the API's NATIVE order (newest-first →
// reversed to chronological). Native order is authoritative: time-sorting scrambles same-timestamp
// fills and corrupts the startPosition chain (154 chain breaks vs 1 truncation-edge break observed).
// A position spans from a fill where the book was flat (startPosition ≈ 0) until it returns to flat.
// The still-open position (last segment with net ≠ 0) is excluded — it's shown in the live panel.
export async function getClosedPositions(coin = 'PAXG', limit = 6) {
  const address = process.env.HL_WALLET_ADDRESS;
  if (!address) throw new Error('HL_WALLET_ADDRESS not set');

  const res = await fetch(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid fills HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) return [];

  // Native API order is newest-first; reverse to chronological. Do NOT sort by time.
  const chrono = raw.filter(f => f.coin === coin).reverse();

  // Group into position segments: a fill with startPosition ≈ 0 begins a new position.
  const segments = [];
  let seg = null;
  for (const f of chrono) {
    if (Math.abs(parseFloat(f.startPosition)) < 1e-9) {
      if (seg) segments.push(seg);
      seg = [];
    }
    if (!seg) seg = [];   // history truncated mid-position — start collecting anyway
    seg.push(f);
  }
  if (seg) segments.push(seg);

  const summarize = (s) => {
    const opens  = s.filter(f => f.dir.startsWith('Open'));
    const closes = s.filter(f => !f.dir.startsWith('Open'));   // Close / flip reductions
    const totalOpened = opens.reduce((a, f) => a + parseFloat(f.sz), 0);
    const totalClosed = closes.reduce((a, f) => a + parseFloat(f.sz), 0);
    const avgEntry = totalOpened > 0
      ? opens.reduce((a, f) => a + parseFloat(f.sz) * parseFloat(f.px), 0) / totalOpened
      : 0;
    return {
      direction:   opens[0] ? (opens[0].dir.includes('Long') ? 'long' : 'short') : 'short',
      compounds:   Math.max(0, opens.length - 1),
      avgEntry:    parseFloat(avgEntry.toFixed(2)),
      size:        parseFloat(totalOpened.toFixed(4)),
      realizedPnl: parseFloat(s.reduce((a, f) => a + parseFloat(f.closedPnl || 0), 0).toFixed(2)),
      fees:        parseFloat(s.reduce((a, f) => a + parseFloat(f.fee || 0), 0).toFixed(2)),
      openTime:    opens[0] ? new Date(opens[0].time).toISOString() : null,
      closeTime:   closes.length ? new Date(closes[closes.length - 1].time).toISOString() : null,
      net:         totalOpened - totalClosed,   // ≈0 ⇒ fully closed; >0 ⇒ still open
    };
  };

  const closed = segments
    .map(summarize)
    .filter(p => p.compounds >= 0 && Math.abs(p.net) < 1e-6 && p.size > 0)  // fully closed only
    .reverse()           // most recent first
    .slice(0, limit)
    .map(({ net, ...rest }) => ({ ...rest, won: rest.realizedPnl >= 0 }));

  console.log(`[hl] closed positions for ${coin}: ${closed.length}`);
  return closed;
}

export async function getSpotBalance() {
  const address = process.env.HL_WALLET_ADDRESS;
  if (!address) throw new Error('HL_WALLET_ADDRESS not set');

  const res = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotClearinghouseState', user: address }),
  });
  if (!res.ok) throw new Error(`Hyperliquid spot balance HTTP ${res.status}`);

  const data = await res.json();
  const usdc = (data.balances || []).find(b => b.coin === 'USDC');
  const total = parseFloat(usdc?.total || 0);
  console.log(`[hl] spot USDC: $${total.toFixed(2)}`);
  return total;
}

export async function transferSpotToPerp(amountUSD) {
  const wallet = getWallet();

  console.log(`[hl] transferring $${amountUSD} from spot to perp...`);

  // Verify spot balance first
  const spotUSDC = await getSpotBalance();
  if (spotUSDC < amountUSD) {
    throw new Error(
      `Insufficient spot balance: $${spotUSDC.toFixed(2)} < $${amountUSD} needed`
    );
  }

  const action = {
    type: 'usdClassTransfer',
    amount: String(amountUSD.toFixed(2)),
    toPerp: true,
  };

  const nonce = Date.now();
  const signature = await signHLAction(wallet, action, nonce);

  const res = await fetchWithRetry(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  if (!res.ok) throw new Error(`Transfer HTTP ${res.status}`);

  const result = await res.json();
  console.log(`[hl] transfer result:`, JSON.stringify(result));

  if (result.status !== 'ok') {
    throw new Error(`Transfer failed: ${JSON.stringify(result)}`);
  }

  // Bust balance cache so next getHLBalance() reflects new perp balance
  balanceCache = null;
  balanceCacheTime = 0;

  console.log(`[hl] ✅ transferred $${amountUSD} spot → perp`);
  return result;
}

export async function cancelExistingSL(coin) {
  try {
    // frontendOpenOrders — plain openOrders omits orderType/isTrigger, so its SL filter
    // matched nothing and let duplicate stops accumulate.
    const res = await fetch(`${HL_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'frontendOpenOrders', user: process.env.HL_WALLET_ADDRESS }),
    });
    const orders = await res.json();
    if (!Array.isArray(orders)) return;

    const slOrders = orders.filter(o =>
      o.coin === coin &&
      o.reduceOnly === true &&
      (o.orderType === 'Stop Market' || o.orderType === 'Stop Limit' || o.isTrigger === true)
    );
    console.log(`[hl-exec] found ${slOrders.length} existing SL orders to cancel`);

    const { idx: assetIdx } = await getAssetIndex(coin);
    const wallet = getWallet();
    for (const slOrder of slOrders) {
      const cancelAction = { type: 'cancel', cancels: [{ a: assetIdx, o: slOrder.oid }] };
      const nonce = Date.now();
      const sig = await signHLAction(wallet, cancelAction, nonce);
      await fetch(`${HL_BASE}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: cancelAction, nonce, signature: sig }),
      });
      console.log(`[hl] cancelled SL order ${slOrder.oid}`);

      // Wait and verify it's actually gone
      await new Promise(r => setTimeout(r, 1000));
      const checkRes = await fetch(`${HL_BASE}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'openOrders', user: process.env.HL_WALLET_ADDRESS }),
      });
      const remainingOrders = await checkRes.json();
      const stillExists = Array.isArray(remainingOrders) &&
        remainingOrders.find(o => o.oid === slOrder.oid);

      if (stillExists) {
        console.warn(`[hl] SL ${slOrder.oid} still exists — retrying cancel`);
        const nonce2 = Date.now();
        const sig2 = await signHLAction(wallet, cancelAction, nonce2);
        await fetch(`${HL_BASE}/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: cancelAction, nonce: nonce2, signature: sig2 }),
        });
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`[hl] SL ${slOrder.oid} confirmed cancelled ✅`);
      }
    }
  } catch (err) {
    console.warn('[hl-exec] cancelExistingSL failed:', err.message);
  }
}

export async function cancelExistingTP(coin) {
  try {
    // frontendOpenOrders — plain openOrders omits orderType, so this filter matched nothing.
    const res = await fetch(`${HL_BASE}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'frontendOpenOrders', user: process.env.HL_WALLET_ADDRESS }),
    });
    const orders = await res.json();
    if (!Array.isArray(orders)) return;

    const tpOrders = orders.filter(o =>
      o.coin === coin &&
      o.reduceOnly === true &&
      o.orderType === 'Limit' &&
      o.isTrigger !== true
    );
    console.log(`[hl-exec] found ${tpOrders.length} existing TP orders to cancel`);

    const { idx: assetIdx } = await getAssetIndex(coin);
    const wallet = getWallet();
    for (const tpOrder of tpOrders) {
      const cancelAction = { type: 'cancel', cancels: [{ a: assetIdx, o: tpOrder.oid }] };
      const nonce = Date.now();
      const sig = await signHLAction(wallet, cancelAction, nonce);
      await fetch(`${HL_BASE}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: cancelAction, nonce, signature: sig }),
      });
      console.log(`[hl-exec] cancelled old TP order ${tpOrder.oid}`);
    }
  } catch (err) {
    console.warn('[hl-exec] cancelExistingTP failed:', err.message);
  }
}

// Returns all open (resting) orders for the main wallet, normalized.
export async function getOpenOrders() {
  const res = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'openOrders',
      user: process.env.HL_WALLET_ADDRESS,
    }),
  });
  const orders = await res.json();
  return Array.isArray(orders) ? orders.map(o => ({
    oid: o.oid,
    coin: o.coin,
    side: o.side,
    limitPx: parseFloat(o.limitPx),
    sz: parseFloat(o.sz),
    reduceOnly: o.reduceOnly,
    orderType: o.orderType,
  })) : [];
}

// Rich open-order info via frontendOpenOrders — the plain `openOrders` endpoint omits
// orderType/isTrigger/triggerCondition, so only this endpoint can distinguish SL vs TP.
export async function getOpenOrdersDetailed() {
  const res = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'frontendOpenOrders',
      user: process.env.HL_WALLET_ADDRESS,
    }),
  });
  const orders = await res.json();
  return Array.isArray(orders) ? orders.map(o => ({
    oid: o.oid,
    coin: o.coin,
    side: o.side,
    limitPx: parseFloat(o.limitPx),
    sz: parseFloat(o.sz),
    reduceOnly: o.reduceOnly,
    orderType: o.orderType,
    isTrigger: o.isTrigger,
    triggerPx: o.triggerPx != null ? parseFloat(o.triggerPx) : null,
  })) : [];
}

// Cancels a single resting order by oid.
export async function cancelOrder(coin, oid) {
  const { idx: assetIdx } = await getAssetIndex(coin);
  const wallet = getWallet();
  const cancelAction = {
    type: 'cancel',
    cancels: [{ a: assetIdx, o: oid }],
  };
  const nonce = Date.now();
  const sig = await signHLAction(wallet, cancelAction, nonce);
  const res = await fetchWithRetry(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: cancelAction, nonce, signature: sig }),
  });
  const data = await res.json();
  console.log('[hl] cancelled order', oid, ':',
    JSON.stringify(data?.response?.data?.statuses?.[0]));
  return data;
}

export async function placeSL({ coin, direction, size, slPrice }) {
  console.log(`[hl-exec] placing SL: ${direction} ${size} ${coin} @ $${slPrice.toFixed(2)}`);
  const wallet = getWallet();
  const { idx: assetIdx, meta } = await getAssetIndex(coin);
  const { tickSize, szDecimals } = await getTickSize(assetIdx, meta);
  const isBuy = direction === 'long';
  const roundedSL = roundHLPrice(slPrice, szDecimals);

  const nonce = Date.now();
  const stopAction = {
    type: 'order',
    orders: [{
      a: assetIdx,
      b: !isBuy,
      p: formatPrice(roundedSL),
      s: formatSize(size, szDecimals),
      r: true,
      t: { trigger: { isMarket: true, triggerPx: formatPrice(roundedSL), tpsl: 'sl' } },
    }],
    grouping: 'na',
  };
  const sig = await signHLAction(wallet, stopAction, nonce);
  const res = await fetchWithRetry(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: stopAction, nonce, signature: sig }),
  });
  const result = await res.json();
  const placed = result.status === 'ok';
  if (placed) {
    const oid = result.response?.data?.statuses?.[0]?.resting?.oid ?? 'unknown';
    console.log(`[hl-exec] ✅ SL placed: order id ${oid} @ ${roundedSL}`);
  } else {
    console.warn(`[hl-exec] ❌ SL failed: ${JSON.stringify(result)}`);
  }
  return placed;
}

export async function placeTP({ coin, direction, size, tpPrice }) {
  console.log(`[hl-exec] placing TP: ${direction} ${size} ${coin} @ $${tpPrice.toFixed(2)}`);
  const wallet = getWallet();
  const { idx: assetIdx, meta } = await getAssetIndex(coin);
  const { tickSize, szDecimals } = await getTickSize(assetIdx, meta);
  const isBuy = direction === 'long';
  const roundedTP = roundHLPrice(tpPrice, szDecimals);

  const nonce = Date.now();
  const tpAction = {
    type: 'order',
    orders: [{
      a: assetIdx,
      b: !isBuy,
      p: formatPrice(roundedTP),
      s: formatSize(size, szDecimals),
      r: true,
      t: { limit: { tif: 'Gtc' } },
    }],
    grouping: 'na',
  };
  const sig = await signHLAction(wallet, tpAction, nonce);
  const res = await fetchWithRetry(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: tpAction, nonce, signature: sig }),
  });
  const result = await res.json();
  const status = result.response?.data?.statuses?.[0];
  const placed = !!status?.resting;
  if (placed) {
    console.log(`[hl-exec] ✅ TP placed at $${roundedTP} id=${status.resting.oid}`);
  } else {
    console.error(`[hl-exec] ❌ TP failed:`, JSON.stringify(status));
  }
  return placed;
}

// Closes an open position using a reduce-only market order.
export async function closeHLPosition(coin, direction, size) {
  const wallet = getWallet();
  const { idx: assetIdx } = await getAssetIndex(coin);
  const isBuy = direction === 'short'; // opposite to close
  const nonce = Date.now();

  const markRes = await fetchWithRetry(`${HL_BASE}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const [meta2, assetCtxs] = await markRes.json();
  const idx2 = meta2.universe.findIndex(a => a.name === coin);
  const markPrice = parseFloat(assetCtxs[idx2]?.markPx ?? 0);
  const { tickSize, szDecimals } = await getTickSize(idx2, meta2);
  const rawClose = isBuy ? markPrice * 1.005 : markPrice * 0.995;
  const closePrice = roundHLPrice(rawClose, szDecimals);

  // GTC limit priced 0.5% through the market — crosses and fills immediately as a
  // reduce-only taker close; any tiny remainder rests reduce-only rather than being killed.
  const closeAction = {
    type: 'order',
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: formatPrice(closePrice),
      s: formatSize(size, szDecimals),
      r: true,
      t: { limit: { tif: 'Gtc' } },
    }],
    grouping: 'na',
  };

  const signature = await signHLAction(wallet, closeAction, nonce);
  const res = await fetchWithRetry(`${HL_BASE}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: closeAction, nonce, signature }),
  });
  return res.json();
}
