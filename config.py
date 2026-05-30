# ============================================================
#  RSI TRADING BOT -- CONFIGURATION
#  Supports: Paper trading | Kalshi live trading
# ============================================================

# --- Live Trading ---
# LIVE_TRADING = False  ->  paper trading (safe, no real money)
# LIVE_TRADING = True   ->  real Kalshi orders
# KALSHI_DEMO  = True   ->  Kalshi demo environment (real orders, fake money)
# KALSHI_DEMO  = False  ->  REAL MONEY -- only flip when you're ready
LIVE_TRADING  = False
KALSHI_DEMO   = True

# --- RSI Settings ---
RSI_PERIOD      = 14    # candles for RSI calculation
RSI_OVERSOLD    = 27    # RSI below this -> bet YES  [optimized: was 30]
RSI_OVERBOUGHT  = 77    # RSI above this -> bet NO   [optimized: was 70]

# --- Signal Filters ---
MOMENTUM_FILTER = True  # RSI must be turning back before entry
CANDLE_CONFIRM  = True  # candle body must agree with signal direction

# --- Bankroll Goals ---
STARTING_BALANCE = 10.0     # starting capital (change to 1000.0 after bootstrap)
TARGET_BALANCE   = 2000.0   # trigger harvest alert and pause
WITHDRAW_TO      = 1000.0   # reset to this after withdrawing profits

# --- Kelly Compound Bet Sizing ---
KELLY_FRACTION  = 0.15      # 15% of current balance per bet
MIN_BET         = 1.00      # minimum bet ($1)
MAX_BET         = 200.00    # hard ceiling per trade

# --- Market Settings ---
SYMBOL           = "XBTUSD"  # Kraken BTC/USD pair
CANDLE_INTERVAL  = 15         # 15-minute candles
CANDLES_TO_FETCH = 100

# --- Bot Timing ---
POLL_INTERVAL_SECONDS = 900   # check every 15 min
POSITION_DURATION_SEC = 3600  # paper trade resolves after 1 hour (mirrors Kalshi hourly)
MAX_OPEN_POSITIONS    = 1     # never stack bets

# --- Kalshi Order Settings ---
KALSHI_MAX_HOURS_TO_EXPIRY = 6    # only enter markets expiring within N hours
KALSHI_MIN_HOURS_TO_EXPIRY = 0.5  # skip contracts expiring in < 30 min

# --- Misc ---
TRADE_LOG_FILE = "trades_log.csv"
SHOW_CHART     = True
