# PAXG/USDC Trading Agent

Autonomous 15-minute gold trading agent. Fetches market data from Hyperliquid DEX,
computes 3-layer analysis (Macro + Flow + Technical), generates consensus signals
from 3 LLMs, and auto-executes trades on Hyperliquid perpetuals.

Hosted on **Railway** (persistent Node.js server). Runs 24/7.

> **DISCLAIMER:** Automated trading involves significant financial risk. See [DISCLAIMER.md](DISCLAIMER.md) for full risk disclosure.

---

## Architecture

| Layer | Component | Details |
|---|---|---|
| Runtime | Node.js 20+ (ES modules) | Railway persistent server |
| Exchange | Hyperliquid DEX | PAXG/USDC perpetual |
| Market data | Hyperliquid API | Unlimited, no quota |
| Primary LLM | Claude Haiku 4.5 | Anthropic API |
| Consensus LLM | DeepSeek Chat | OpenAI-compatible |
| News LLM | Perplexity Sonar Pro | Live web search |
| Macro data | FRED API | 10Y yield, real rates |
| Sentiment | Alternative.me | Fear & Greed index |
| Calendar | ForexFactory | Economic events |
| Notifications | Telegram Bot | Two-way commands |
| Scheduler | node-cron | Every 15 minutes |

---

## Three-Layer Analysis

### Layer 1: Macro (Weekly)
- COT report (CFTC) — institutional gold positioning
- Weekly DXY trend — dollar strength direction
- Real yields (FRED) — 10Y minus breakeven inflation
- Geopolitical risk via Perplexity live search

### Layer 2: Flow (Daily)
- Volume profile — high/low volume nodes + POC
- VWAP — daily and weekly institutional benchmark
- Regime detection — trending/ranging/volatile classification
- Hyperliquid funding rate — crowding signal

### Layer 3: Technical (M15 execution)
- H4 bias — BOS/CHoCH structure direction
- H1 context — major swing levels and liquidity
- M15 signals — Order Blocks, FVGs, CHoCH (execution TF)
- Classical indicators — EMA 20/50/200, RSI 14, ATR 14, MACD

---

## Tier System

| Tier | Condition | Risk |
|---|---|---|
| Tier 1 | All 3 layers strongly aligned | 2.0% |
| Tier 2 | All 3 layers aligned | 1.5% |
| Tier 3 | Technical only, macro neutral | 1.0% |
| Tier 4 | Layers conflict | 0.5% (caution) |

---

## LLM Consensus

Every full run (hourly :00):
1. Claude Haiku 4.5 → generates trading plan
2. DeepSeek Chat → generates independent plan
3. Consensus engine compares both
4. If both agree → HIGH confidence
5. If split → MEDIUM confidence (reduced risk)
6. Perplexity → scans breaking news (only when calendar has events)

---

## Execution Flow

**:00 — FULL RUN (hourly)**
```
Fetch H4 + H1 + M15 candles from Hyperliquid (200 each)
Fetch macro: FRED yields + Fear & Greed + ForexFactory calendar
Fetch weekly macro state: COT + DXY weekly structure
Compute: Volume Profile + VWAP + Regime detection
Compute: SMC on H4 (bias) + H1 (context) + M15 (signal)
Call Claude + DeepSeek in parallel → consensus plan
Call Perplexity if calendar has upcoming events
Apply 3-layer tier classification
Send Telegram with plan
```

**:15 / :30 / :45 — QUICK RUN (free — no LLM)**
```
Fetch M15 candles only
Check: did open trade hit SL or TP?
Check: is price now at M15 POI for pending signal?
If M15 confirmed → execute trade on Hyperliquid
Send Telegram only if something changed
```

---

## Risk Management

| Rule | Limit |
|---|---|
| Risk per trade | 0.5% – 2.0% (by tier) |
| Max daily loss | 6% |
| Max weekly drawdown | 15% |
| Max open positions | 2 |
| Max daily trades | 6 |
| Off session block | 17:00–00:00 UTC |
| Friday cutoff | 15:00 UTC |
| News blackout | 30 min before high-impact events |

---

## Telegram Commands

```
/price       — Live PAXG price + funding rate
/funding     — Funding rate detail + sentiment
/news        — Upcoming economic events
/status      — Current plan + M15 status
/lastplan    — Most recent trading plan
/confluence  — Live M15 confluence score (computed on demand)
/analyze     — Trigger full pipeline run NOW
/balance     — Hyperliquid account balance
/positions   — Open positions + PnL
/today       — Today's executed trades
/performance — Daily performance stats
/risk        — Risk rules + current state
/settings    — Agent configuration
/ask         — Chat with Claude about trades
```

---

## Setup

### 1. Clone and install
```bash
git clone https://github.com/NmahaS/xauusd-agent.git
cd xauusd-agent
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in all keys
```

Required keys:
```
ANTHROPIC_API_KEY=      # console.anthropic.com
DEEPSEEK_API_KEY=       # platform.deepseek.com
PERPLEXITY_API_KEY=     # docs.perplexity.ai
TELEGRAM_BOT_TOKEN=     # @BotFather on Telegram
TELEGRAM_CHAT_ID=       # your chat ID
HL_PRIVATE_KEY=         # Hyperliquid API wallet private key
HL_WALLET_ADDRESS=      # your main Hyperliquid wallet address
HL_COIN=PAXG
FRED_API_KEY=           # optional — fred.stlouisfed.org
```

### 3. Deploy to Railway
1. Create project at [railway.app](https://railway.app)
2. Connect GitHub repo
3. Add all environment variables in Railway dashboard
4. Add `AUTO_TRADE=false` and `DRY_EXECUTE=true` (enable after testing)
5. Railway auto-deploys on every push

### 4. Set Telegram webhook
```bash
node scripts/setup-railway-webhook.js https://YOUR-APP.up.railway.app
```

### 5. Test
```bash
npm run analyze:force   # full pipeline run
npm run bot             # test Telegram commands
npm run backtest        # backtest on historical data
```

### 6. Go live
When satisfied with dry run results:
- Set `AUTO_TRADE=true` in Railway
- Set `DRY_EXECUTE=false` in Railway

---

## Cost Estimate

| Service | Cost |
|---|---|
| Claude Haiku 4.5 | ~$0.009/run |
| DeepSeek Chat | ~$0.002/run |
| Perplexity Sonar Pro | ~$0.011/run (when events present) |
| Total per day | ~$0.26/day |
| Total per month | ~$7.80/month |
| Hyperliquid fees | 0.035% taker per trade |
| Railway hosting | $5/month |

---

## File Structure

```
xauusd-agent/
├── src/
│   ├── index.js              # Entry point — starts cron + Express server
│   ├── pipeline.js           # Main orchestrator
│   ├── server.js             # Express webhook server
│   ├── cron.js               # node-cron scheduler (every 15 min)
│   ├── run.js                # Single-run entry (npm run analyze)
│   ├── config.js             # Zod env validation
│   ├── data/
│   │   ├── hyperliquid.js    # Market data + candles (primary)
│   │   ├── fred.js           # Macro yields
│   │   ├── sentiment.js      # Fear & Greed
│   │   ├── calendar.js       # Economic calendar
│   │   └── candleCache.js    # Local candle cache
│   ├── macro/
│   │   ├── cot.js            # COT report parser
│   │   ├── weeklyStructure.js # Weekly DXY + yields
│   │   └── macroState.js     # Weekly bias manager
│   ├── flow/
│   │   ├── volumeProfile.js  # Volume profile + HVN/LVN
│   │   ├── vwap.js           # VWAP + std dev bands
│   │   └── regimeDetector.js # Market regime classifier
│   ├── smc/
│   │   ├── swings.js         # Pivot high/low detection
│   │   ├── structure.js      # BOS / CHoCH
│   │   ├── orderBlocks.js    # Bullish/bearish OBs
│   │   ├── fvg.js            # Fair Value Gaps
│   │   ├── liquidity.js      # EQH/EQL pools
│   │   └── premiumDiscount.js # Premium/discount + OTE
│   ├── indicators/
│   │   ├── classical.js      # EMA/RSI/ATR/MACD
│   │   └── session.js        # Session + kill zones
│   ├── analysis/
│   │   └── threeLayerConsensus.js # Tier classifier (1–4)
│   ├── llm/
│   │   ├── client.js         # LLM orchestrator
│   │   ├── consensus.js      # Consensus engine
│   │   ├── prompt.js         # System + user prompts
│   │   └── providers/
│   │       ├── claude.js     # Anthropic API (primary)
│   │       ├── deepseek.js   # DeepSeek API (consensus)
│   │       └── perplexity.js # Perplexity API (news)
│   ├── broker/
│   │   ├── executor.js       # Auto-execution logic
│   │   └── hyperliquid.js    # HL order placement (EIP-712)
│   ├── risk/
│   │   ├── manager.js        # Risk rules + position sizing
│   │   └── state.json        # Persistent risk state
│   ├── refinement/
│   │   └── m15.js            # M15 entry confirmation
│   ├── plan/
│   │   ├── schema.js         # Zod trading plan schema
│   │   ├── writer.js         # Save JSON + README
│   │   ├── formatter.js      # Telegram HTML format
│   │   ├── tracker.js        # Daily performance tracker
│   │   ├── outcomeTracker.js # Win/loss resolution
│   │   ├── confluence.js     # Confluence scorer (12-point)
│   │   ├── monthlyReport.js  # Monthly report generator
│   │   └── generateMonthlyReport.js
│   ├── backtest/
│   │   ├── run.js            # Backtest entry point
│   │   ├── runner.js         # Walk-forward simulation
│   │   ├── stats.js          # Performance statistics
│   │   ├── report.js         # Backtest report formatter
│   │   └── fetchHistory.js   # Historical data fetcher
│   ├── telegram/
│   │   ├── notify.js         # Send messages
│   │   ├── webhook.js        # Express webhook bridge
│   │   ├── bot.js            # Polling fallback
│   │   └── commands.js       # Command handlers (14 commands)
│   └── utils/
│       ├── marketHours.js    # Market open/close guard
│       └── gitSync.js        # GitHub file sync
├── plans/                    # Trading plans (auto-committed)
├── cache/                    # Candle cache (local only)
├── scripts/
│   ├── safe-push.sh          # Conflict-safe git push
│   ├── setup-railway-webhook.js
│   └── smoke-executor.js     # Executor smoke test
├── .github/workflows/
│   └── analyze.yml           # GitHub Actions (backup cron)
├── railway.json              # Railway deployment config
└── DISCLAIMER.md
```

---

## Disclaimer

This tool executes trades automatically on Hyperliquid DEX. Automated trading
involves significant financial risk. Never trade with money you cannot afford
to lose. See [DISCLAIMER.md](DISCLAIMER.md) for full risk disclosure.


## Latest Plan

<!-- LATEST_PLAN_START -->
**Generated:** 2026-05-29T00:29:59.860Z

- **Bias:** bearish
- **Setup Quality:** B
- **Confluence:** 4 — H4 bearish structure (CHoCH-bearish intact, EMA alignment bearish); Price in premium zone (89.2% H1, 61.1% H4) — short bias favored; M15 overbought RSI 62.4 — bearish divergence setup; Institutional bias bearish (price below weekly VWAP)
- **Session:** asia — Wait for London open (07:00 UTC, ~6.5 hours). London kill zone 07:00-10:00 UTC preferred for short execution. Current Asia session is low-volatility; avoid entry now.
- **Direction:** short
- **POI:** bearish_order_block @ [4498.2, 4498.7]
- **Entry:** marketOnConfirmation @ 4491.95 — Market entry at current price (4491.95). No M15 OB within 30pts; H4 bearish bias confirmed. Enter short on next M15 bearish candle close below 4490 or on limit fill at 4498.20 (top of bearish FVG) if price retraces. Prefer limit at 4498.20 for better risk/reward.
- **Stop Loss:** 4506.2
- **TP1:** 4481.8 (RR 2)
- **Invalidation:** 4506.2

**Macro Context:** Weekly yields falling (bullish gold) but EUR/USD weakening (dollar strengthening = bearish gold). Extreme fear (F&G 23) supports safe-haven demand, but institutional bias is bearish (price below weekly VWAP). Macro is neutral-to-bearish; technical bearish bias dominates. High positive funding (0.0013%/hr, 11% annualized) indicates crowded longs — mild bearish contrarian signal.

**Warnings:**
- ⚠ H4 bearish vs H1 bullish creates structural conflict — confluence is only B (4 factors). Require London kill zone confirmation before entry.
- ⚠ Market transitioning regime — SMC effective but volatility may be low. Avoid entry in Asia session; wait for London.
- ⚠ Historical performance marginal (33% WR, 0R expectancy). Blocked signals 100% win rate — this setup type has been correctly blocked before. Proceed with caution.
- ⚠ M15 overbought RSI 62.4 but no bearish divergence yet. Wait for RSI rollover or M15 candle close below 4490 for confirmation.
- ⚠ German Prelim CPI (Medium, +359m) and BOE Gov Bailey Speaks (High, +470m) upcoming — avoid entry within 1 hour of these events.
- ⚠ No M15 OB within 30pts; market entry at 4491.95 is acceptable but prefer limit at 4498.20 (bearish FVG) for better entry quality.
- ⚠ Funding rate positive (longs paying) — mild bearish signal but not primary driver. Do not over-weight.
- ⚠ ⚡ DeepSeek: unavailable — using Claude direction
- ⚠ FRED macro data unavailable — yields/real-rate missing
<!-- LATEST_PLAN_END -->
