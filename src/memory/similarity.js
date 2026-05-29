import { getSimilarTrades } from './tradeDB.js';

export function findSimilarTrades(currentContext) {
  const conditions = {
    session: currentContext.session?.current,
    direction: currentContext.proposedDirection,
    tier: currentContext.threeLayer?.tier,
    confluence: currentContext.confluenceCount,
    atr: currentContext.m15?.indicators?.atr,
    h4Bias: currentContext.h4?.structure?.bias,
    m15Event: currentContext.m15?.structure?.lastEvent,
  };

  console.log('[rag] searching similar trades for:', conditions);
  const similar = getSimilarTrades(conditions, 10);
  console.log('[rag] found', similar.length, 'similar trades');

  return similar;
}

export function analyzeResults(trades) {
  if (!trades || trades.length === 0) {
    return {
      hasData: false,
      message: 'No historical data yet for this setup type.',
    };
  }

  const executedTrades = trades.filter(t => t.isExecuted === 1);
  const blockedSignals = trades.filter(t => t.isExecuted === 0);

  const execWins = executedTrades.filter(t => t.outcome === 'WIN').length;
  const execLosses = executedTrades.filter(t => t.outcome === 'LOSS').length;

  const wouldWins = blockedSignals.filter(t => t.wouldHaveOutcome === 'WIN').length;
  const wouldLosses = blockedSignals.filter(t => t.wouldHaveOutcome === 'LOSS').length;

  // For expectancy calc use executed trades only (real P&L data)
  const wins = executedTrades.filter(t => t.outcome === 'WIN');
  const total = execWins + execLosses;
  const winRate = total > 0 ? (execWins / total * 100).toFixed(0) : 0;
  const avgWinRR = wins.length > 0
    ? (wins.reduce((s, t) => s + (t.rr || 2), 0) / wins.length).toFixed(2)
    : 2;
  const avgNetPnl = executedTrades.length > 0
    ? (executedTrades.reduce((s, t) => s + (t.netPnl || 0), 0) / executedTrades.length).toFixed(3)
    : 0;
  const expectancy = total > 0
    ? ((execWins / total * parseFloat(avgWinRR)) - (execLosses / total * 1)).toFixed(3)
    : 0;

  const sessionWR = {};
  executedTrades.forEach(t => {
    if (!sessionWR[t.session]) sessionWR[t.session] = { w: 0, l: 0 };
    if (t.outcome === 'WIN') sessionWR[t.session].w++;
    if (t.outcome === 'LOSS') sessionWR[t.session].l++;
  });

  const blockReasons = {};
  blockedSignals.forEach(s => {
    if (s.blockReason) blockReasons[s.blockReason] = (blockReasons[s.blockReason] || 0) + 1;
  });

  return {
    hasData: true,
    total,
    wins: execWins,
    losses: execLosses,
    winRate: parseInt(winRate),
    avgWinRR: parseFloat(avgWinRR),
    avgNetPnl: parseFloat(avgNetPnl),
    expectancy: parseFloat(expectancy),
    isPositiveEV: parseFloat(expectancy) > 0,
    recommendation:
      parseFloat(expectancy) > 0.3 ? 'STRONG_TAKE' :
      parseFloat(expectancy) > 0 ? 'TAKE' :
      parseFloat(expectancy) > -0.3 ? 'REDUCE_RISK' : 'SKIP',
    sessionWR,
    mostRecentOutcome: executedTrades[0]?.outcome,
    blocked: {
      total: blockedSignals.length,
      wouldWins,
      wouldLosses,
      resolved: wouldWins + wouldLosses,
      wouldWinRate: (wouldWins + wouldLosses) > 0
        ? parseInt((wouldWins / (wouldWins + wouldLosses) * 100).toFixed(0))
        : null,
    },
    blockReasons,
  };
}
