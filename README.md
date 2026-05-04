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
**Generated:** 2026-05-04T12:00:00Z

- **Bias:** bullish
- **Setup Quality:** B
- **Confluence:** 4 — M15 bullish BOS confirmed at 4619.27; M15 active bullish OB at 4597.32-4604.05 (within 8pts of current); Multiple bullish M15 FVGs unfilled (4579.70-4636.80 zone); EUR/USD weakening (dollar weakness = bullish gold)
- **Session:** ny — NY kill zone active (12-15 UTC) — execute now on limit fill, but monitor RBA decision risk (+16.5h). Consider scaling position size due to macro event risk.
- **Direction:** long
- **POI:** bullish_order_block @ [4597.32, 4604.05]
- **Entry:** limit @ 4600.5 — Limit buy inside M15 OB midpoint; requires bullish candle close above 4604.05 to validate structure. NY kill zone active but RBA decision risk within 16.5 hours — consider scaling or waiting for post-RBA clarity.
- **Stop Loss:** 4589.8
- **TP1:** 4620.1 (RR 1.8)
- **TP2:** 4636.8 (RR 3.4)
- **TP3:** 4655.55 (RR 5)
- **Invalidation:** 4589

**Macro Context:** EUR/USD weakening (dollar weakness bullish for gold), but real yields rising at 1.92% (bearish headwind). RBA Cash Rate decision imminent (+990m) with forecast 4.35% vs prev 4.10% — potential AUD strength could pressure AUD gold. Fear & Greed at 40 (fear) with rising 7d trend suggests risk-on sentiment supporting gold. Macro net: mixed — dollar weakness supports longs, but rising yields and AUD event risk create headwinds.

**Warnings:**
- ⚠ RBA Cash Rate decision imminent in 16.5 hours (high-impact AUD event) — volatility and gap risk post-announcement. Consider reducing position size or waiting for post-RBA confirmation.
- ⚠ Real yields rising (1.92%) — macro bearish headwind for gold despite M15 bullish structure.
- ⚠ H4 structure neutral — M15 bullish bias is isolated technical signal without H4 directional confirmation. Tier 3 setup (technical-only).
- ⚠ M15 price currently in premium zone (67.1% of range) — entry requires pullback into OB; limit order may not fill if price continues higher.
- ⚠ Volume Profile and VWAP data unavailable — cannot confirm institutional positioning or daily anchor.
- ⚠ No H4 active OBs or recent H4 structure events — H4 bias filter is neutral, reducing setup conviction.
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
