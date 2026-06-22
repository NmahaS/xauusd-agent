// Weekly profit-goal tracker. Filters this week's HL fills (Mon 00:00 UTC → now),
// computes net P&L vs a dynamic goal (WEEKLY_GOAL_PCT of the live balance, default
// 5%), and renders progress to Telegram. Informational only — never gates execution.

import { getHLBalance } from '../broker/hyperliquid.js';
import { getWeeklyPnl, getPreviousWeekPnl } from '../utils/weeklyPnl.js';

export async function checkWeeklyGoal() {
  const goalTargetPct = parseFloat(process.env.WEEKLY_GOAL_PCT || '5.0');
  const rewardUSD = parseFloat(process.env.WEEKLY_GOAL_REWARD || '100');
  const coin = process.env.HL_COIN || 'PAXG';

  // Shared single-source-of-truth weekly realized P&L (Monday 00:00 UTC → now)
  const [week, balance] = await Promise.all([
    getWeeklyPnl(coin),
    getHLBalance(),
  ]);

  // Dynamic goal: WEEKLY_GOAL_PCT of the live balance (default 5%), so the target
  // scales as the account compounds instead of a fixed dollar figure.
  const goalUSD = balance.balance * (goalTargetPct / 100);
  console.log('[goal] ' + goalTargetPct + '% of $' + balance.balance.toFixed(2) +
    ' = $' + goalUSD.toFixed(2) + ' weekly target');

  const netPnl = week.net;
  const grossPnl = week.gross;
  const totalFees = week.fees;

  const wins = week.wins;
  const losses = week.losses;
  const winRate = week.trades > 0
    ? ((wins / week.trades) * 100).toFixed(1)
    : '0.0';

  const goalPctRaw = (netPnl / goalUSD) * 100;
  const goalPct = Number.isFinite(goalPctRaw) ? Math.round(goalPctRaw) : 0;
  const remaining = parseFloat(Math.max(goalUSD - netPnl, 0).toFixed(2));
  const goalHit = netPnl >= goalUSD;

  console.log(`[goal] week PnL: $${netPnl.toFixed(2)} / $${goalUSD.toFixed(2)} goal (${goalPct}%)`);

  return {
    netPnl,
    grossPnl,
    totalFees,
    goalUSD,
    goalTargetPct,
    rewardUSD,
    goalHit,
    goalPct,
    remaining,
    wins,
    losses,
    winRate,
    trades: week.trades,
    weekStart: week.weekStart,
    balance: balance.balance,
  };
}

// Measures the PREVIOUS week (last Mon 00:00 → this Mon 00:00 UTC). Used by the
// Monday 00:00 auto-transfer, since the current week resets to $0 at that moment.
export async function checkPreviousWeekGoal() {
  const goalTargetPct = parseFloat(process.env.WEEKLY_GOAL_PCT || '5.0');
  const rewardUSD = parseFloat(process.env.WEEKLY_GOAL_REWARD || '100');
  const coin = process.env.HL_COIN || 'PAXG';

  // Shared single-source-of-truth previous-week realized P&L
  const [prev, balance] = await Promise.all([
    getPreviousWeekPnl(coin),
    getHLBalance(),
  ]);

  // Dynamic goal: WEEKLY_GOAL_PCT of the live balance (default 5%).
  const goalUSD = balance.balance * (goalTargetPct / 100);
  console.log('[goal] ' + goalTargetPct + '% of $' + balance.balance.toFixed(2) +
    ' = $' + goalUSD.toFixed(2) +
    ` (PREVIOUS week ${prev.weekRange}: net $${prev.net.toFixed(2)})`);

  return {
    netPnl: prev.net,
    grossPnl: prev.gross,
    totalFees: prev.fees,
    goalUSD,
    goalTargetPct,
    rewardUSD,
    goalHit: prev.net >= goalUSD,
    wins: prev.wins,
    losses: prev.losses,
    trades: prev.trades,
    weekRange: prev.weekRange,
  };
}

// Monday 00:00 UTC auto-transfer — the ONLY place a spot→perp transfer happens.
// Decides off LAST week's final result (this week is $0 at this moment).
export async function runMondayAutoTransfer() {
  const { sendTelegramMessage } = await import('../telegram/notify.js');
  const data = await checkPreviousWeekGoal();

  if (!data.goalHit) {
    const msg = '📅 <b>Monday — New Trading Week</b>\n\n' +
      '❌ Last week missed goal: $' + data.netPnl.toFixed(2) +
      ' / ' + data.goalTargetPct + '% ($' + data.goalUSD.toFixed(2) + ')\n' +
      'No auto-transfer this week.\n\n' +
      'Week stats: ' + data.trades + ' trades, ' +
      data.wins + 'W ' + data.losses + 'L';
    await sendTelegramMessage(msg);
    console.log('[goal] Monday: last week missed goal, no transfer');
    return { ...data, transferred: false };
  }

  // Goal hit last week — attempt transfer
  const rewardUSD = data.rewardUSD;
  let transferResult = null;
  let transferError = null;

  try {
    const { transferSpotToPerp, getSpotBalance, getHLBalance } =
      await import('../broker/hyperliquid.js');

    const spotBalance = await getSpotBalance();

    if (spotBalance >= rewardUSD) {
      await transferSpotToPerp(rewardUSD);
      const newBalance = await getHLBalance();
      transferResult = newBalance.balance;
      console.log('[goal] ✅ Monday auto-transfer: $' + rewardUSD + ' spot → perp');
    } else {
      transferError = 'Spot balance too low: $' + spotBalance.toFixed(2) +
        ' < $' + rewardUSD + ' needed';
      console.warn('[goal] ⚠️ Monday transfer skipped:', transferError);
    }
  } catch (err) {
    transferError = err.message;
    console.error('[goal] Monday transfer failed:', err.message);
  }

  let msg = '📅 <b>Monday — New Trading Week</b>\n\n';
  msg += '🎯 <b>LAST WEEK GOAL HIT!</b>\n';
  msg += '✅ Net P&amp;L: +$' + data.netPnl.toFixed(2) +
    ' (goal: ' + data.goalTargetPct + '% — $' + data.goalUSD.toFixed(2) + ')\n';
  msg += '📊 ' + data.trades + ' trades, ' + data.wins + 'W ' + data.losses + 'L\n\n';

  if (transferResult != null) {
    msg += '🚀 <b>AUTO-DEPOSIT COMPLETE!</b>\n';
    msg += '$' + rewardUSD + ' transferred spot → perp\n';
    msg += 'New balance: $' + transferResult.toFixed(2) + ' USDC\n';
    msg += 'New 1% risk: $' + (transferResult * 0.01).toFixed(2) + '/trade\n\n';
    msg += 'Trading resumes with larger size 🎉';
  } else {
    msg += '⚠️ <b>Auto-transfer skipped:</b>\n';
    msg += transferError + '\n\n';
    msg += 'Keep $' + rewardUSD + '+ in spot for auto-transfer.\n';
    msg += 'Or transfer manually + send /deposited';
  }

  await sendTelegramMessage(msg);
  return { ...data, transferResult, transferError, transferred: transferResult != null };
}

export async function sendWeeklyGoalUpdate(allowTransfer = false) {
  const { sendTelegramMessage } = await import('../telegram/notify.js');
  const data = await checkWeeklyGoal();

  const progressBar = () => {
    const clamped = Math.max(0, Math.min(data.goalPct, 100));
    const filled = Math.floor(clamped / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  let msg = '';

  if (data.goalHit && allowTransfer) {
    const rewardUSD = data.rewardUSD;
    let transferResult = null;
    let transferError = null;

    try {
      const { transferSpotToPerp, getSpotBalance, getHLBalance } =
        await import('../broker/hyperliquid.js');

      const spotBalance = await getSpotBalance();

      if (spotBalance >= rewardUSD) {
        await transferSpotToPerp(rewardUSD);
        const newBalance = await getHLBalance();
        transferResult = newBalance.balance;
        console.log(`[goal] ✅ auto-transferred $${rewardUSD} spot → perp`);
      } else {
        transferError = `Spot balance too low: $${spotBalance.toFixed(2)} < $${rewardUSD} needed`;
        console.warn(`[goal] ⚠️ cannot auto-transfer: ${transferError}`);
      }
    } catch (err) {
      transferError = err.message;
      console.error(`[goal] transfer failed:`, err.message);
    }

    msg = `🎯 <b>WEEKLY GOAL HIT!</b>\n\n`;
    msg += `✅ Net P&amp;L: +$${data.netPnl.toFixed(2)} (goal: ${data.goalTargetPct}% — $${data.goalUSD.toFixed(2)})\n`;
    msg += `💰 Balance before: $${data.balance.toFixed(2)}\n\n`;

    if (transferResult != null) {
      msg += `🚀 <b>AUTO-DEPOSIT COMPLETE!</b>\n`;
      msg += `$${rewardUSD} transferred from spot → perp\n`;
      msg += `New balance: $${transferResult.toFixed(2)} USDC\n`;
      msg += `New 1% risk: $${(transferResult * 0.01).toFixed(2)}/trade\n\n`;
      msg += `Agent automatically updated — trading resumes\n`;
      msg += `with larger position sizes next signal 🎉\n`;
    } else {
      msg += `⚠️ <b>Auto-transfer failed:</b>\n`;
      msg += `${transferError}\n\n`;
      msg += `<b>Manual deposit steps:</b>\n`;
      msg += `1. Add USDC to spot: app.hyperliquid.xyz\n`;
      msg += `2. Transfer $${rewardUSD} spot → perp\n`;
      msg += `3. Send /deposited when done\n\n`;
      msg += `<b>To enable auto-transfer:</b>\n`;
      msg += `Keep $${rewardUSD}+ USDC in your spot account\n`;
    }

    msg += `\n<b>📊 Week stats:</b>\n`;
    msg += `Trades: ${data.trades} | ${data.wins}W ${data.losses}L (${data.winRate}% WR)\n`;
    msg += `Gross: +$${data.grossPnl.toFixed(2)} | Fees: -$${data.totalFees.toFixed(3)}\n`;

    await sendTelegramMessage(msg);
    return { ...data, transferResult, transferError };
  } else if (data.goalHit) {
    // Goal already hit — info only. The transfer runs Monday 00:00 UTC off the
    // week's FINAL result (see runMondayAutoTransfer), not here.
    msg = `🎯 <b>WEEKLY GOAL HIT!</b>\n\n`;
    msg += `✅ Net P&amp;L: +$${data.netPnl.toFixed(2)} (goal: ${data.goalTargetPct}% — $${data.goalUSD.toFixed(2)})\n`;
    msg += `💰 Balance: $${data.balance.toFixed(2)}\n\n`;
    msg += `🗓 Auto-deposit of $${data.rewardUSD} runs <b>Monday 00:00 UTC</b>\n`;
    msg += `based on this week's final result.\n\n`;
    msg += `<b>📊 Week stats:</b>\n`;
    msg += `Trades: ${data.trades} | ${data.wins}W ${data.losses}L (${data.winRate}% WR)\n`;
    msg += `Gross: +$${data.grossPnl.toFixed(2)} | Fees: -$${data.totalFees.toFixed(3)}\n`;
  } else {
    const pnlEmoji = data.netPnl >= 0 ? '🟢' : '🔴';
    msg = `📊 <b>Weekly Goal Progress</b>\n\n`;
    msg += `${progressBar()} ${data.goalPct}%\n\n`;
    msg += `${pnlEmoji} Net P&amp;L: ${data.netPnl >= 0 ? '+' : ''}$${data.netPnl.toFixed(2)}\n`;
    msg += `🎯 Goal: ${data.goalTargetPct}% ($${data.goalUSD.toFixed(2)})\n`;
    msg += `📍 Remaining: $${data.remaining.toFixed(2)}\n\n`;
    msg += `Trades: ${data.trades} | ${data.wins}W ${data.losses}L\n`;
    msg += `Win rate: ${data.winRate}%\n`;
    msg += `Week started: ${data.weekStart}\n`;

    if (data.netPnl < 0) {
      msg += `\n⚠️ Currently in drawdown — focus on quality setups`;
    } else if (data.remaining > 0) {
      // Rough estimate: 0.237 USD avg net win * 0.86 hit rate
      const tradesNeeded = Math.ceil(data.remaining / 0.237 / 0.86);
      msg += `\n💡 Est. ${tradesNeeded} more winning trades to hit goal`;
    }
  }

  await sendTelegramMessage(msg);
  return data;
}
