async function testClaudeAPI() {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (res.ok) {
      console.log('[startup] Claude API: ✅ working');
    } else {
      const err = await res.text();
      console.error('[startup] Claude API: ❌ failed —', err.slice(0, 100));
      console.error('[startup] ANTHROPIC_API_KEY length:', (process.env.ANTHROPIC_API_KEY || '').length);
    }
  } catch (err) {
    console.error('[startup] Claude API: ❌ error —', err.message);
  }
}

async function testGitSync() {
  try {
    const { syncFileToGithub } = await import('./utils/gitSync.js');
    await syncFileToGithub('cache/.sync-test', JSON.stringify({ ts: new Date().toISOString() }));
    console.log('[startup] git-sync: ✅ working');
  } catch (err) {
    console.warn('[startup] git-sync: ❌ failed —', err.message);
    console.warn('[startup] plans will save locally only until token is fixed');
  }
}

async function startup() {
  console.log('=== XAUUSD Agent starting ===');
  console.log('[startup] cwd:', process.cwd());
  console.log('[startup] plans dir:', process.cwd() + '/plans');

  await testClaudeAPI();

  try {
    const { ethers } = await import('ethers');
    let pk = process.env.HL_PRIVATE_KEY || '';
    if (!pk.startsWith('0x')) pk = '0x' + pk;
    const wallet = new ethers.Wallet(pk);
    console.log(`[startup] HL API wallet: ${wallet.address}`);
    console.log(`[startup] HL main wallet: ${process.env.HL_WALLET_ADDRESS}`);
    console.log(`[startup] Make sure API wallet is authorized at app.hyperliquid.xyz`);
  } catch (err) {
    console.error(`[startup] HL wallet error: ${err.message}`);
  }

  await testGitSync();

  const { isCacheReady, getCacheStats } = await import('./data/candleCache.js');
  const goldEpic = 'MT.D.GC.FWS2.IP';
  const cacheReady = isCacheReady(goldEpic, 'HOUR');

  if (!cacheReady) {
    console.log('[startup] cache empty — cold start will happen on next pipeline run');
  } else {
    const stats = getCacheStats();
    console.log('[startup] cache ready:');
    stats.forEach(s => console.log(`  ${s.epic} ${s.resolution}: ${s.count} candles (${s.ageMinutes}m old)`));
  }

  await import('./cron.js');
  await import('./server.js');
}

startup().catch(console.error);
