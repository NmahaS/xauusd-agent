// Weekly profit-goal tracker. Filters this week's HL fills (Mon 00:00 UTC → now),
// computes net P&L vs WEEKLY_GOAL_USD, and renders progress to Telegram.
// Informational only — never gates execution.

import { getHLAllFills, getHLBalance } from '../broker/hyperliquid.js';

export async function checkWeeklyGoal() {
  const goalUSD = parseFloat(process.env.WEEKLY_GOAL_USD || '5.00');
  const rewardUSD = parseFloat(process.env.WEEKLY_GOAL_REWARD || '100');
  const coin = process.env.HL_COIN || 'PAXG';

  // Fetch all fills (no date cutoff) then filter to current week
  const fills = await getHLAllFills(coin);
  const balance = await getHLBalance();

  // Week boundaries — Monday 00:00 UTC to now
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - daysFromMonday);
  weekStart.setUTCHours(0, 0, 0, 0);

  const weekFills = fills.filter(f =>
    new Date(f.time).getTime() >= weekStart.getTime()
  );

  const closeFills = weekFills.filter(f => f.isClose);
  const grossPnl = closeFills.reduce((sum, f) => sum + f.closedPnl, 0);
  const totalFees = weekFills.reduce((sum, f) => sum + f.fee, 0);
  const netPnl = grossPnl - totalFees;

  const wins = closeFills.filter(f => f.closedPnl > 0).length;
  const losses = closeFills.filter(f => f.closedPnl <= 0).length;
  const winRate = closeFills.length > 0
    ? ((wins / closeFills.length) * 100).toFixed(1)
    : '0.0';

  const goalPctRaw = (netPnl / goalUSD) * 100;
  const goalPct = Number.isFinite(goalPctRaw) ? Math.round(goalPctRaw) : 0;
  const remaining = parseFloat(Math.max(goalUSD - netPnl, 0).toFixed(2));
  const goalHit = netPnl >= goalUSD;

  console.log(`[goal] week PnL: $${netPnl.toFixed(2)} / $${goalUSD} goal (${goalPct}%)`);

  return {
    netPnl,
    grossPnl,
    totalFees,
    goalUSD,
    rewardUSD,
    goalHit,
    goalPct,
    remaining,
    wins,
    losses,
    winRate,
    trades: closeFills.length,
    weekStart: weekStart.toISOString().slice(0, 10),
    balance: balance.balance,
  };
}

export async function sendWeeklyGoalUpdate() {
  const { sendTelegramMessage } = await import('../telegram/notify.js');
  const data = await checkWeeklyGoal();

  const progressBar = () => {
    const clamped = Math.max(0, Math.min(data.goalPct, 100));
    const filled = Math.floor(clamped / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  let msg = '';

  if (data.goalHit) {
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
    msg += `✅ Net P&amp;L: +$${data.netPnl.toFixed(2)} (goal: $${data.goalUSD})\n`;
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
  } else {
    const pnlEmoji = data.netPnl >= 0 ? '🟢' : '🔴';
    msg = `📊 <b>Weekly Goal Progress</b>\n\n`;
    msg += `${progressBar()} ${data.goalPct}%\n\n`;
    msg += `${pnlEmoji} Net P&amp;L: ${data.netPnl >= 0 ? '+' : ''}$${data.netPnl.toFixed(2)}\n`;
    msg += `🎯 Goal: $${data.goalUSD.toFixed(2)}\n`;
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
