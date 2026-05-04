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
**Generated:** 2026-05-04T22:00:00Z

- **Bias:** bearish
- **Setup Quality:** no-trade
- **Confluence:** 0 — none
- **Session:** off — Wait for next London kill zone (07–10 UTC on 2026-05-05) after RBA decision impact clears
- **Direction:** no-trade

**Macro Context:** Positive real yields (1.89%) and stable DXY provide bearish macro backdrop for gold; however, RBA Cash Rate decision (+390m) and RBA Press Conference (+450m) create extreme event risk within next 7 hours — gold AUD will be volatile on AUD rate expectations.

**Warnings:**
- ⚠ CRITICAL: RBA Cash Rate decision and Press Conference scheduled in ~6.5 hours (2026-05-05T04:30 UTC). High-impact AUD event will drive XAU/AUD volatility; no trade should be entered until post-event consolidation.
- ⚠ M15 and H1 structure data unavailable (all indicators n/a). Cannot identify M15 OBs, FVGs, or CHoCH signals required for entry confirmation.
- ⚠ Market transitioning regime — confluence threshold raised; require ≥6 factors minimum for any trade setup.
- ⚠ H4 bearish bias is clear, but without M15 POI within 8 pips of current price (4624.4), no executable short setup exists.
- ⚠ Current session is 'off' (22:00 UTC on 2026-05-04). Next London kill zone begins 2026-05-05T07:00 UTC, but RBA event at 04:30 UTC will precede it.
- ⚠ Recommend: Monitor RBA outcome, wait for post-decision price consolidation on M15, then re-assess for short entry into H4 bearish OB (4675–4772) or long entry into H4 discount zone if RBA dovish surprise occurs.
- ⚠ IG market status EDITS_ONLY — pre-open / closed window. Data is valid; execution restricted until open.
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
