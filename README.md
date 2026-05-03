# XAUUSD Day Trading Agent

Autonomous hourly XAUUSD analysis agent. Pulls data from 6 sources, computes classical indicators + Smart Money Concepts, sends analysis to **DeepSeek API** for a structured trading plan, saves to git, and delivers via **Telegram**.

Hosted on **GitHub Actions** (free serverless cron). No server, no database.

> **DISCLAIMER:** This tool is for educational and decision-support purposes only. It does not execute trades. See [DISCLAIMER.md](DISCLAIMER.md) for full risk disclosure.

---

## Setup

### 1. Fork & clone this repository

```bash
git clone https://github.com/YOUR_USERNAME/xauusd-agent.git
cd xauusd-agent
npm install
```

### 2. Configure secrets in GitHub

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|---|---|
| `TWELVEDATA_API_KEY` | [twelvedata.com](https://twelvedata.com) free API key |
| `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com) API key |
| `TELEGRAM_BOT_TOKEN` | Create a bot via [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID (message [@userinfobot](https://t.me/userinfobot)) |
| `FRED_API_KEY` | (Optional) [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html) |
| `METALPRICE_API_KEY` | (Optional) [metalpriceapi.com](https://metalpriceapi.com) |
| `METALSDEV_API_KEY` | (Optional) [metals.dev](https://metals.dev) |

### 3. Enable GitHub Actions

Actions run automatically at `:05` past every hour during gold market hours (Sun 22:00 – Fri 22:00 UTC). Trigger manually via **Actions → Hourly XAUUSD Analysis → Run workflow**.

### 4. Local development

```bash
cp .env.example .env
# Fill in your keys in .env

npm run analyze      # Full run
npm run dry-run      # No Telegram, no file write
npm test             # Run tests
```

---

## How It Works

Each run (~60 seconds):

1. Fetches XAU/USD H1 + H4 candles, DXY, Silver from TwelveData
2. Fetches spot metals prices (MetalpriceAPI → Metals.dev → fallback)
3. Fetches macro data from FRED (10Y yield, Fed rate, breakeven)
4. Fetches Fear & Greed index from Alternative.me
5. Fetches economic calendar from ForexFactory
6. Computes EMA 20/50/200, RSI 14, ATR 14, MACD
7. Detects SMC: BOS/CHoCH, order blocks, FVGs, liquidity pools, premium/discount zones
8. Sends structured prompt to DeepSeek API
9. Validates JSON response with Zod schema
10. Saves plan to `plans/YYYY-MM-DD/HH.json`
11. Updates this README with latest plan
12. Sends formatted analysis to Telegram
13. Commits and pushes to git

---

## Latest Plan

<!-- LATEST_PLAN_START -->
**Generated:** 2026-05-01T01:26:03.300Z

- **Bias:** bearish
- **Setup Quality:** B
- **Confluence:** 3 — H1 bearish structure (CHoCH-bearish @ 4621.28); Price in premium zone (79% of range); Positive real yields (1.96%) bearish for gold
- **Session:** asia — Wait for London kill zone (07:00 UTC) for optimal execution; current Asia session has low liquidity.
- **Direction:** short
- **POI:** bearish_structure_premium_zone @ [4638.32, 4643.19]
- **Entry:** limit @ 4641 — Limit sell at midpoint of OTE short zone; validated by H1 bearish CHoCH and premium zone positioning. Await London kill zone (07:00 UTC) for execution confirmation.
- **Stop Loss:** 4650.5
- **TP1:** 4625 (RR 1.7)
- **TP2:** 4610 (RR 3.3)
- **TP3:** 4595 (RR 4.8)
- **Invalidation:** 4650.5

**Macro Context:** Positive real yields (1.96%) and rising 10Y yield (4.420%) are bearish for gold; Fear & Greed at 26 (fear) is neutral; DXY and EUR/USD data unavailable, but macro backdrop supports gold weakness.

**Warnings:**
- ⚠ H4 bias is neutral with no active structure — confluence is weak (only 3 factors). Trade is B-grade setup; consider waiting for stronger H4 confirmation or additional H1 confluence.
- ⚠ H4 data unavailable (no candles provided); cannot confirm multi-timeframe alignment. Execution risk elevated.
- ⚠ ISM Manufacturing PMI and Prices due in ~754 minutes (high-impact USD data); avoid holding through this event.
- ⚠ No active H1 order blocks or unfilled FVGs near entry — entry is based on OTE zone and premium positioning only.
- ⚠ Asia session liquidity is low; execution may be slippage-prone. Strongly recommend waiting for London open (07:00 UTC).
- ⚠ ✅ Consensus: Claude + DeepSeek both short
- ⚠ DXY proxy unavailable — cross-asset context reduced
- ⚠ Wide IG spread (0.80) — confirm before market orders
<!-- LATEST_PLAN_END -->

---

## Tech Stack

- **Runtime:** Node.js 20+ (ES modules)
- **Hosting:** GitHub Actions cron
- **LLM:** DeepSeek API (`deepseek-chat`)
- **Market data:** TwelveData REST API
- **Macro data:** FRED API
- **Sentiment:** Alternative.me Fear & Greed
- **Calendar:** ForexFactory via faireconomy mirror
- **Metals:** MetalpriceAPI / Metals.dev / TwelveData fallback
- **Storage:** JSON files committed to repo (`plans/`)
- **Notifications:** Telegram Bot API
- **Validation:** Zod

---

## Cost Estimate

~$0.001 per run × 24 runs/day = **~$0.024/day** (DeepSeek only). All other APIs are free tier.

---

## License

MIT — see [DISCLAIMER.md](DISCLAIMER.md) for risk warnings.
