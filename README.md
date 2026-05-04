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
**Generated:** 2026-05-04T10:00:00Z

- **Bias:** bullish
- **Setup Quality:** B
- **Confluence:** 4 — M15 bullish BOS confirmed at 4583.90; M15 active bullish OB [4573.00-4579.70] unmitigated; M15 bullish FVGs unfilled [4579.70-4581.15] and [4590.60-4593.95]; London kill zone active (current session)
- **Session:** london — London kill zone 07-10 UTC — execute on limit fill; monitor RBA decision risk at +1110m (high impact on AUD/gold correlation).
- **Direction:** long
- **POI:** bullish_order_block @ [4573, 4579.7]
- **Entry:** limit @ 4576.35 — Limit buy at OB midpoint; wait for M15 pullback into zone with bullish candle close above 4579.70 to confirm continuation.
- **Stop Loss:** 4568.5
- **TP1:** 4593.95 (RR 2.2)
- **TP2:** 4610 (RR 4.2)
- **TP3:** 4630 (RR 7.7)
- **Invalidation:** 4572

**Macro Context:** Real yields rising (1.92%, bearish gold), EUR/USD flat (neutral dollar), Fear & Greed at 40 (fear, neutral). RBA decision in ~18.5 hours is high-impact catalyst for AUD/gold; rising yields are headwind but M15 structure remains bullish.

**Warnings:**
- ⚠ Market transitioning regime — confluence score 4/12 is below A-grade threshold; treat as tactical setup only.
- ⚠ RBA Cash Rate decision imminent (+1110m) — high volatility risk; consider reducing position size or waiting for post-decision clarity.
- ⚠ H4 bias is neutral; this is M15 structure-only signal (Tier 3). Macro backdrop (rising yields) conflicts with bullish technicals.
- ⚠ No H1 OBs or FVGs available; H1 context missing — reduces structural confirmation.
- ⚠ Price in premium zone (63% of range) — typically higher-risk entry; prefer discount zone entries for long bias.
- ⚠ Volume Profile and VWAP data unavailable — institutional flow confirmation missing.
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
