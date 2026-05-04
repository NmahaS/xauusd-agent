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
**Generated:** 2026-05-04T16:00:01Z

- **Bias:** bearish
- **Setup Quality:** no-trade
- **Confluence:** 0 — none
- **Session:** ny — Await M15 POI formation or H1 structure clarity; RBA decision in ~12.5h may create volatility — consider waiting for post-decision consolidation
- **Direction:** no-trade

**Macro Context:** EUR/USD weakening (dollar strengthening) is bearish for gold; real yields unknown; Fear & Greed at 40 (fear) with rising 7d trend suggests risk-on sentiment. RBA rate decision imminent (+12.5h) with AUD cash rate forecast at 4.35% vs 4.10% prev — high volatility risk. Macro backdrop neutral but event risk elevated.

**Warnings:**
- ⚠ CRITICAL: No M15 active Order Blocks within 8pts of current price (4638.05). No M15 unfilled FVGs within 8pts. Cannot establish primary entry POI per schema.
- ⚠ H1 structure undefined — no H1 OBs, FVGs, or P/D zone available. Structural context missing.
- ⚠ Market transitioning regime — SMC effective but requires higher confluence threshold (recommend 6+ factors minimum).
- ⚠ RBA rate decision in ~12.5h (AUD Cash Rate, RBA Monetary Policy Statement, RBA Press Conference). High-impact event for AUD/gold cross. Recommend waiting for post-decision consolidation or explicit M15 POI formation.
- ⚠ EUR/USD weakening (-0.22% 24h) signals dollar strength, which is bearish for gold — but macro yields/COT unknown, limiting conviction.
- ⚠ M15 last close (4638.05) is in discount zone (35.3% of 4625.38-4661.25 range), but no active M15 OB or FVG to anchor entry. Price action alone insufficient.
- ⚠ H4 bearish OB [4675.48-4772.85] is 37-135 pips above current price — too far for immediate M15 entry confluence.
- ⚠ No kill zone active (NY session but not 12-15 UTC window). Execution window suboptimal.
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
