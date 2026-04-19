# XAUUSD Day Trading Agent

Autonomous hourly XAUUSD analysis agent. Pulls data from 6 sources, computes classical indicators + Smart Money Concepts, sends analysis to **DeepSeek API** for a structured trading plan, saves to git, and delivers via **Telegram**.

Hosted on **GitHub Actions** (free serverless cron). No server, no database.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (ES modules) |
| Hosting | GitHub Actions cron `5 * * * *` |
| LLM | **DeepSeek API** (`deepseek-chat` model, OpenAI-compatible) |
| Market data | TwelveData REST API (free tier) |
| Macro data | FRED API (free) |
| Sentiment | Alternative.me Fear & Greed (free, no key) |
| Calendar | ForexFactory via faireconomy mirror (free, no key) |
| Metals | MetalpriceAPI / Metals.dev / TwelveData fallback |
| Storage | JSON files committed to repo (`plans/`) |
| Notifications | Telegram Bot API |
| Validation | Zod |

---

## Directory Structure

```
xauusd-agent/
├── CLAUDE.md
├── README.md
├── DISCLAIMER.md
├── package.json
├── .env.example
├── .gitignore
├── .github/workflows/analyze.yml
├── src/
│   ├── run.js                    # Entry: runs pipeline once, exits
│   ├── config.js                 # Zod-validated env vars
│   ├── pipeline.js               # Orchestrator
│   ├── utils/
│   │   └── marketHours.js        # Exit 1 if gold market closed
│   ├── data/
│   │   ├── twelvedata.js         # XAU/USD H1+H4 candles
│   │   ├── dxy.js                # DXY (dollar index) candles
│   │   ├── metals.js             # Au/Ag/Pt spot: MetalpriceAPI → Metals.dev → TwelveData
│   │   ├── fred.js               # US 10Y yield, Fed rate, real yields
│   │   ├── sentiment.js          # Fear & Greed index
│   │   └── calendar.js           # ForexFactory economic calendar
│   ├── indicators/
│   │   ├── classical.js          # EMA 20/50/200, RSI 14, ATR 14, MACD
│   │   └── session.js            # Asia/London/NY sessions + kill zones
│   ├── smc/
│   │   ├── swings.js             # Pivot high/low detection
│   │   ├── structure.js          # BOS / CHoCH (market structure)
│   │   ├── orderBlocks.js        # Bullish/bearish order blocks
│   │   ├── fvg.js                # Fair Value Gaps (imbalances)
│   │   ├── liquidity.js          # EQH/EQL pools + session liquidity
│   │   └── premiumDiscount.js    # Premium/discount zones + OTE
│   ├── llm/
│   │   ├── client.js             # DeepSeek API client (OpenAI-compatible)
│   │   └── prompt.js             # System + user prompt builders
│   ├── plan/
│   │   ├── schema.js             # Zod schema for trading plan
│   │   ├── writer.js             # Save JSON + update README
│   │   └── formatter.js          # Plan → Telegram HTML
│   └── telegram/
│       └── notify.js             # Send via Bot API
├── plans/
│   └── .gitkeep
└── tests/
    ├── smc.test.js
    ├── indicators.test.js
    └── fixtures/sampleCandles.js
```

---

## DeepSeek API Integration (`src/llm/client.js`)

DeepSeek uses the **OpenAI-compatible** chat completions endpoint. Do NOT use the Anthropic SDK.

```
POST https://api.deepseek.com/chat/completions
Headers:
  Authorization: Bearer <DEEPSEEK_API_KEY>
  Content-Type: application/json

Body:
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "max_tokens": 4000,
  "temperature": 0.3,
  "response_format": { "type": "json_object" }
}
```

Response shape:
```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "{ ... json string ... }"
      }
    }
  ]
}
```

Extract with: `JSON.parse(data.choices[0].message.content)`

Key differences from Claude/OpenAI:
- Base URL: `https://api.deepseek.com` (not openai.com)
- Use `response_format: { type: "json_object" }` for guaranteed JSON output
- Use `temperature: 0.3` for consistent analytical output
- Model: `deepseek-chat` (their flagship, very cheap ~$0.001/run)
- Do NOT install any SDK — use plain `fetch()` to the endpoint above
- The env var is `DEEPSEEK_API_KEY` (not ANTHROPIC or OPENAI)

---

## Environment Variables

```
# Required
TWELVEDATA_API_KEY=         # Market data (candles, DXY, silver)
DEEPSEEK_API_KEY=           # LLM analysis
DEEPSEEK_MODEL=deepseek-chat
TELEGRAM_BOT_TOKEN=         # Bot from @BotFather
TELEGRAM_CHAT_ID=           # Your chat ID

# Optional (enhance analysis quality)
FRED_API_KEY=               # Federal Reserve macro data
METALPRICE_API_KEY=         # metalpriceapi.com spot prices
METALSDEV_API_KEY=          # metals.dev spot prices

# Trading config
SYMBOL=XAU/USD
EXECUTION_TF=1h
BIAS_TF=4h
CANDLES_LOOKBACK=200
DEFAULT_RISK_PCT=1
DEFAULT_RR_MIN=2

# Dev
DRY_RUN=false
```

---

## GitHub Actions Workflow (`.github/workflows/analyze.yml`)

```yaml
name: Hourly XAUUSD Analysis

on:
  schedule:
    - cron: '5 * * * *'
  workflow_dispatch:

concurrency:
  group: xauusd-analysis
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - name: Check market hours
        id: market
        continue-on-error: true
        run: node src/utils/marketHours.js
      - name: Run analysis
        if: steps.market.outcome == 'success'
        env:
          TWELVEDATA_API_KEY: ${{ secrets.TWELVEDATA_API_KEY }}
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          DEEPSEEK_MODEL: deepseek-chat
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          FRED_API_KEY: ${{ secrets.FRED_API_KEY }}
          METALPRICE_API_KEY: ${{ secrets.METALPRICE_API_KEY }}
          METALSDEV_API_KEY: ${{ secrets.METALSDEV_API_KEY }}
        run: node src/run.js
      - name: Commit plan
        if: steps.market.outcome == 'success'
        run: |
          git config user.name "xauusd-bot"
          git config user.email "bot@users.noreply.github.com"
          git add plans/ README.md
          git diff --staged --quiet || git commit -m "plan: $(date -u +'%Y-%m-%d %H:00 UTC')"
          git push
```

---

## Data Flow Per Run

```
[GitHub Actions :05 UTC]
  │
  ├── 1. TwelveData: XAU H1 (200) + XAU H4 (200) + DXY H1 (50) + XAG H1 (24)
  ├── 2. MetalpriceAPI/Metals.dev: XAU+XAG+XPT spot → Au/Ag + Au/Pt ratio
  ├── 3. FRED: 10Y yield + Fed rate + breakeven → real yield
  ├── 4. Alternative.me: Fear & Greed 0-100 + 7-day trend
  ├── 5. ForexFactory: next 24h events, gold-relevant filter
  │     (all fetched in parallel via Promise.all)
  │
  ├── Classical: EMA 20/50/200, RSI 14 (+divergence), ATR 14, MACD
  ├── SMC: swings → structure (BOS/CHoCH) → OBs → FVGs → liquidity → P/D
  │
  ├── Build prompt with 4 sections:
  │     Section 1: H4+H1 price structure + indicators + SMC
  │     Section 2: Cross-asset (DXY, Au/Ag, Au/Pt, spot vs chart)
  │     Section 3: Macro (yields, real rate, sentiment)
  │     Section 4: Calendar (upcoming events + auto-warnings)
  │
  ├── POST to DeepSeek API → JSON trading plan
  ├── Validate with Zod → retry once if invalid
  │
  ├── Save plans/YYYY-MM-DD/HH.json
  ├── Update README.md "Latest Plan"
  ├── Send Telegram HTML message
  └── Commit + push
```

---

## 6 Data Source Modules

### 1. TwelveData (`src/data/twelvedata.js`)
- Fetch `XAU/USD` time_series for H1 and H4
- Parse: reverse to chronological, parseFloat all OHLCV fields
- Endpoint: `GET https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1h&outputsize=200&apikey=KEY&timezone=UTC`

### 2. DXY (`src/data/dxy.js`)
- Fetch `DXY` time_series H1 (50 candles) from TwelveData
- Compute: trend (strengthening/weakening), 24h change%, gold correlation signal
- DXY strengthening = bearish for gold, weakening = bullish

### 3. Metals (`src/data/metals.js`)
- Cascade: try MetalpriceAPI → Metals.dev → TwelveData XAG/USD fallback
- MetalpriceAPI: `GET https://api.metalpriceapi.com/v1/latest?api_key=KEY&base=USD&currencies=XAU,XAG,XPT`
  - Rates are inverted: gold price = 1 / rates.USDXAU
- Metals.dev: `GET https://api.metals.dev/v1/latest?api_key=KEY&currency=USD&unit=toz`
  - Prices in `data.metals.gold`, `.silver`, `.platinum`
- Compute: Au/Ag ratio (normal 60-70, >80 = gold extended), Au/Pt ratio, spot vs chart gap

### 4. FRED (`src/data/fred.js`)
- 3 series: DGS10 (10Y yield), FEDFUNDS, T10YIE (breakeven inflation)
- `GET https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=KEY&file_type=json&sort_order=desc&limit=30`
- Compute: real yield = 10Y - breakeven, yield trend (rising/falling/stable), gold impact

### 5. Sentiment (`src/data/sentiment.js`)
- No key needed: `GET https://api.alternative.me/fng/?limit=7&format=json`
- Returns value 0-100 (0=extreme fear, 100=extreme greed)
- Gold impact: extreme fear = bullish (safe haven), extreme greed = bearish

### 6. Calendar (`src/data/calendar.js`)
- No key needed: `GET https://nfs.faireconomy.media/ff_calendar_thisweek.json`
- Filter: next 24h, high/medium impact only
- Gold-relevant keywords: nfp, cpi, ppi, fomc, rate decision, powell, pce, jobless, gdp, ism, inflation
- Auto-warning if gold-relevant event within 2 hours

---

## SMC Detection Rules

### Swings (`src/smc/swings.js`)
- Pivot high at `i`: `high[i] > all highs in [i-n..i-1]` AND `high[i] > all highs in [i+1..i+n]`
- n=5 for H1, n=3 for H4. Return `[{index, time, price, type}]`

### Structure (`src/smc/structure.js`)
- Track swing sequence. Bullish BOS = break above swing high in uptrend. CHoCH = break against trend.
- Output: `{bias, lastEvent, eventCandle, brokenLevel}`

### Order Blocks (`src/smc/orderBlocks.js`)
- Bullish OB: last down-close candle before impulsive up-move causing BOS. Zone=[low,high].
- Must contain ≥1 FVG in the impulse. Active = not traded through. Top 3 by proximity.

### FVG (`src/smc/fvg.js`)
- Bullish: `candles[i+1].low > candles[i-1].high`. Bearish: inverse. Unfilled = midpoint not revisited.

### Liquidity (`src/smc/liquidity.js`)
- EQH: ≥2 swing highs within 0.2×ATR. EQL: mirror. Track if swept.

### Premium/Discount (`src/smc/premiumDiscount.js`)
- Range from recent swing low to high. Discount=0-50%, Premium=50-100%, OTE=fib 0.618-0.786.

---

## Classical Indicators (`src/indicators/classical.js`)
- EMA 20/50/200, RSI 14 (with divergence detection), ATR 14, MACD (12,26,9)
- Use `technicalindicators` npm package

## Sessions (`src/indicators/session.js`)
- Asia 00-07 UTC, London 07-12, NY 12-17, Off 17-00
- Kill zones: London 07-10, NY 12-15

---

## Trading Plan Schema (Zod)

```javascript
{
  timestamp, symbol, timeframe,
  bias: "bullish"|"bearish"|"neutral",
  biasReasoning: string,
  setupQuality: "A+"|"A"|"B"|"no-trade",
  confluenceCount: number,
  confluenceFactors: string[],
  direction: "long"|"short"|null,
  poi: { type, zone: [number,number], reasoning } | null,
  entry: { trigger: "limit"|"marketOnConfirmation", price, confirmation } | null,
  stopLoss: { price, reasoning, pips } | null,
  takeProfits: [{ level, price, reasoning, rr }] | null,
  invalidation: { price, reasoning } | null,
  session: { current, recommendedExecutionWindow },
  risk: { suggestedRiskPct, positionSizeHint },
  macroContext: string,
  warnings: string[],
  promptVersion: "v2.0"
}
```

---

## Telegram Format
HTML parse mode with emojis: 🟢 bullish, 🔴 bearish, ⚪ neutral, ⏸ no-trade, 🔥 kill zone.
Include: header, bias, macro context line, cross-asset line (DXY/Au-Ag/Au-Pt/F&G/10Y), confluence score, POI/entry/SL/TP1-3/invalidation, warnings, upcoming calendar events.

---

## Commands

```bash
npm run analyze      # Full run (uses .env)
npm run dry-run      # DRY_RUN=true — no Telegram, no file write
npm test             # Jest
```

---

## Build Order

1. Scaffold: package.json, .env.example, .gitignore, folder structure, plans/.gitkeep
2. src/config.js — Zod env validation
3. src/utils/marketHours.js — market open/close guard
4. src/data/twelvedata.js — fetch XAU candles, verify with dry print
5. src/data/dxy.js — fetch DXY
6. src/data/metals.js — cascade MetalpriceAPI → Metals.dev → TwelveData
7. src/data/fred.js — fetch 10Y, Fed rate, breakeven
8. src/data/sentiment.js — fetch Fear & Greed
9. src/data/calendar.js — fetch ForexFactory
10. src/indicators/classical.js — EMA/RSI/ATR/MACD
11. src/indicators/session.js — session detection + levels
12. src/smc/* — swings → structure → fvg → orderBlocks → liquidity → premiumDiscount
13. src/llm/prompt.js — system + user prompt templates
14. src/llm/client.js — DeepSeek fetch + JSON parse + retry
15. src/plan/schema.js — Zod schema
16. src/plan/writer.js — save JSON + update README
17. src/plan/formatter.js — Telegram HTML format
18. src/telegram/notify.js — Bot API sender
19. src/pipeline.js — wire everything: fetch all → compute → LLM → save → notify
20. src/run.js — entry point (import pipeline, run, exit)
21. .github/workflows/analyze.yml — cron workflow
22. tests/ — SMC + indicators tests with fixtures
23. README.md + DISCLAIMER.md

---

## Key Rules

- All data modules are resilient: try/catch + fallback. Never crash the pipeline because one optional source fails.
- SMC modules are pure functions: `(candles) => result`. No side effects.
- DeepSeek client retries once on invalid JSON with a correction nudge appended.
- If DeepSeek fails entirely, return a no-trade fallback plan with error in warnings.
- Market hours guard: gold trades Sun 22:00 UTC → Fri 22:00 UTC. Skip weekend runs.
- Never auto-execute trades. This is decision support only.
