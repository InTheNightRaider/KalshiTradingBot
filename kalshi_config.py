#!/usr/bin/env python3
"""
Kalshi Multi-Strategy Bot — Configuration
Goal: $10 -> $2,000 (bootstrap), then $1,000 -> $2,000 monthly.
"""

# ─── ACCOUNT / GOALS ─────────────────────────────────────────
STARTING_BALANCE = 10.00
TARGET_BALANCE   = 2000.00
WITHDRAW_TO      = 1000.00   # keep this as next cycle starting balance

# ─── BET SIZING (Kelly) ──────────────────────────────────────
KELLY_FRACTION       = 0.25  # fractional Kelly — 25% of full Kelly size
MIN_BET              = 0.50  # never bet less than $0.50
MAX_BET              = 75.00 # hard cap per position (rises naturally via Kelly)
MAX_OPEN_POSITIONS   = 4     # run up to 4 positions at once

# ─── STRATEGY 1: SPORTS MOMENTUM ─────────────────────────────
# Target: sports markets with YES price 65-90% (sweet spot for odds + win rate)
# Signal: price rising + above-average volume = momentum confirms
SPORTS_MIN_YES       = 0.65   # min yes_ask to consider buying YES
SPORTS_MAX_YES       = 0.90   # max yes_ask (too safe = bad risk/reward)
SPORTS_MOMENTUM_PCT  = 0.025  # price must have moved ≥2.5% in last cycle
SPORTS_MIN_VOLUME    = 500    # raised 200→500: need liquid market; avoids thin books

# ─── STRATEGY 2: ECONOMICS (Fed, CPI, NFP, Treasury) ─────────
# Target: macro markets mispriced vs Bloomberg/CME consensus
# Signal: price deviation from consensus threshold
ECON_DEVIATION       = 0.07   # 7% gap from consensus = trade trigger
ECON_MIN_VOLUME      = 500    # raised 300→500: illiquid econ markets don't reprice cleanly
ECON_KEYWORDS        = [      # market title keywords that qualify
    "fed", "rate", "fomc", "cpi", "inflation", "nfp", "jobs",
    "payroll", "gdp", "recession", "unemployment", "treasury",
    "interest rate", "basis points", "bps"
]

# Consensus estimates for major econ events (update weekly)
# Format: partial ticker keyword -> (expected_yes_prob, source_note)
ECON_CONSENSUS = {
    "fed-rate":    (0.78, "CME FedWatch June 2026"),
    "cpi":         (0.62, "Bloomberg consensus"),
    "nfp":         (0.55, "FactSet consensus"),
    "recession":   (0.30, "JPMorgan base case"),
    "unemployment":(0.58, "Consensus economics"),
}

# ─── STRATEGY 3: BTC + SPY MOMENTUM ──────────────────────────
# Pull live BTC/ETH/SPY prices and trade correlated Kalshi markets
# e.g. "Will BTC close above $X?" markets follow BTC price momentum
BTC_PRICE_URL    = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD"
ETH_PRICE_URL    = "https://api.kraken.com/0/public/Ticker?pair=ETHUSD"
SPY_PRICE_URL    = None   # use yfinance or Alpha Vantage if you add a key
CRYPTO_KEYWORDS  = ["bitcoin", "btc", "ethereum", "eth", "crypto"]
MARKET_KEYWORDS  = ["spy", "s&p", "s&p 500", "nasdaq", "stock market", "dow"]

# BTC/ETH RSI settings (same proven approach from old Polymarket bot)
RSI_PERIOD       = 14
RSI_OVERSOLD     = 32
RSI_OVERBOUGHT   = 68
CANDLE_INTERVAL  = 5    # 5-minute candles
CANDLES_TO_FETCH = 50

# ─── STRATEGY 4: NEWS RSS MOMENTUM ───────────────────────────
# Ultra-fast RSS scanner — checks every 90s for market-moving headlines
NEWS_POLL_SECONDS = 90    # how often to scan feeds
NEWS_MIN_SCORE    = 2     # keyword hits needed to fire a signal
NEWS_MAX_AGE_MINS = 5     # tightened 10→5: freshness IS the edge — stale news has no edge

# Tiered Kelly fractions by signal score strength
# Higher conviction (more keyword hits) → larger position
NEWS_KELLY_TIERS = {
    2: 0.15,   # score ±2  → cautious (threshold hit, could be noise)
    3: 0.25,   # score ±3  → standard
    4: 0.35,   # score ±4+ → high conviction (multiple independent signals)
}

RSS_FEEDS = [
    # Economics / Markets
    "https://feeds.reuters.com/reuters/businessNews",
    "https://feeds.reuters.com/reuters/topNews",
    "https://www.federalreserve.gov/feeds/press_all.xml",
    # Sports — Reuters Sports replaces ESPN (ESPN headlines too vague: "player questionable")
    "https://feeds.reuters.com/reuters/sportsNews",
    # Crypto
    "https://cointelegraph.com/rss",
    "https://coindesk.com/arc/outboundfeeds/rss/",
    # General / Breaking
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
]

# keyword -> (category, direction_multiplier)
# direction = +1 means keyword is bullish for YES, -1 means bearish
NEWS_KEYWORDS = {
    # Fed / Economics
    "rate cut":      ("economics", +1),
    "rate hike":     ("economics", -1),
    "pivot":         ("economics", +1),
    "pause":         ("economics", +1),
    "hawkish":       ("economics", -1),
    "dovish":        ("economics", +1),
    "inflation down":("economics", +1),
    "inflation up":  ("economics", -1),
    "recession":     ("economics", -1),
    "layoffs":       ("economics", -1),
    "jobs report":   ("economics",  0),  # neutral — wait for number
    "beats expectations": ("economics", +1),
    "misses expectations":("economics", -1),
    # Crypto
    "bitcoin rally": ("crypto", +1),
    "bitcoin drop":  ("crypto", -1),
    "btc":           ("crypto",  0),
    "sec approves":  ("crypto", +1),
    "sec rejects":   ("crypto", -1),
    "etf":           ("crypto", +1),
    "hack":          ("crypto", -1),
    # Sports
    "injury":        ("sports",  -1),  # star player injury = underdog favored
    "suspended":     ("sports",  -1),
    "comeback":      ("sports",   0),
    "upset":         ("sports",   0),
