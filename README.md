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
**Generated:** 2026-05-04T14:00:00.927Z

- **Bias:** neutral
- **Setup Quality:** no-trade
- **Confluence:** 0 — none
- **Session:** ny — Await H4 BOS/CHoCH confirmation or H1 structure definition before entry; NY kill zone active but no valid POI within 8pts of current price
- **Direction:** no-trade

**Macro Context:** Macro neutral: COT unavailable, real yields unknown, EUR/USD flat (1.17311, -0.03% 24h), Fear & Greed at 40 (fear rising 7d) — insufficient directional bias; AUD RBA decision in ~14.5h is high-impact event risk.

**Warnings:**
- ⚠ H4 and H1 OHLC data incomplete or stale (H4 last candle 2026-03-23T21:00:00Z, >40 days old); cannot reliably assess current H4/H1 structure
- ⚠ M15 price (4651.55 AUD) is in premium zone (68.5% of range 4630.50-4661.25) but no active M15 OB within 8pts; nearest M15 FVGs are 4604.05-4609.65 and 4620.10-4636.80 (both >40pts away)
- ⚠ No H4 BOS or CHoCH event detected; H4 bias remains neutral
- ⚠ No H1 active OB or FVG; H1 structure undefined
- ⚠ COT positioning unavailable (CFTC API 404); cannot assess institutional positioning
- ⚠ Weekly VWAP and Volume Profile unavailable; institutional flow context missing
- ⚠ AUD RBA Cash Rate decision in ~14.5h (high-impact, gold-relevant for AUD pairs); recommend avoiding new entries until post-decision clarity
- ⚠ Spot gold (USD) and Au/Ag ratio unavailable; cannot cross-check spot vs futures basis
- ⚠ Real yields trend unknown; cannot assess macro headwind/tailwind for gold
- ⚠ M15 RSI divergence undefined; no momentum confirmation available
- ⚠ FRED macro data unavailable — yields/real-rate missing
- ⚠ Wide IG spread (0.80) — confirm before market orders
- ⚠ Limited history (20 H1 / 20 H4 candles) — SMC and indicators degraded
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
