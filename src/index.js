async function startup() {
  console.log('=== XAUUSD Agent starting ===');

  const { isCacheReady, getCacheStats } = await import('./data/candleCache.js');
  const goldEpic = 'MT.D.GC.FWS2.IP';
  const cacheReady = isCacheReady(goldEpic, 'HOUR', 50);

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
