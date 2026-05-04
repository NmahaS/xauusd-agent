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
**Generated:** 2026-05-04T11:00:00Z

- **Bias:** bullish
- **Setup Quality:** B
- **Confluence:** 4 — M15 impulsive bullish structure (broke swing high 4619.27 to 4668.2); Price in premium zone but from deep discount base (mean reversion potential); EUR/USD weakening (dollar weakness = bullish gold); Multiple unfilled M15 bullish FVGs in 4579-4636 zone (support/retest targets)
- **Session:** london — London kill zone 07-10 UTC has passed; current time 11:00 UTC is post-London. Recommend execution on limit fill at 4628.45 during next London session (tomorrow 07-10 UTC) or if price retraces into FVG zone during Asian/early London hours today. RBA decision at +1050m (approx 22:10 UTC) may cause volatility; consider scaling in before announcement or waiting for post-announcement consolidation.
- **Direction:** long
- **POI:** bullish_fvg_retest @ [4620.1, 4636.8]
- **Entry:** limit @ 4628.45 — Limit buy at FVG midpoint (4628.45) on retest. Confirm with bullish M15 candle close above 4620 (FVG low) or bullish engulfing pattern inside FVG zone. Alternative: market entry on break above 4640 if FVG retest fails and price continues higher.
- **Stop Loss:** 4609.65
- **TP1:** 4668.2 (RR 2.1)
- **TP2:** 4690 (RR 3.2)
- **TP3:** 4730 (RR 5.4)
- **Invalidation:** 4609.65

**Macro Context:** Real yields rising (1.92%) and positive = bearish headwind for gold; however, EUR/USD weakening (dollar weakness) and F&G at 40 (fear) with rising 7d trend = emerging risk-on sentiment. RBA decision imminent (+1050m) introduces AUD volatility; potential rate hold or cut would weaken AUD = bullish for AUD gold. Macro is mixed; technical setup is bullish but requires higher confluence due to positive real yields.

**Warnings:**
- ⚠ Confluence score is B (4 factors) — below A threshold. Macro headwind (positive real yields 1.92%) is significant bearish factor not fully offset by technical setup.
- ⚠ RBA decision imminent (+1050m / 22:10 UTC approx). High-impact event may cause slippage or gap fills. Consider waiting for post-announcement consolidation or scaling position size to 0.5% risk.
- ⚠ H4 and H1 indicators unavailable (n/a) — unable to confirm higher-timeframe bias. Relying on M15 structure and price action alone. Recommend manual H4/H1 chart review before entry.
- ⚠ M15 ATR unavailable — stop sized at FVG extreme (4609.65) rather than ATR-adjusted. Actual volatility may differ; monitor for wider stops if ATR is elevated.
- ⚠ Price is in premium zone (205.7% of M15 range 4573-4619.27) — extended from mean. Reversion risk exists; FVG retest may fail and price could drop sharply. Tight stop (19 pips) is appropriate but limits RR.
- ⚠ No volume profile or VWAP data — unable to confirm institutional positioning or fair value. Proceed with caution.
- ⚠ Entry at 4628.45 is a retest of already-broken FVG; confirmation candle required. Do not chase if price gaps above FVG without retesting.
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
