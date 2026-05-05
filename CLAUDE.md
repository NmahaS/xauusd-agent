# PAXG/USDC Autonomous Trading Agent

Autonomous 15-minute gold trading agent on Hyperliquid DEX (PAXG/USDC perpetual).
3-layer analysis (Macro + Flow + Technical) → 3-LLM consensus → auto-execution on Hyperliquid.

Hosted on **Railway** (persistent Node.js server, 24/7). Entry point: `src/index.js`.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (ES modules) |
| Hosting | Railway persistent server (`node src/index.js`) |
| Scheduler | node-cron every 15 min |
| Exchange | Hyperliquid DEX — PAXG/USDC perpetual |
| Market data | Hyperliquid REST API (no quota, no key needed) |
| Primary LLM | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) — Anthropic API |
| Consensus LLM | DeepSeek Chat (`deepseek-chat`) — OpenAI-compatible |
| News LLM | Perplexity Sonar Pro — live web search, optional |
| Macro data | FRED API (10Y yield, Fed rate, breakeven) |
| Sentiment | Alternative.me Fear & Greed (free, no key) |
| Calendar | ForexFactory via faireconomy mirror (free, no key) |
| Storage | JSON files committed to repo (`plans/`) |
| Notifications | Telegram Bot API (webhook via Express) |
| Validation | Zod |

---

## Directory Structure

```
xauusd-agent/
├── src/
│   ├── index.js              # Entry: starts cron + Express server
│   ├── pipeline.js           # Orchestrator (full + quick runs)
│   ├── server.js             # Express webhook server
│   ├── cron.js               # node-cron scheduler (every 15 min)
│   ├── run.js                # Single-run entry (npm run analyze)
│   ├── config.js             # Zod-validated env vars
│   ├── data/
│   │   ├── hyperliquid.js    # Candles, mark price, funding, EUR proxy
│   │   ├── fred.js           # 10Y yield, Fed rate, breakeven, real yield
│   │   ├── sentiment.js      # Fear & Greed index (0-100)
│   │   ├── calendar.js       # ForexFactory economic calendar
│   │   └── candleCache.js    # Local candle cache (disk)
│   ├── macro/
│   │   ├── cot.js            # CFTC COT report parser
│   │   ├── weeklyStructure.js # Weekly DXY trend + yield bias
│   │   └── macroState.js     # Weekly macro bias manager
│   ├── flow/
│   │   ├── volumeProfile.js  # Volume profile: POC, HVN, LVN, value area
│   │   ├── vwap.js           # Daily + weekly VWAP + std dev bands
│   │   └── regimeDetector.js # Trend/range/volatile regime classifier
│   ├── smc/
│   │   ├── swings.js         # Pivot high/low detection
│   │   ├── structure.js      # BOS / CHoCH (market structure)
│   │   ├── orderBlocks.js    # Bullish/bearish order blocks
│   │   ├── fvg.js            # Fair Value Gaps (imbalances)
│   │   ├── liquidity.js      # EQH/EQL pools + session liquidity
│   │   └── premiumDiscount.js # Premium/discount zones + OTE
│   ├── indicators/
│   │   ├── classical.js      # EMA 20/50/200, RSI 14, ATR 14, MACD
│   │   └── session.js        # Asia/London/NY sessions + kill zones
│   ├── analysis/
│   │   └── threeLayerConsensus.js # Combines 3 layers → Tier 1-4
│   ├── llm/
│   │   ├── client.js         # Orchestrates all 3 LLM providers
│   │   ├── consensus.js      # Compares Claude + DeepSeek plans
│   │   ├── prompt.js         # System + user prompt builders (v4.0)
│   │   └── providers/
│   │       ├── claude.js     # Anthropic Messages API
│   │       ├── deepseek.js   # DeepSeek chat completions (OpenAI-compat)
│   │       └── perplexity.js # Perplexity Sonar Pro (news/events)
│   ├── broker/
│   │   ├── executor.js       # Execution gating + position sizing
│   │   └── hyperliquid.js    # EIP-712 order signing + HL REST API
│   ├── risk/
│   │   ├── manager.js        # Risk rules, account state, position sizing
│   │   └── state.json        # Persisted daily/weekly P&L state
│   ├── refinement/
│   │   └── m15.js            # M15 entry confirmation logic
│   ├── plan/
│   │   ├── schema.js         # Zod schema for trading plan
│   │   ├── writer.js         # Save JSON + update README
│   │   ├── formatter.js      # Plan → Telegram HTML
│   │   ├── tracker.js        # Daily trade performance tracker
│   │   ├── outcomeTracker.js # Win/loss resolution from candles
│   │   ├── confluence.js     # Deterministic 12-point confluence scorer
│   │   ├── monthlyReport.js  # Monthly performance report builder
│   │   └── generateMonthlyReport.js
│   ├── backtest/
│   │   ├── run.js            # Backtest entry point
│   │   ├── runner.js         # Walk-forward simulation engine
│   │   ├── stats.js          # Win rate, RR, Sharpe, drawdown
│   │   ├── report.js         # Backtest report formatter
│   │   └── fetchHistory.js   # Fetch historical candles from HL
│   ├── telegram/
│   │   ├── notify.js         # Send message via Bot API
│   │   ├── webhook.js        # Express route bridge
│   │   ├── bot.js            # Long-polling fallback
│   │   └── commands.js       # All command handlers (14 commands)
│   └── utils/
│       ├── marketHours.js    # Gold market open/close guard
│       └── gitSync.js        # GitHub file sync (plans, cache)
├── plans/                    # Trading plans JSON (auto-committed)
├── cache/                    # Candle cache (local disk, not committed)
├── scripts/
│   ├── safe-push.sh          # Conflict-safe push (handles bot commits)
│   ├── setup-railway-webhook.js
│   └── smoke-executor.js     # Executor smoke test
├── .github/workflows/
│   └── analyze.yml           # Backup hourly cron (GitHub Actions)
├── railway.json              # Railway deployment config
├── .env.example
└── DISCLAIMER.md
```

---

## Hyperliquid API Integration

Base URL: `https://api.hyperliquid.xyz`

### Market data (no auth)
```
POST /info
{ "type": "candleSnapshot", "req": { "coin": "PAXG", "interval": "1h", "startTime": N, "endTime": N } }
{ "type": "metaAndAssetCtxs" }  → returns [meta, assetCtxs]
{ "type": "clearinghouseState", "user": "0x..." }  → account state
```

PAXG (PAX Gold) is the gold perpetual on Hyperliquid — tracks 1 troy oz physical gold.
Field names on assetCtx: `markPx`, `midPx`, `oraclePx`, `funding`, `openInterest`.

Balance queries MUST use `HL_WALLET_ADDRESS` (main wallet), NOT the API wallet derived from `HL_PRIVATE_KEY`.
`withdrawable` is a top-level field on clearinghouseState, NOT inside `marginSummary`.

### Order execution (EIP-712 signed)
```
POST /exchange
{ "action": { "type": "order", "orders": [...], "grouping": "na" }, "nonce": Date.now(), "signature": {...} }
```
Uses ethers.js v6 `wallet.signTypedData` with domain `{ name: "Exchange", version: "1", chainId: 1337 }`.
`HL_PRIVATE_KEY` = API wallet key (signs orders only, holds no funds).

---

## LLM Integration

### Claude (primary — `src/llm/providers/claude.js`)
```
POST https://api.anthropic.com/v1/messages
Headers: x-api-key, anthropic-version: 2023-06-01
Body: { model: "claude-haiku-4-5-20251001", max_tokens: 4000, temperature: 0.2, ... }
```

### DeepSeek (consensus — `src/llm/providers/deepseek.js`)
```
POST https://api.deepseek.com/chat/completions
Headers: Authorization: Bearer <DEEPSEEK_API_KEY>
Body: { model: "deepseek-chat", response_format: { type: "json_object" }, temperature: 0.3, ... }
```

### Perplexity (news — `src/llm/providers/perplexity.js`)
```
POST https://api.perplexity.ai/chat/completions
Headers: Authorization: Bearer <PERPLEXITY_API_KEY>
Body: { model: "sonar-pro", temperature: 0.1, ... }
```
Only called when ForexFactory has upcoming events AND `PERPLEXITY_API_KEY` is set.

### Consensus rules (`src/llm/consensus.js`)
1. Perplexity news override (shouldBlockTrading=true) → force no-trade
2. Single LLM only → use it + "medium confidence"
3. Both agree on direction → higher quality + "high confidence"
4. Both no-trade → proceed as no-trade
5. Split → take one + force "B" quality + "medium confidence"

---

## Three-Layer Consensus (`src/analysis/threeLayerConsensus.js`)

### Layer 1 — Macro (weekly)
COT positioning + weekly DXY trend + real yields.
Outputs: `weeklyBias`, `cotSignal`, `factors[]`, `summary`.

### Layer 2 — Flow (daily)
Volume profile (POC, value area) + VWAP + regime detection.
Outputs: `regime` (trending/ranging/volatile), `institutionalBias`, `signals[]`.

### Layer 3 — Technical (H4 → H1 → M15)
SMC structure + confluence score + indicator alignment.
Outputs: `confluenceCount` (0-12), `bias`, `quality` (A+/A/B/no-trade).

### Tier Classification
| Tier | Condition | Risk |
|---|---|---|
| 1 | All 3 layers strongly aligned (all same direction) | 2.0% |
| 2 | All 3 layers aligned | 1.5% |
| 3 | Technical only — macro neutral/mixed | 1.0% |
| 4 | Layers conflict | 0.5% (warning added) |

All tiers are executable. Tier 4 adds warnings but does NOT block.

---

## Execution Flow

### Full run (hourly :00 via cron)
1. `fetchAllHLData()` — H1/H4/M15 candles + mark price + funding + EUR/USD proxy
2. `fetchFredMacro()` + `fetchSentiment()` + `fetchCalendar()` — in parallel
3. `computeClassicalIndicators()` on H1/H4/M15
4. `smcForTimeframe()` on H1/H4/M15 (structure + OBs + FVGs + liquidity + P/D)
5. `computeThreeLayerConsensus()` — weekly macro + flow + technical → tier
6. `runLLMConsensus()` — Claude + DeepSeek in parallel + optional Perplexity
7. `refineWithM15()` — check M15 confirmation for entry
8. `executeIfApproved()` — if AUTO_TRADE=true and all gates pass
9. `savePlan()` + `formatPlanForTelegram()` + `notify()`

### Quick run (:15/:30/:45 via cron)
1. Fetch M15 candles only
2. Check if pending plan's M15 POI is reached
3. If CONFIRMED → `executeIfApproved()`
4. Telegram only if status changed

---

## Risk Rules (`src/risk/manager.js`)

### Hard blocks (return `{ allowed: false }`)
- Session = 'off' (17:00–00:00 UTC)
- Friday after 15:00 UTC
- High-impact news within 30 min
- Daily loss ≤ −6%
- Weekly drawdown ≤ −15%
- Open positions ≥ 2
- Daily trades ≥ 6
- TP1 RR < 1.5
- Confluence < 5

### Soft (warnings only, still executes)
- Tier 4 → adds 2 warnings to `plan.warnings[]`
- Split consensus → adds 1 warning

### Execution matrix
```javascript
{
  'A+': { tier1: 2.0, tier2: 1.5, tier3: 1.0, tier4: 0.5 },
  'A':  { tier1: 2.0, tier2: 1.5, tier3: 1.0, tier4: 0.5 },
  'B':  { tier1: 2.0, tier2: 1.5, tier3: 1.0, tier4: 0.5 },
}
```

### Position sizing
`size = riskAmount / SL_distance` in XAU units. Min 0.001 XAU. 4 decimal precision.
Blocked if `actualRisk > riskAmount * 1.5` (SL too wide for account).

---

## Trading Plan Schema (Zod, `src/plan/schema.js`)

```javascript
{
  timestamp, symbol, timeframe,
  bias: "bullish"|"bearish"|"neutral",
  biasReasoning: string,
  setupQuality: "A+"|"A"|"B"|"no-trade",
  confluenceCount: number,        // 0–12
  confluenceFactors: string[],
  direction: "long"|"short"|null,
  poi: { type, zone: [number,number], reasoning } | null,
  entry: { trigger: "limit"|"marketOnConfirmation", price, confirmation } | null,
  stopLoss: { price, reasoning, pips } | null,
  takeProfits: [{ level: "TP1"|"TP2"|"TP3", price, reasoning, rr }] | null,
  invalidation: { price, reasoning } | null,
  session: { current, recommendedExecutionWindow },
  risk: { suggestedRiskPct, positionSizeHint },
  macroContext: string,
  warnings: string[],
  consensus: { agreement, confidence, claudeDirection, deepseekDirection, newsRisk } | null,
  threeLayer: { tier, tierLabel, layers: { macro, flow, technical }, blockingFactors } | null,
  m15: { status: "CONFIRMED"|"PENDING"|"N/A", reason } | null,
  execution: { executed, reason, orderId, size, riskAmount, riskPct } | null,
  promptVersion: "v4.0"
}
```

---

## Environment Variables

```
# Required — Telegram
TELEGRAM_BOT_TOKEN=     # @BotFather
TELEGRAM_CHAT_ID=       # your chat ID

# Required — Hyperliquid
HL_PRIVATE_KEY=         # API wallet private key (0x + 64 hex = 66 chars)
HL_WALLET_ADDRESS=      # Main wallet address (holds USDC funds)
HL_COIN=PAXG            # Gold perpetual on Hyperliquid

# Required — LLMs
ANTHROPIC_API_KEY=      # Claude Haiku 4.5
DEEPSEEK_API_KEY=       # DeepSeek Chat
DEEPSEEK_MODEL=deepseek-chat

# Optional
PERPLEXITY_API_KEY=     # Perplexity Sonar Pro (news)
FRED_API_KEY=           # FRED macro data

# Trading config
SYMBOL=PAXG/USDC
CURRENCY=USDC
EXECUTION_TF=15min
BIAS_TF=4h
CANDLES_LOOKBACK=200
DEFAULT_RISK_PCT=1
DEFAULT_RR_MIN=2

# Execution gates
AUTO_TRADE=false        # Set true to enable order placement
DRY_EXECUTE=true        # Set false for real orders (requires AUTO_TRADE=true)

# Dev
DRY_RUN=false           # Skips Telegram + file writes

# Railway / GitHub sync
RAILWAY_PUBLIC_DOMAIN=  # e.g. xauusd-agent.up.railway.app
GITHUB_TOKEN=           # Fine-grained PAT: contents:read+write, actions:write
GITHUB_REPO=            # e.g. NmahaS/xauusd-agent
```

---

## Telegram Format

HTML parse mode. Emojis: 🟢 bullish, 🔴 bearish, ⚪ neutral, ⏸ no-trade, 🔥 kill zone, ⚠ warning.

Tier icons: ⚡ Tier 1, ✅ Tier 2, 🔵 Tier 3, 🟡 Tier 4.

Message sections:
1. Header: symbol + bias + quality + kill zone
2. Price + funding rate + oracle gap
3. Cross-asset (EUR/USD, F&G, 10Y yield)
4. Macro context
5. Confluence score + factors
6. Bias rationale
7. Consensus (agreement + Claude/DeepSeek directions)
8. Three-layer block (tier + macro/flow/technical summary)
9. POI / Entry / SL / TP1-3 / Invalidation
10. M15 status + execution result
11. Session + risk %
12. Calendar events
13. Warnings
14. Daily stats footer

---

## Commands

```bash
npm start                 # Railway production (cron + server)
npm run analyze           # Single pipeline run (respects market hours)
npm run analyze:force     # Force run ignoring market hours
npm run dry-run           # DRY_RUN=true (no Telegram, no file write)
npm run bot               # Telegram polling (dev mode)
npm run backtest          # Backtest with historical data
npm run push "message"    # Safe push (handles bot commit conflicts)
npm run setup-webhook     # Register Railway webhook with Telegram
npm test                  # Jest unit tests
```

---

## Key Rules

- All data modules are resilient: try/catch + fallback. Never crash pipeline on optional source fail.
- SMC modules are pure functions: `(candles, n) => result`. No side effects.
- Balance queries use `HL_WALLET_ADDRESS` (main wallet). `HL_PRIVATE_KEY` is for signing only.
- `withdrawable` is a top-level field in `clearinghouseState` response, not inside `marginSummary`.
- PAXG price is ~$2600–$3200 USD (tracks 1 troy oz gold). NOT a $100 asset.
- Coin fallback: always `process.env.HL_COIN || 'PAXG'`, never hardcode `'XAU'`.
- Orders use aggressive limit: LONG = markPrice × 1.003, SHORT = markPrice × 0.997.
- Never auto-execute without passing all 9 risk checks in `checkRiskRules()`.
- LLM retry: on invalid JSON, append correction nudge and retry once before returning fallback.
- If all LLMs fail, return no-trade fallback plan with error in `warnings[]`.
