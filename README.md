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
**Generated:** 2026-04-28T04:20:35.209Z

- **Bias:** neutral
- **Setup Quality:** no-trade
- **Confluence:** 0 — none
- **Session:** asia — Wait for London open (07:00 UTC) and fresh price action; avoid trading into AUD CPI event (1269m away)
- **Direction:** no-trade

**Macro Context:** EUR/USD weakening (dollar strengthening) is bearish for gold; positive real yields (1.87%) add headwind; F&G neutral at 33 (fear). High-impact AUD CPI data in ~21 hours creates event risk and invalidates stale technical setup.

**Warnings:**
- ⚠ Data is severely stale: last H1 candle is 2026-04-16T18:00Z (12 days old); no current price action to confirm H1 or H4 structure.
- ⚠ H4 and H1 SMC bias both neutral — no confirmed BOS, CHoCH, or active order blocks to trade.
- ⚠ Price in premium zone (52.5%) but no unmitigated OB nearby to anchor a short; bullish FVG above (4819.30–4829.05) is unfilled but too far and lacks confluence.
- ⚠ Bearish FVG (4791.25–4798.20) is below current price; would require a sharp drop to become a valid short entry, but no structure supports it.
- ⚠ High-impact AUD CPI data due in ~21 hours (1269m) — m/m fcst 1.3% vs prev 0.0%, y/y fcst 4.8% vs prev 3.7%. Event risk invalidates any pre-event trade.
- ⚠ EUR/USD weakening (dollar strengthening) is bearish for gold; real yields positive (1.87%) add downside pressure.
- ⚠ No RSI divergence, no kill zone active (Asia session, no London/NY yet), no macro confluence.
- ⚠ Recommend: wait for London open (07:00 UTC), refresh price data, and reassess structure post-CPI event.
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
