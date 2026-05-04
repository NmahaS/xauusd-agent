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
