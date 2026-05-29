import { findSimilarTrades, analyzeResults } from './similarity.js';

export async function buildHistoricalContext(currentContext) {
  try {
    const similar = findSimilarTrades(currentContext);
    const analysis = analyzeResults(similar);

    if (!analysis.hasData) {
      return {
        contextString: '⚠️ No historical data yet for similar setups. Rely on technical analysis only.',
        analysis,
        similar,
      };
    }

    const { winRate, total, wins, losses, avgWinRR,
            expectancy, recommendation, blocked, blockReasons } = analysis;

    const evEmoji = expectancy > 0 ? '✅' : '❌';
    const recText = {
      STRONG_TAKE: 'STRONG TAKE — historically excellent setup',
      TAKE: 'TAKE — historically positive EV',
      REDUCE_RISK: 'REDUCE RISK — marginal historical performance',
      SKIP: 'SKIP — historically negative EV on similar setups',
    }[recommendation];

    let ctx = `\n═══ HISTORICAL PERFORMANCE DATA ═══\n`;

    if (total > 0) {
      ctx += `Executed trades (${total}): ${winRate}% WR (${wins}W / ${losses}L)\n`;
      ctx += `Avg win: +${avgWinRR}R\n`;
      ctx += `Expectancy: ${evEmoji} ${expectancy}R per trade\n`;
      ctx += `\nRecommendation: ${recText}\n`;
    }

    // Blocked signal analysis
    if (blocked?.resolved > 0) {
      const wwr = blocked.wouldWinRate;
      ctx += `\nBlocked signals (${blocked.resolved} resolved): ${wwr}% would have won\n`;
      if (blocked.wouldWins > blocked.wouldLosses) {
        ctx += `⚠️ Similar setups were CORRECTLY BLOCKED (${wwr}% win rate — blocks protect you)\n`;
      } else {
        ctx += `💡 Similar blocks were MISSED OPPORTUNITIES (${wwr}% win rate — consider being less restrictive)\n`;
      }
    }

    // Session-specific win rate
    const session = currentContext.session?.current;
    if (session && analysis.sessionWR[session]) {
      const sd = analysis.sessionWR[session];
      const sTotal = sd.w + sd.l;
      const sWR = (sd.w / sTotal * 100).toFixed(0);
      ctx += `\n${session} session: ${sWR}% WR (${sd.w}W/${sd.l}L)\n`;
    }

    // Block reason summary
    if (blockReasons && Object.keys(blockReasons).length > 0) {
      ctx += `\nMost common block reasons:\n`;
      Object.entries(blockReasons)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .forEach(([reason, count]) => { ctx += `  ${reason}: ${count}x\n`; });
    }

    // Recent loss streak warning (executed trades only)
    const recentExec = similar.filter(t => t.isExecuted === 1).slice(0, 3);
    if (recentExec.length === 3 && recentExec.every(t => t.outcome === 'LOSS')) {
      ctx += `\n⚠️ WARNING: Last 3 similar executed setups ALL lost — extra caution\n`;
    }

    ctx += `═══════════════════════════════════\n`;

    console.log('[rag] historical context built:', {
      total, winRate, expectancy, recommendation,
      blockedResolved: blocked?.resolved ?? 0,
    });

    return { contextString: ctx, analysis, similar };

  } catch (err) {
    console.warn('[rag] failed to build context:', err.message);
    return {
      contextString: '',
      analysis: { hasData: false },
      similar: [],
    };
  }
}
