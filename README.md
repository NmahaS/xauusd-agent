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
**Generated:** 2026-05-04T13:00:00Z

- **Bias:** bullish
- **Setup Quality:** B
- **Confluence:** 5 — M15 bullish BOS confirmed at 4619.27; M15 active bullish OB at 4597.32-4604.05 within 8pts of current price; Multiple M15 bullish FVGs unfilled (4590.60-4593.95, 4604.05-4609.65, 4620.10-4636.80); EUR/USD weakening (-0.45% 24h) = dollar weakness = bullish gold; NY kill zone active (execution window optimal)
- **Session:** ny — NY kill zone 12-15 UTC — execute now on limit fill or dip-buy confirmation within OB zone
- **Direction:** long
- **POI:** bullish_order_block @ [4597.32, 4604.05]
- **Entry:** limit @ 4600.5 — Limit buy at OB midpoint (4600.50); validated by M15 bullish structure, dollar weakness via EUR/USD, and NY kill zone activity. Await M15 bullish candle close above 4604 or dip-buy confirmation within OB zone.
- **Stop Loss:** 4591.2
- **TP1:** 4620.1 (RR 2.1)
- **TP2:** 4636.8 (RR 3.9)
- **TP3:** 4672.57 (RR 9.7)
- **Invalidation:** 4591

**Macro Context:** EUR/USD weakening (dollar weakness bullish for gold), real yields rising at 1.92% (bearish headwind), Fear & Greed at 40 (fear, neutral). AUD RBA decision imminent (+930m) — high volatility risk. Yields rising is macro headwind but dollar weakness and M15 bullish structure provide tactical long opportunity in NY kill zone.

**Warnings:**
- ⚠ HIGH IMPACT: AUD RBA Cash Rate decision in ~930 minutes (2026-05-05T02:30 UTC) — extreme volatility expected; consider closing or reducing position 30min before announcement
- ⚠ Weekly macro neutral but yields rising (1.92% real yield) — bearish backdrop limits upside; TP3 may face resistance
- ⚠ H4 data sparse (last candle 2026-03-23T21:00); H1/M15 structure more reliable for this trade
- ⚠ Confluence count 5/12 = B-grade setup; not A-grade; requires strict risk discipline
- ⚠ M15 premium zone (55.3%) means price is elevated; dip-buy into OB preferred over chase entries
- ⚠ No volume profile data available; rely on SMC structure and kill zone timing
- ⚠ ✅ Consensus: Claude + DeepSeek both long
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
