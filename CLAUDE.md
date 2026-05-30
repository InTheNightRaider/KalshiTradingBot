# Kalshi BTC Trading Bot — Codebase Map

Quick reference for Claude. Read this first before touching any file.

---

## What's Running Right Now

| Script | Command | Purpose |
|--------|---------|---------|
| `kalshi_btc_paper_bot.js` | `node kalshi_btc_paper_bot.js <key-id>` | **Main bot** — 4-mode BTC paper trader, scans every 30s |
| `kalshi_market_scanner.js` | `node kalshi_market_scanner.js <key-id>` | **Data collector** — top 100 contracts, tick logs every 60s (local only) |
| `master_bot.py` | `python master_bot.py` | Multi-strategy live bot (BTC/RSI live + Sports/Econ/News paper) |

Kalshi API key ID: stored in `kalshi_config.json` → field `key_id`
GitHub token: stored in `kalshi_config.json` → field `gh_token`
Kalshi UUID: `e2475509-4a0c-4beb-9d45-be55a920d057`

GitHub repos (both public, both owned by `InTheNightRaider`):
- **Bot:**       `https://github.com/InTheNightRaider/KalshiTradingBot`
- **Dashboard:** `https://github.com/InTheNightRaider/kalshi-dashboard`  (deployed to https://kalshitradingbot.netlify.app)

`tradingbot` (without `Kalshi` prefix) is **not** a real repo — earlier docs referenced it by mistake.

---

## File Map

### Bot Scripts (JS)
```
kalshi_btc_paper_bot.js   — 4-mode BTC 15-min paper bot (THE MAIN BOT)
kalshi_market_scanner.js  — standalone 100-contract tick data collector
paper_bot.js              — older paper bot (superseded by kalshi_btc_paper_bot.js)
kalshi_btc_backtest.js    — backtest runner for BTC strategies
test_kalshi.js            — API connectivity test
test_paper.js             — paper trading unit tests
```

### Bot Scripts (Python)
```
master_bot.py             — live BTC/RSI + paper Sports/Econ/News
kalshi_bot.py             — strategy classes (SportsStrategy, EconomicsStrategy, CryptoMarketStrategy, NewsStrategy)
kalshi_client.py          — Kalshi REST client (login, place_order, get_portfolio_balance, etc.)
kalshi_config.py          — Python config (balance, Kelly, intervals)
dashboard_exporter.py     — exports state to dashboard/data.json
ibkr_bot.py               — IBKR multi-asset RSI bot (BTC futures + crypto + forex via Interactive Brokers)
ibkr_config.py            — IBKR connection config
```

### Data Files (Local — NOT pushed to GitHub)
```
dashboard/btc_paper_state.json    — live bot state: mode1/2/3/4 bankroll, open positions, trade history, loss streaks
dashboard/btc_contract_log.json   — per-contract snapshots at open (0-3min), entry (5-8min), and resolution
dashboard/market_ticks.jsonl      — NEW: 100-contract tick snapshots, one JSON line per 60s scan
dashboard/btc_backtest_full.json  — full backtest results dataset
dashboard/btc_backtest_results.json — summarized backtest results
dashboard/data.json               — Python bot dashboard export
paper_trades.json                 — legacy paper trades
master_trades.csv                 — live BTC/RSI trade log
paper_trades.csv                  — paper strategy trade log
signal_log.csv                    — all signal candidates with scores/reasons
ibkr_trades_log.csv               — IBKR trade log
```

### Data Files (Pushed to GitHub)
```
dashboard/btc_paper_state.json    — pushed after every resolved trade or new entry
```

### Config
```
kalshi_config.json        — API key ID + GitHub token (NEVER commit this file)
kalshi_private_key.pem    — RSA private key for Kalshi API signing (NEVER commit)
kalshi_config.py          — Python constants (balance, Kelly fraction, intervals)
ibkr_config.py            — IBKR connection settings
```

### Dashboard (Next.js — separate repo: `InTheNightRaider/kalshi-dashboard`)
```
app/dashboard/page.tsx       — main signed-in dashboard
app/setup/page.tsx           — first-run setup wizard
app/api/user/route.ts        — GET flags + POST encrypted creds → Clerk privateMetadata
app/api/kalshi/portfolio/    — live balance via signed Kalshi request
app/api/kalshi/positions/    — live open positions
app/api/kalshi/settlements/  — historical trade settlements
app/api/scanner/             — live 7-TF confluence scanner (Binance + Kalshi)
app/api/bot/start/           — push sealed-box secrets + dispatch bot.yml on user's fork
app/api/bot/stop/            — cancel current bot.yml run
app/api/bot/status/          — read latest workflow run status
app/api/bot/state/           — read dashboard/btc_paper_state.json from user's fork
app/api/github/repos/        — list repos for fork picker during setup
lib/kalshi.ts                — RSA-PSS request signer + portfolio/markets helpers
lib/github.ts                — REST helpers + libsodium sealed-box for Actions secrets
lib/crypto.ts                — AES-256-GCM encrypt/decrypt for credentials at rest
lib/csrf.ts                  — origin-based CSRF guard on all POST routes
middleware.ts                — Clerk auth gate; everything except /sign-in /sign-up
```

---

## Deployment Architecture (multi-user)

Three moving pieces — each user's data lives in their own GitHub fork; only the UI is shared.

```
┌──────────────────────────┐
│ kalshitradingbot         │     Netlify Next.js — read-only window
│ .netlify.app             │     into the user's bot. NO bot runs here.
│ (kalshi-dashboard repo)  │
└────────────┬─────────────┘
             │ user creds encrypted with AES-256-GCM
             │ (ENCRYPTION_KEY in Netlify env, never in code)
             ▼
┌──────────────────────────┐
│ Clerk privateMetadata    │     Per-user storage. Only the server
│   - kalshiApiKey         │     can read it (private metadata),
│   - kalshiPrivateKey     │     and every field is AES-encrypted.
│   - githubPat            │
│   - githubRepo           │
└────────────┬─────────────┘
             │ /api/bot/start dispatches workflow
             │ + pushes sealed-box Actions secrets
             ▼
┌──────────────────────────┐
│ User's fork of           │     The actual bot lives here. The
│ KalshiTradingBot         │     fork should stay PUBLIC (unlimited
│   .github/workflows/     │     Actions minutes). Kalshi secrets
│     bot.yml              │     are stored as encrypted Actions
│   kalshi_btc_paper_bot.js│     secrets — private even on a public
│   dashboard/             │     repo.
│     btc_paper_state.json │
└──────────────────────────┘
```

### Lifecycle of one bot run

1. User signs in to dashboard via Clerk.
2. Dashboard `/api/user` POST encrypts Kalshi key + PEM, writes to Clerk privateMetadata.
3. User connects GitHub (fine-grained PAT scoped to ONE repo with Contents + Actions + Secrets).
4. User picks their fork of `KalshiTradingBot` from the repo list.
5. Dashboard `/api/bot/start` validates PAT scope, then:
   - libsodium sealed-box encrypts Kalshi creds against the repo's public key
   - PUTs them as `KALSHI_API_KEY` / `KALSHI_PRIVATE_KEY` Actions secrets
   - POSTs a workflow_dispatch event to `bot.yml`
6. GitHub Actions runner spins up, writes PEM to disk, runs `node kalshi_btc_paper_bot.js`.
7. Every 30s the bot scans markets; every ~90s it commits `dashboard/btc_paper_state.json` back to the user's fork (force-with-lease amend — single rolling commit, no history pollution).
8. Bot self-terminates at 5h50m; cron `0 */6 * * *` starts the next run cleanly.
9.