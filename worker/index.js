// Cloudflare Worker — Telegram webhook handler for XAUUSD Agent.
// Runs in V8 isolate: no Node.js built-ins, no fs, no process.env.
// All secrets come from the `env` parameter (set in Cloudflare dashboard).
// All external calls use fetch(). No imports from src/.

// ─── IG helpers ───────────────────────────────────────────────────────────────

async function igLogin(env) {
  const base = env.IG_DEMO === 'false'
    ? 'https://api.ig.com/gateway/deal'
    : 'https://demo-api.ig.com/gateway/deal';
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: {
      'X-IG-API-KEY': env.IG_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json; charset=UTF-8',
      Version: '2',
    },
    body: JSON.stringify({ identifier: env.IG_USERNAME, password: env.IG_PASSWORD, encryptedPassword: false }),
  });
  const cst = res.headers.get('CST');
  const token = res.headers.get('X-SECURITY-TOKEN');
  if (!cst || !token) throw new Error('IG login failed — check IG_API_KEY / credentials');
  return { base, cst, token };
}

function igHeaders(session, env) {
  return {
    'X-IG-API-KEY': env.IG_API_KEY,
    CST: session.cst,
    'X-SECURITY-TOKEN': session.token,
    'Content-Type': 'application/json',
    Accept: 'application/json; charset=UTF-8',
  };
}

async function igGet(session, p, env, version = 1) {
  const res = await fetch(`${session.base}${p}`, {
    headers: { ...igHeaders(session, env), Version: String(version) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IG GET ${p} HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function tgSend(chatId, text, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4096),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error('[tg] send failed:', JSON.stringify(json).slice(0, 200));
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function ghGet(filePath, env) {
  if (!env.GITHUB_REPO) return null;
  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'xauusd-agent',
  };
  if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${filePath}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

function ghDecode(file) {
  if (!file?.content) return null;
  try { return JSON.parse(atob(file.content.replace(/\n/g, ''))); }
  catch { return null; }
}

async function fetchLatestPlan(env) {
  const today = todayUTC();
  const dir = await ghGet(`plans/${today}`, env);
  if (!Array.isArray(dir)) return null;
  const planFiles = dir
    .filter(f => /^\d{2}\.json$/.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (!planFiles.length) return null;
  return ghDecode(await ghGet(`plans/${today}/${planFiles[0].name}`, env));
}

async function fetchDailySummary(env) {
  return ghDecode(await ghGet(`plans/${todayUTC()}/daily-summary.json`, env));
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleHelp(chatId, env) {
  await tgSend(chatId,
    `<b>📖 XAUUSD Agent Commands</b>\n\n` +
    `/price — Live gold price &amp; spread\n` +
    `/status — Account + latest plan\n` +
    `/lastplan — Most recent trading plan\n` +
    `/confluence — Confluence factors\n` +
    `/balance — IG account balance\n` +
    `/positions — Open positions\n` +
    `/risk — Risk rules\n` +
    `/today — Today's performance\n` +
    `/news — Breaking gold news (Perplexity)\n` +
    `/analyze — Trigger analysis now\n` +
    `/settings — Agent config\n` +
    `/ask &lt;question&gt; — Chat with Claude\n\n` +
    `<i>Or just type any question.</i>`,
    env
  );
}

async function handlePrice(chatId, env) {
  if (!env.IG_API_KEY) { await tgSend(chatId, '⚠️ IG not configured.', env); return; }
  try {
    const session = await igLogin(env);
    const [market, sentiment] = await Promise.allSettled([
      igGet(session, '/markets/MT.D.GC.FWS2.IP', env, 3),
      igGet(session, '/clientsentiment/GOLD', env, 1),
    ]);
    const snap = market.value?.snapshot ?? {};
    const bid = Number(snap.bid ?? 0);
    const offer = Number(snap.offer ?? 0);
    const mid = bid && offer ? ((bid + offer) / 2).toFixed(2) : 'n/a';
    const spread = bid && offer ? (offer - bid).toFixed(2) : 'n/a';
    const chg = snap.percentageChange != null
      ? `${snap.percentageChange >= 0 ? '+' : ''}${Number(snap.percentageChange).toFixed(2)}%`
      : 'n/a';
    const long = sentiment.value?.clientSentiment?.longPositionPercentage;
    const sentLine = long != null
      ? `\nSentiment: 🟢 ${long.toFixed(0)}% long / 🔴 ${(100 - long).toFixed(0)}% short`
      : '';
    await tgSend(chatId,
      `<b>🥇 Gold (MT.D.GC.FWS2.IP)</b>\n\n` +
      `Mid: <b>A$${mid}</b> (${chg})\n` +
      `Bid: A$${snap.bid ?? 'n/a'} | Ask: A$${snap.offer ?? 'n/a'}\n` +
      `Spread: ${spread} pts\n` +
      `High: A$${snap.high ?? 'n/a'} | Low: A$${snap.low ?? 'n/a'}\n` +
      `Status: <code>${snap.marketStatus ?? 'UNKNOWN'}</code>${sentLine}\n` +
      `<i>${new Date().toUTCString()}</i>`,
      env
    );
  } catch (err) {
    await tgSend(chatId, `⚠️ Price error: ${err.message}`, env);
  }
}

async function handleStatus(chatId, env) {
  const lines = [`<b>📊 Agent Status</b>`, ''];

  if (env.IG_API_KEY) {
    try {
      const session = await igLogin(env);
      const [accounts, positions] = await Promise.all([
        igGet(session, '/accounts', env, 1),
        igGet(session, '/positions', env, 2),
      ]);
      const wantId = env.IG_ACCOUNT_ID;
      const acct = wantId
        ? (accounts.accounts || []).find(a => a.accountId === wantId) || (accounts.accounts || [])[0]
        : (accounts.accounts || [])[0];
      const b = acct?.balance ?? {};
      const posCount = (positions.positions || []).length;
      lines.push(`<b>💰 Balance:</b> A$${(b.balance ?? 0).toFixed(2)} (avail A$${(b.available ?? 0).toFixed(2)})`);
      lines.push(`<b>Open P/L:</b> ${(b.profitLoss ?? 0) >= 0 ? '+' : ''}A$${(b.profitLoss ?? 0).toFixed(2)}`);
      lines.push(`<b>Positions:</b> ${posCount}`);
      lines.push('');
    } catch (err) {
      lines.push(`⚠️ IG: ${err.message}`, '');
    }
  }

  const plan = await fetchLatestPlan(env);
  if (plan) {
    const biasEmoji = { bullish: '🟢', bearish: '🔴', neutral: '⚪' }[plan.bias] ?? '⚪';
    lines.push(`${biasEmoji} <b>${(plan.bias ?? '').toUpperCase()}</b> | Quality: <b>${plan.setupQuality}</b>`);
    lines.push(`Direction: <b>${plan.direction?.toUpperCase() ?? 'NO TRADE'}</b>`);
    if (plan.m15?.status && plan.m15.status !== 'N/A') lines.push(`M15: ${plan.m15.status}`);
    if (plan.execution?.executed) lines.push(`🚀 Executed: ${plan.execution.dealId}`);
    else if (plan.execution?.autoTradeEnabled) lines.push(`⏸ ${plan.execution.reason}`);
    lines.push(`<i>${plan.timestamp}</i>`);
  } else {
    lines.push('<i>No plan found for today</i>');
  }

  await tgSend(chatId, lines.join('\n'), env);
}

async function handleBalance(chatId, env) {
  if (!env.IG_API_KEY) { await tgSend(chatId, '⚠️ IG not configured.', env); return; }
  try {
    const session = await igLogin(env);
    const accounts = await igGet(session, '/accounts', env, 1);
    const wantId = env.IG_ACCOUNT_ID;
    const acct = wantId
      ? (accounts.accounts || []).find(a => a.accountId === wantId) || (accounts.accounts || [])[0]
      : (accounts.accounts || [])[0];
    if (!acct) { await tgSend(chatId, 'No account found.', env); return; }
    const b = acct.balance ?? {};
    await tgSend(chatId,
      `<b>💰 ${acct.accountId} (${acct.accountType ?? 'n/a'})</b>\n\n` +
      `Balance: <b>A$${(b.balance ?? 0).toFixed(2)}</b>\n` +
      `Equity: A$${((b.balance ?? 0) + (b.profitLoss ?? 0)).toFixed(2)}\n` +
      `Available: A$${(b.available ?? 0).toFixed(2)}\n` +
      `Open P/L: ${(b.profitLoss ?? 0) >= 0 ? '+' : ''}A$${(b.profitLoss ?? 0).toFixed(2)}\n` +
      `Currency: ${acct.currency ?? 'AUD'}\n` +
      `<i>${env.IG_DEMO === 'false' ? '🔴 LIVE account' : '🟡 DEMO account'}</i>`,
      env
    );
  } catch (err) {
    await tgSend(chatId, `⚠️ Balance error: ${err.message}`, env);
  }
}

async function handlePositions(chatId, env) {
  if (!env.IG_API_KEY) { await tgSend(chatId, '⚠️ IG not configured.', env); return; }
  try {
    const session = await igLogin(env);
    const data = await igGet(session, '/positions', env, 2);
    const positions = data.positions || [];
    if (!positions.length) { await tgSend(chatId, '📭 No open positions.', env); return; }
    const lines = [`<b>📊 Open Positions (${positions.length})</b>`, ''];
    for (const pos of positions) {
      const p = pos.position ?? {};
      const m = pos.market ?? {};
      const dir = p.direction === 'BUY' ? '🟢 LONG' : '🔴 SHORT';
      const pl = p.profitLoss != null
        ? `${p.profitLoss >= 0 ? '+' : ''}A$${Number(p.profitLoss).toFixed(2)}`
        : 'n/a';
      lines.push(`${dir} ${m.instrumentName ?? m.epic ?? 'n/a'}`);
      lines.push(`  Size: ${p.size ?? 'n/a'} | Entry: A$${Number(p.level ?? 0).toFixed(2)}`);
      lines.push(`  SL: A$${Number(p.stopLevel ?? 0).toFixed(2)} | TP: A$${Number(p.limitLevel ?? 0).toFixed(2)}`);
      lines.push(`  P/L: <b>${pl}</b>`);
      lines.push('');
    }
    await tgSend(chatId, lines.join('\n'), env);
  } catch (err) {
    await tgSend(chatId, `⚠️ Positions error: ${err.message}`, env);
  }
}

async function handleToday(chatId, env) {
  const summary = await fetchDailySummary(env);
  if (!summary) {
    await tgSend(chatId, '📭 No summary for today yet. Check back after the next analysis run.', env);
    return;
  }
  const { trades = 0, noTrades = 0, wins: w = {}, directions: dir = {}, dailyRR: rr = {} } = summary;
  const lines = [
    `<b>📊 Today's Performance</b>`,
    `<i>${todayUTC()}</i>`,
    '',
    `Trades: ${trades} | No-trade: ${noTrades}`,
    `Wins: ${w.total ?? 0} | Losses: ${w.losses ?? 0} | Open: ${w.open ?? 0}`,
    `Win rate: ${w.winRate ?? 'n/a'}`,
    dir.long != null ? `Long: ${dir.long} | Short: ${dir.short ?? 0}` : '',
    rr?.netRR != null ? `Net RR: ${rr.netRR >= 0 ? '+' : ''}${rr.netRR.toFixed(2)}R` : '',
  ].filter(Boolean);
  await tgSend(chatId, lines.join('\n'), env);
}

async function handleNews(chatId, args, env) {
  if (!env.PERPLEXITY_API_KEY) {
    await tgSend(chatId, '❌ Perplexity not configured — add PERPLEXITY_API_KEY in Cloudflare dashboard.', env);
    return;
  }
  await tgSend(chatId, '🔍 Fetching gold news...', env);
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        max_tokens: 400,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: 'Gold market news analyst. Summarize breaking news affecting XAU/USD prices — Fed policy, inflation, geopolitics, USD. Under 300 words. Plain text, no markdown.',
          },
          { role: 'user', content: args || 'What are the key gold market drivers right now?' },
        ],
      }),
    });
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content ?? 'No response.';
    await tgSend(chatId, `<b>📰 Gold News</b>\n\n${reply.slice(0, 3500)}`, env);
  } catch (err) {
    await tgSend(chatId, `⚠️ News error: ${err.message}`, env);
  }
}

async function handleAsk(chatId, question, env) {
  if (!question?.trim()) {
    await tgSend(chatId, '💬 Usage: /ask &lt;your question&gt;\nOr just type your question directly.', env);
    return;
  }
  if (!env.ANTHROPIC_API_KEY) {
    await tgSend(chatId, '⚠️ Claude not configured (ANTHROPIC_API_KEY missing).', env);
    return;
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        temperature: 0.7,
        system:
          `You are a concise trading assistant for an XAU/AUD futures day trading agent on IG Australia. ` +
          `Current date: ${todayUTC()}. ` +
          `Answer questions about trading, market structure, and Smart Money Concepts in max 200 words. ` +
          `Plain text — no markdown, no asterisks.`,
        messages: [{ role: 'user', content: question }],
      }),
    });
    if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
    const data = await res.json();
    const reply = data.content?.[0]?.text ?? 'No response.';
    await tgSend(chatId, `💬 <b>Claude:</b>\n\n${reply.slice(0, 3500)}`, env);
  } catch (err) {
    await tgSend(chatId, `⚠️ Ask error: ${err.message}`, env);
  }
}

async function handleRisk(chatId, env) {
  const lines = [
    `<b>🛡 Risk Rules (A$100 account)</b>`,
    '',
    `Max risk/trade: 1%`,
    `Max daily loss: 3%`,
    `Max weekly drawdown: 8%`,
    `Max open positions: 1`,
    `Max daily trades: 4`,
    `Lot size: 0.1 – 0.5`,
    `Min RR (TP1): 1.5`,
    `Required quality: A+, A`,
    `Required consensus: full (both LLMs agree)`,
    `Blocked sessions: off, asia`,
    `Friday cutoff: 15:00 UTC`,
    `News blackout: 30 min`,
  ];
  const state = ghDecode(await ghGet('src/risk/state.json', env));
  if (state) {
    lines.push('', `<b>📊 Current State</b>`);
    lines.push(`Daily trades: ${state.dailyTrades ?? 0}`);
    lines.push(`Daily P/L: ${(state.dailyPL ?? 0) >= 0 ? '+' : ''}${state.dailyPL ?? 0}`);
    lines.push(`Weekly P/L: ${(state.weeklyPL ?? 0) >= 0 ? '+' : ''}${state.weeklyPL ?? 0}`);
    lines.push(state.cooldownUntil ? `⏸ Cooldown: ${state.cooldownUntil}` : '✅ No cooldown');
  }
  await tgSend(chatId, lines.join('\n'), env);
}

async function handleSettings(chatId, env) {
  await tgSend(chatId,
    `<b>⚙️ Worker Config</b>\n\n` +
    `IG: ${env.IG_API_KEY ? '✅' : '❌'} | ${env.IG_DEMO === 'false' ? '🔴 LIVE' : '🟡 DEMO'}\n` +
    `Auto-trade: ${env.AUTO_TRADE === 'true' ? '✅ ON' : '❌ OFF'}\n` +
    `Dry-execute: ${env.DRY_EXECUTE !== 'false' ? '✅ YES (no real orders)' : '⚠️ LIVE ORDERS'}\n` +
    `Claude: ${env.ANTHROPIC_API_KEY ? '✅' : '❌'}\n` +
    `DeepSeek: ${env.DEEPSEEK_API_KEY ? '✅' : '❌'}\n` +
    `Perplexity: ${env.PERPLEXITY_API_KEY ? '✅' : '❌'}\n` +
    `GitHub: ${env.GITHUB_TOKEN ? '✅' : '❌'} (${env.GITHUB_REPO ?? 'not set'})`,
    env
  );
}

async function handleLastPlan(chatId, env) {
  const plan = await fetchLatestPlan(env);
  if (!plan) { await tgSend(chatId, '📋 No plan found for today.', env); return; }
  const biasEmoji = { bullish: '🟢', bearish: '🔴', neutral: '⚪' }[plan.bias] ?? '⚪';
  const lines = [
    `<b>${biasEmoji} Last Plan — ${plan.symbol ?? 'XAU/AUD'}</b>`,
    `<i>${plan.timestamp}</i>`,
    '',
    `<b>Bias:</b> ${plan.bias ?? 'n/a'} | <b>Quality:</b> ${plan.setupQuality ?? 'n/a'}`,
  ];
  if (plan.direction && plan.entry && plan.stopLoss) {
    lines.push(`<b>Direction:</b> ${plan.direction.toUpperCase()}`);
    lines.push(`<b>Entry:</b> A$${plan.entry.price?.toFixed(2) ?? 'n/a'} (${plan.entry.trigger ?? ''})`);
    lines.push(`<b>SL:</b> A$${plan.stopLoss.price?.toFixed(2) ?? 'n/a'}`);
    if (plan.takeProfits?.length) {
      lines.push(plan.takeProfits.map((tp, i) => `TP${i + 1}: A$${tp.price?.toFixed(2)} (${tp.rr?.toFixed(1)}R)`).join(' | '));
    }
  } else {
    lines.push('<b>⏸ No trade signal.</b>');
  }
  if (plan.consensus) {
    const c = plan.consensus;
    lines.push('', `<b>Consensus:</b> ${c.agreement} (${c.confidence})`,
      `Claude: ${c.claudeDirection ?? 'n/a'} / DeepSeek: ${c.deepseekDirection ?? 'n/a'}`);
  }
  await tgSend(chatId, lines.join('\n'), env);
}

async function handleConfluence(chatId, env) {
  const plan = await fetchLatestPlan(env);
  if (!plan) { await tgSend(chatId, '📋 No plan found for today.', env); return; }
  const lines = [
    `<b>🔍 Confluence — ${plan.symbol ?? 'XAU/AUD'}</b>`,
    `Count: <b>${plan.confluenceCount ?? 0}</b> factors`,
    '',
  ];
  if (plan.confluenceFactors?.length) {
    for (const f of plan.confluenceFactors) lines.push(`  ✅ ${f}`);
  } else {
    lines.push('No factors recorded.');
  }
  await tgSend(chatId, lines.join('\n'), env);
}

async function handleAnalyze(chatId, env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    await tgSend(chatId, '⚠️ GITHUB_TOKEN and GITHUB_REPO required to trigger analysis.\nAdd them in the Cloudflare dashboard.', env);
    return;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/analyze.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'xauusd-agent',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (res.status === 204) {
      await tgSend(chatId, '🔍 Analysis triggered — plan will arrive via Telegram in ~30 seconds.', env);
    } else {
      const body = await res.text().catch(() => '');
      await tgSend(chatId, `⚠️ Trigger failed (HTTP ${res.status}): ${body.slice(0, 200)}`, env);
    }
  } catch (err) {
    await tgSend(chatId, `⚠️ Analyze error: ${err.message}`, env);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function routeCommand(command, args, chatId, env) {
  switch (command) {
    case '/help':
    case '/start':       return handleHelp(chatId, env);
    case '/price':       return handlePrice(chatId, env);
    case '/status':      return handleStatus(chatId, env);
    case '/balance':     return handleBalance(chatId, env);
    case '/positions':   return handlePositions(chatId, env);
    case '/today':
    case '/performance': return handleToday(chatId, env);
    case '/news':        return handleNews(chatId, args, env);
    case '/ask':         return handleAsk(chatId, args, env);
    case '/risk':        return handleRisk(chatId, env);
    case '/settings':    return handleSettings(chatId, env);
    case '/lastplan':    return handleLastPlan(chatId, env);
    case '/confluence':  return handleConfluence(chatId, env);
    case '/analyze':     return handleAnalyze(chatId, env);
    default:
      // Free-form text → treat as /ask
      if (!command.startsWith('/')) {
        const full = args ? `${command} ${args}` : command;
        if (full.trim().length > 3) return handleAsk(chatId, full, env);
        return; // ignore very short messages
      }
      return tgSend(chatId, `❓ Unknown: <code>${command}</code>\nType /help`, env);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('XAUUSD Agent webhook active ✓', { status: 200 });
    }

    try {
      const update = await request.json();
      const msg = update.message ?? update.edited_message;
      if (!msg?.text) return new Response('ok');

      // Security: only respond to the configured chat
      if (env.TELEGRAM_CHAT_ID && String(msg.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
        console.warn('[worker] ignored message from chat', msg.chat.id);
        return new Response('ok');
      }

      const text = msg.text.trim();
      const spaceIdx = text.indexOf(' ');
      const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
      const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

      // Don't await — Cloudflare requires response within a few seconds.
      // Use waitUntil to let the handler finish after we've returned 200.
      const ctx = { waitUntil: p => p }; // fallback if no ExecutionContext
      const handler = routeCommand(command, args, msg.chat.id, env).catch(err =>
        console.error('[worker] handler error:', err.message)
      );
      if (request.cf) {
        // Real Cloudflare environment — use ExecutionContext from the second arg
      }
      await handler;
    } catch (err) {
      console.error('[worker] parse error:', err.message);
    }

    // Always return 200 to Telegram — any non-200 causes retries
    return new Response('ok');
  },
};
