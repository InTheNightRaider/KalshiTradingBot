# ============================================================
#  IBKR MULTI-ASSET RSI BOT — CONFIGURATION
#  Instruments: BTC Futures | Crypto Spot | Forex Majors
#  Broker: Interactive Brokers via ib_insync
# ============================================================

# ── Live / Paper Toggle ───────────────────────────────────────────────────────
# Set LIVE_TRADING = False until you're comfortable with paper results.
# NEVER flip to True without testing several weeks of paper first.
LIVE_TRADING = False          # False = paper trading (safe default)

# ── TWS / IB Gateway Connection ───────────────────────────────────────────────
# TWS Paper Trading port:   7497
# TWS Live Trading port:    7496
# IB Gateway Paper port:    4002
# IB Gateway Live port:     4001
# (IB Gateway is lighter-weight; recommended for always-on bots)
IBKR_PAPER_PORT = 7497
IBKR_LIVE_PORT  = 7496
IBKR_HOST       = '127.0.0.1'
IBKR_CLIENT_ID  = 10          # Unique per concurrent connection; change if you run multiple bots

# ── RSI Settings (matched to Kalshi bot) ─────────────────────────────────────
RSI_PERIOD     = 14
RSI_OVERSOLD   = 27           # RSI below this -> BUY signal
RSI_OVERBOUGHT = 77           # RSI above this -> SELL signal

# ── Candle / Data Settings ────────────────────────────────────────────────────
CANDLE_INTERVAL_MIN  = 15     # 15-minute candles (matches Kalshi bot)
CANDLES_TO_FETCH     = 100    # lookback window for RSI calculation
POLL_INTERVAL_SEC    = 900    # 15 min between scans (matches Kalshi bot)

# ── Position Timing ───────────────────────────────────────────────────────────
# The bot will close a position after this many seconds if it hasn't
# already been closed by a stop/target. For futures/forex, you may want
# a longer hold period than Kalshi's hourly contracts.
POSITION_DURATION_SEC = 3600  # 1 hour (adjust freely)

# ── Kelly Compound Bet Sizing ─────────────────────────────────────────────────
# These values are intentionally conservative for a new IBKR account.
STARTING_BALANCE = 10_000.0   # update to your actual account balance
KELLY_FRACTION   = 0.08       # 8% of balance per signal (conservative)
MIN_POSITION_USD = 500.0      # minimum position size in USD
MAX_POSITION_USD = 3_000.0    # hard ceiling per trade in USD

# ── Risk / Loss Limits ────────────────────────────────────────────────────────
MAX_OPEN_POSITIONS = 3        # max simultaneous open positions across all instruments
PAUSE_AFTER_LOSSES = 4        # consecutive losses before 3-hour pause
PAUSE_DURATION_HR  = 3        # hours to pause after hitting loss limit

# ── Instrument Definitions ────────────────────────────────────────────────────
# Each instrument has:
#   enabled      : toggle on/off without deleting the entry
#   type         : 'futures' | 'crypto' | 'forex'
#   symbol       : IBKR contract symbol
#   exchange     : IBKR routing exchange
#   currency     : quote currency
#   multiplier   : contract multiplier (futures only)
#   data_source  : 'kraken' (free, no auth) or 'ibkr' (needs market data sub)
#   kraken_pair  : pair name for Kraken API (when data_source == 'kraken')
#   ibkr_bar_what: what to show for IBKR historical data ('MIDPOINT', 'TRADES', etc.)

INSTRUMENTS = {

    # ── BTC Micro Futures (CME) ───────────────────────────────────────────────
    # Symbol: MBT | Size: 0.1 BTC per contract | Margin: ~$1,500–2,000/contract
    # Requires: CME futures permissions on your IBKR account
    'MBT_Futures': {
        'enabled':       True,
        'type':          'futures',
        'symbol':        'MBT',
        'exchange':      'CME',
        'currency':      'USD',
        'multiplier':    '0.1',        # 0.1 BTC per contract
        'data_source':   'kraken',
        'kraken_pair':   'XBTUSD',
    },

    # ── BTC Spot (via PAXOS) ─────────────────────────────────────────────────
    # Requires: Crypto permissions on your IBKR account
    # Note: IBKR crypto is available only in certain countries/account types
    'BTC_Spot': {
        'enabled':       True,
        'type':          'crypto',
        'symbol':        'BTC',
        'exchange':      'PAXOS',
        'currency':      'USD',
        'data_source':   'kraken',
        'kraken_pair':   'XBTUSD',
    },

    # ── ETH Spot (via PAXOS) ─────────────────────────────────────────────────
    'ETH_Spot': {
        'enabled':       True,
        'type':          'crypto',
        'symbol':        'ETH',
        'exchange':      'PAXOS',
        'currency':      'USD',
        'data_source':   'kraken',
        'kraken_pair':   'XETHZUSD',
    },

    # ── Forex Majors (IDEALPRO, min lot ~20,000 units) ────────────────────────
    # Requires: Forex trading permissions on your IBKR account
    # data_source 'ibkr' uses IBKR historical data (delayed on paper accounts)
    'EUR_USD': {
        'enabled':       True,
        'type':          'forex',
        'symbol':        'EUR',
        'exchange':      'IDEALPRO',
        'currency':      'USD',
        'data_source':   'ibkr',
        'ibkr_bar_what': 'MIDPOINT',
    },
    'GBP_USD': {
        'enabled':       True,
        'type':          'forex',
        'symbol':        'GBP',
        'exchange':      'IDEALPRO',
        'currency':      'USD',
        'data_source':   'ibkr',
        'ibkr_bar_what': 'MIDPOINT',
    },
    'USD_JPY': {
        'enabled':       True,
        'type':          'forex',
        'symbol':        'USD',
        'exchange':      'IDEALPRO',
        'currency':      'JPY',
        'data_source':   'ibkr',
        'ibkr_bar_what': 'MIDPOINT',
    },
    'AUD_USD': {
        'enabled':       False,       # disabled by default; toggle True to add
        'type':          'forex',
        'symbol':        'AUD',
        'exchange':      'IDEALPRO',
        'currency':      'USD',
        'data_source':   'ibkr',
        'ibkr_bar_what': 'MIDPOINT',
    },
}
