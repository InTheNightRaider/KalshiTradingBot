#!/usr/bin/env python3
"""
IBKR Multi-Asset RSI Trading Bot
=================================
Trades BTC Micro Futures, BTC/ETH Crypto Spot, and Forex Majors via
Interactive Brokers using the same RSI strategy as the Kalshi bot.

REQUIREMENTS
  pip install ib_insync pandas requests

BEFORE RUNNING
  1. Open TWS (Trader Workstation) or IB Gateway on your machine
  2. In TWS: File > Global Configuration > API > Settings
       - Enable "Active X and Socket Clients"
       - Set port to 7497 (paper) or 7496 (live)
       - Uncheck "Read-Only API" if you want to place orders
  3. Make sure ibkr_config.py has LIVE_TRADING = False for paper mode
  4. Run:  python ibkr_bot.py

IBKR ACCOUNT SETUP (if you haven't opened one yet)
  - Sign up at interactivebrokers.com — paper trading available immediately
  - For MBT Futures: request CME futures permissions in Account Management
  - For Forex: request Forex trading permissions
  - For Crypto (PAXOS): request Crypto permissions (limited by country)

INSTRUMENT NOTES
  MBT Futures : 0.1 BTC per contract | Margin ~$1,500-2,000 | CME quarterly expiry
  BTC/ETH Spot: Via PAXOS exchange | Fractional amounts supported
  Forex       : Via IDEALPRO | Min 20,000 units of base currency
"""

import sys
import time
import csv
import logging
from datetime import datetime, timedelta
from typing import Optional, Tuple, Dict

import pandas as pd
import requests

try:
    from ib_insync import IB, Contract, Future, Forex, MarketOrder, util
except ImportError:
    print("ERROR: ib_insync not installed.")
    print("Run: pip install ib_insync")
    sys.exit(1)

from ibkr_config import (
    LIVE_TRADING, IBKR_HOST, IBKR_PAPER_PORT, IBKR_LIVE_PORT, IBKR_CLIENT_ID,
    RSI_PERIOD, RSI_OVERSOLD, RSI_OVERBOUGHT,
    CANDLE_INTERVAL_MIN, CANDLES_TO_FETCH, POLL_INTERVAL_SEC,
    POSITION_DURATION_SEC, STARTING_BALANCE,
    KELLY_FRACTION, MIN_POSITION_USD, MAX_POSITION_USD,
    MAX_OPEN_POSITIONS, PAUSE_AFTER_LOSSES, PAUSE_DURATION_HR,
    INSTRUMENTS,
)

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-7s  %(message)s',
    datefmt='%H:%M:%S',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('ibkr_bot_log.txt', encoding='utf-8'),
    ],
)
log = logging.getLogger(__name__)

TRADE_LOG = 'ibkr_trades_log.csv'


# ── Contract Builders ─────────────────────────────────────────────────────────

def _front_quarter_month() -> str:
    """Return the nearest quarterly CME expiry at least 7 days out (YYYYMM)."""
    now = datetime.utcnow()
    for month in [3, 6, 9, 12]:
        for year in [now.year, now.year + 1]:
            exp = datetime(year, month, 1)
            if exp > now + timedelta(days=7):
                return exp.strftime('%Y%m')
    return datetime(now.year + 1, 3, 1).strftime('%Y%m')


def build_contract(name: str, cfg: dict) -> Contract:
    """Build the right IBKR Contract object from instrument config."""
    kind = cfg['type']
    if kind == 'futures':
        month = _front_quarter_month()
        c = Future(
            symbol=cfg['symbol'],
            lastTradeDateOrContractMonth=month,
            exchange=cfg['exchange'],
            currency=cfg['currency'],
        )
        c.multiplier = cfg.get('multiplier', '1')
        return c
    elif kind == 'crypto':
        c = Contract()
        c.secType  = 'CRYPTO'
        c.symbol   = cfg['symbol']
        c.exchange = cfg['exchange']
        c.currency = cfg['currency']
        return c
    elif kind == 'forex':
        # Forex pair: symbol is the base currency, currency is the quote
        return Forex(cfg['symbol'] + cfg['currency'])
    else:
        raise ValueError(f"Unknown instrument type '{kind}' for {name}")


# ── Data Fetching ─────────────────────────────────────────────────────────────

def fetch_kraken_candles(pair: str, interval: int = 15, limit: int = 100) -> Optional[pd.DataFrame]:
    """Fetch OHLCV from Kraken public API (no API key needed)."""
    url = 'https://api.kraken.com/0/public/OHLC'
    try:
        resp = requests.get(url, params={'pair': pair, 'interval': interval}, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if data.get('error'):
            log.warning(f"Kraken API error for {pair}: {data['error']}")
            return None
        pair_key = [k for k in data['result'] if k != 'last'][0]
        raw = data['result'][pair_key][-limit:]
        df = pd.DataFrame(raw, columns=[
            'open_time', 'open', 'high', 'low', 'close', 'vwap', 'volume', 'count'
        ])
        for col in ['open', 'high', 'low', 'close']:
            df[col] = df[col].astype(float)
        df['open_time'] = pd.to_datetime(df['open_time'], unit='s')
        return df
    except Exception as e:
        log.error(f"Kraken fetch error for {pair}: {e}")
        return None


def fetch_ibkr_candles(ib: IB, contract: Contract, cfg: dict,
                        interval_min: int = 15, limit: int = 100) -> Optional[pd.DataFrame]:
    """
    Fetch OHLCV from IBKR historical data.
    Paper accounts get 15-20 minute delayed data — fine for RSI on 15-min candles.
    """
    # Duration string: fetch enough bars to cover our limit
    duration = f'{max(2, limit // 96 + 1)} D'
    bar_size  = f'{interval_min} mins'
    what_show = cfg.get('ibkr_bar_what', 'MIDPOINT')
    try:
        bars = ib.reqHistoricalData(
            contract,
            endDateTime='',
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow=what_show,
            useRTH=False,
            formatDate=1,
            keepUpToDate=False,
        )
        if not bars:
            log.warning(f"No IBKR historical data returned for {contract.symbol}")
            return None
        df = util.df(bars)
        df = df.rename(columns={'open': 'open', 'high': 'high',
                                 'low': 'low', 'close': 'close'})
        return df.tail(limit).reset_index(drop=True)
    except Exception as e:
        log.error(f"IBKR historical data error for {contract.symbol}: {e}")
        return None


# ── RSI + Signal Engine (same logic as Kalshi bot) ───────────────────────────

def calculate_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta    = series.diff()
    gain     = delta.clip(lower=0)
    loss     = (-delta).clip(lower=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs       = avg_gain / avg_loss.replace(0, float('nan'))
    return 100 - (100 / (1 + rs))


def calculate_sma(series: pd.Series, period: int = 50) -> pd.Series:
    return series.rolling(window=period, min_periods=period).mean()


def get_signal(df: pd.DataFrame) -> Optional[Tuple[str, float]]:
    """
    Returns ('BUY', confidence) or ('SELL', confidence) or None.
    confidence is 1.0 for with-trend, 0.5 for counter-trend / capitulation.

    Filters applied (same as Kalshi bot):
      1. RSI threshold (oversold / overbought)
      2. Momentum filter — RSI must be turning back toward neutral
      3. Candle confirmation — candle body agrees with signal direction
      4. SMA trend filter — counter-trend signals get 0.5x Kelly
      5. Capitulation bounce — extreme RSI + 3 consecutive rising RSI candles
    """
    if len(df) < max(RSI_PERIOD + 1, 52):
        return None

    rsi   = calculate_rsi(df['close'], RSI_PERIOD)
    sma   = calculate_sma(df['close'], 50)

    if rsi.isna().iloc[-1]:
        return None

    rsi_now   = rsi.iloc[-1]
    rsi_prev  = rsi.iloc[-2]
    sma_now   = sma.iloc[-1]
    price_now = df['close'].iloc[-1]
    is_green  = df['close'].iloc[-1] > df['open'].iloc[-1]

    # ── Capitulation bounce ────────────────────────────────────────────────
    CAPITULATION_RSI = 22
    if rsi_now < CAPITULATION_RSI and len(rsi) >= 3:
        r = list(rsi.tail(3))
        if r[2] > r[1] > r[0]:
            return ('BUY', 0.5)  # half-Kelly, counter-trend entry

    # ── Standard RSI signals ───────────────────────────────────────────────
    if rsi_now < RSI_OVERSOLD:
        signal = 'BUY'
        # Momentum: RSI must be rising (turning from oversold)
        if rsi_now <= rsi_prev:
            return None
        # Candle confirm: need a green (bullish) candle
        if not is_green:
            return None
        # SMA trend filter
        if pd.notna(sma_now) and price_now < sma_now:
            return (signal, 0.5)  # against trend — lower confidence
        return (signal, 1.0)

    elif rsi_now > RSI_OVERBOUGHT:
        signal = 'SELL'
        # Momentum: RSI must be falling (turning from overbought)
        if rsi_now >= rsi_prev:
            return None
        # Candle confirm: need a red (bearish) candle
        if is_green:
            return None
        # SMA trend filter
        if pd.notna(sma_now) and price_now > sma_now:
            return (signal, 0.5)  # against trend — lower confidence
        return (signal, 1.0)

    return None


# ── Position Sizing ───────────────────────────────────────────────────────────

def kelly_position_usd(balance: float, confidence: float) -> float:
    """Dollar amount to risk based on Kelly fraction and signal confidence."""
    raw = balance * KELLY_FRACTION * confidence
    return max(MIN_POSITION_USD, min(MAX_POSITION_USD, raw))


def usd_to_quantity(cfg: dict, size_usd: float, price: float) -> float:
    """Convert a USD position size to contract/unit quantity for the instrument."""
    kind = cfg['type']
    if kind == 'futures':
        # MBT: 1 contract = 0.1 BTC. Margin-based sizing: ~$1,750/contract
        MARGIN_PER_CONTRACT = 1_750.0
        qty = max(1, round(size_usd / MARGIN_PER_CONTRACT))
        return float(qty)
    elif kind == 'crypto':
        # Fractional crypto: size_usd / price, rounded to 4 decimals
        return round(size_usd / price, 4)
    elif kind == 'forex':
        # Lot sizing: min 20,000 units of base currency on IDEALPRO
        # size_usd / price gives units; round to nearest 1,000
        units = int((size_usd / price) / 1_000) * 1_000
        return float(max(20_000, units))
    return 1.0


# ── Trade Logging ─────────────────────────────────────────────────────────────

def log_trade(row: dict):
    """Append a trade record to ibkr_trades_log.csv."""
    fields = ['timestamp', 'instrument', 'action', 'quantity', 'price',
              'size_usd', 'confidence', 'pnl', 'balance']
    write_header = True
    try:
        with open(TRADE_LOG, 'r'):
            write_header = False
    except FileNotFoundError:
        pass
    with open(TRADE_LOG, 'a', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        if write_header:
            writer.writeheader()
        writer.writerow({k: row.get(k, '') for k in fields})


# ── Main Bot Class ────────────────────────────────────────────────────────────

class IBKRBot:
    def __init__(self):
        self.ib              = IB()
        self.balance         = STARTING_BALANCE
        self.open_positions  : Dict[str, dict] = {}   # name -> position info
        self.wins            = 0
        self.losses          = 0
        self.consec_losses   = 0
        self.paused_until    : Optional[datetime] = None

    # ── Connection ─────────────────────────────────────────────────────────

    def connect(self):
        port = IBKR_LIVE_PORT if LIVE_TRADING else IBKR_PAPER_PORT
        mode = 'LIVE' if LIVE_TRADING else 'PAPER'
        log.info(f"Connecting to IBKR {mode} on {IBKR_HOST}:{port} ...")
        self.ib.connect(IBKR_HOST, port, clientId=IBKR_CLIENT_ID)
        accounts = self.ib.managedAccounts()
        log.info(f"Connected. Account(s): {accounts}")

    def disconnect(self):
        if self.ib.isConnected():
            self.ib.disconnect()
            log.info("Disconnected from IBKR.")

    # ── Account ────────────────────────────────────────────────────────────

    def sync_balance(self):
        """Pull current Net Liquidation Value from IBKR."""
        for av in self.ib.accountValues():
            if av.tag == 'NetLiquidation' and av.currency == 'USD':
                self.balance = float(av.value)
                return
        log.warning("Could not read NetLiquidation — keeping last known balance.")

    # ── Order Placement ────────────────────────────────────────────────────

    def place_order(self, contract: Contract, action: str, quantity: float,
                    instrument_name: str) -> bool:
        """
        Place a market order (or paper-log it if LIVE_TRADING=False).
        action: 'BUY' or 'SELL'
        quantity: number of contracts / units / crypto amount
        """
        if not LIVE_TRADING:
            log.info(f"[PAPER] {action:4s}  {quantity} x {instrument_name}  @ market")
            return True

        try:
            self.ib.qualifyContracts(contract)
            order = MarketOrder(action, quantity)
            trade = self.ib.placeOrder(contract, order)
            self.ib.sleep(2)   # give TWS a moment to acknowledge
            log.info(
                f"ORDER  {action:4s}  {quantity} x {instrument_name}"
                f"  |  status: {trade.orderStatus.status}"
            )
            return True
        except Exception as e:
            log.error(f"Order failed for {instrument_name}: {e}")
            return False

    # ── Position Management ────────────────────────────────────────────────

    def open_position(self, name: str, contract: Contract, cfg: dict,
                      action: str, quantity: float, price: float,
                      size_usd: float, confidence: float):
        """Record a newly opened position."""
        self.open_positions[name] = {
            'contract':   contract,
            'cfg':        cfg,
            'action':     action,
            'quantity':   quantity,
            'entry_price': price,
            'size_usd':   size_usd,
            'confidence': confidence,
            'opened_at':  datetime.utcnow(),
        }
        log_trade({
            'timestamp':  datetime.utcnow().isoformat(),
            'instrument': name,
            'action':     action,
            'quantity':   quantity,
            'price':      price,
            'size_usd':   size_usd,
            'confidence': confidence,
            'pnl':        '',
            'balance':    self.balance,
        })

    def close_position(self, name: str, current_price: Optional[float] = None):
        """Close a position and update P&L (paper mode estimates based on price move)."""
        pos = self.open_positions.get(name)
        if not pos:
            return

        contract  = pos['contract']
        cfg       = pos['cfg']
        close_act = 'SELL' if pos['action'] == 'BUY' else 'BUY'

        self.place_order(contract, close_act, pos['quantity'], name)

        # Estimate P&L (paper only; IBKR reports real P&L in live mode)
        pnl = 0.0
        if current_price and pos['entry_price']:
            pct = (current_price - pos['entry_price']) / pos['entry_price']
            direction = 1 if pos['action'] == 'BUY' else -1
            pnl = pos['size_usd'] * pct * direction

        self.balance += pnl
        sign = '+' if pnl >= 0 else ''
        if pnl > 0:
            self.wins += 1
            self.consec_losses = 0
        elif pnl < 0:
            self.losses += 1
            self.consec_losses += 1

        log.info(
            f"CLOSED {name}  |  P&L: {sign}${pnl:.2f}"
            f"  |  Balance: ${self.balance:.2f}"
            f"  |  W:{self.wins} L:{self.losses}"
        )
        log_trade({
            'timestamp':  datetime.utcnow().isoformat(),
            'instrument': name,
            'action':     close_act,
            'quantity':   pos['quantity'],
            'price':      current_price or '',
            'size_usd':   pos['size_usd'],
            'confidence': pos['confidence'],
            'pnl':        round(pnl, 2),
            'balance':    round(self.balance, 2),
        })
        del self.open_positions[name]

    # ── Per-instrument Scan ────────────────────────────────────────────────

    def scan_instrument(self, name: str, cfg: dict, contract: Contract):
        """
        For one instrument:
          - If a position is open, check whether it's time to close it.
          - If no position, fetch candles, compute RSI, place order on signal.
        """
        # ── Check existing position ─────────────────────────────────────
        if name in self.open_positions:
            pos     = self.open_positions[name]
            elapsed = (datetime.utcnow() - pos['opened_at']).total_seconds()
            if elapsed >= POSITION_DURATION_SEC:
                # Fetch latest price for P&L estimate
                df = self._get_candles(name, cfg, contract)
                price = df['close'].iloc[-1] if df is not None else None
                log.info(f"Time-closing {name} (held {elapsed/3600:.1f}h)")
                self.close_position(name, price)
            return  # don't open a second position for same instrument

        # ── Check open position limit ───────────────────────────────────
        if len(self.open_positions) >= MAX_OPEN_POSITIONS:
            return

        # ── Fetch candles ───────────────────────────────────────────────
        df = self._get_candles(name, cfg, contract)
        if df is None or len(df) < 52:
            log.warning(f"Not enough data for {name} (got {len(df) if df is not None else 0} rows)")
            return

        # ── RSI signal ──────────────────────────────────────────────────
        result = get_signal(df)
        if result is None:
            return

        action, confidence = result
        price     = df['close'].iloc[-1]
        rsi_val   = calculate_rsi(df['close'], RSI_PERIOD).iloc[-1]
        size_usd  = kelly_position_usd(self.balance, confidence)
        quantity  = usd_to_quantity(cfg, size_usd, price)

        log.info(
            f"SIGNAL  {name}  →  {action}  |  RSI={rsi_val:.1f}"
            f"  |  conf={confidence:.1f}  |  size=${size_usd:.0f}"
            f"  |  qty={quantity}"
        )

        if self.place_order(contract, action, quantity, name):
            self.open_position(name, contract, cfg, action, quantity,
                               price, size_usd, confidence)

    def _get_candles(self, name: str, cfg: dict, contract: Contract) -> Optional[pd.DataFrame]:
        """Route to Kraken or IBKR depending on instrument config."""
        if cfg.get('data_source') == 'kraken':
            return fetch_kraken_candles(
                cfg['kraken_pair'],
                interval=CANDLE_INTERVAL_MIN,
                limit=CANDLES_TO_FETCH,
            )
        else:
            return fetch_ibkr_candles(
                self.ib, contract, cfg,
                interval_min=CANDLE_INTERVAL_MIN,
                limit=CANDLES_TO_FETCH,
            )

    # ── Main Loop ──────────────────────────────────────────────────────────

    def run(self):
        self.connect()
        mode = 'LIVE 🔴' if LIVE_TRADING else 'PAPER 🟡'
        log.info(f"{'='*60}")
        log.info(f"IBKR Multi-Asset RSI Bot started  |  Mode: {mode}")
        log.info(f"Balance: ${self.balance:,.2f}")
        active = [n for n, c in INSTRUMENTS.items() if c.get('enabled')]
        log.info(f"Active instruments: {active}")
        log.info(f"{'='*60}")

        # Pre-qualify all contracts once at startup
        contracts: Dict[str, Contract] = {}
        for name, cfg in INSTRUMENTS.items():
            if not cfg.get('enabled'):
                continue
            try:
                c = build_contract(name, cfg)
                if LIVE_TRADING or cfg['type'] == 'futures':
                    self.ib.qualifyContracts(c)
                contracts[name] = c
                log.info(f"Contract ready: {name} → {c.symbol} {cfg['type']}")
            except Exception as e:
                log.error(f"Failed to build contract for {name}: {e}")

        try:
            while True:
                # ── Pause check ──────────────────────────────────────────
                if self.paused_until and datetime.utcnow() < self.paused_until:
                    mins_left = int((self.paused_until - datetime.utcnow()).total_seconds() / 60)
                    log.info(f"Paused after {PAUSE_AFTER_LOSSES} consecutive losses. "
                             f"Resuming in {mins_left} min.")
                    time.sleep(60)
                    continue
                self.paused_until = None

                # ── Loss limit ───────────────────────────────────────────
                if self.consec_losses >= PAUSE_AFTER_LOSSES:
                    self.paused_until = datetime.utcnow() + timedelta(hours=PAUSE_DURATION_HR)
                    log.warning(
                        f"[RISK] {PAUSE_AFTER_LOSSES} consecutive losses — "
                        f"pausing for {PAUSE_DURATION_HR}h"
                    )
                    continue

                # ── Sync account balance ─────────────────────────────────
                self.sync_balance()
                log.info(
                    f"── Scan {datetime.utcnow().strftime('%H:%M UTC')}  "
                    f"Balance=${self.balance:,.2f}  "
                    f"Open={len(self.open_positions)}  "
                    f"W:{self.wins}/L:{self.losses} ──"
                )

                # ── Scan each instrument ─────────────────────────────────
                for name, contract in contracts.items():
                    cfg = INSTRUMENTS[name]
                    try:
                        self.scan_instrument(name, cfg, contract)
                    except Exception as e:
                        log.error(f"Error scanning {name}: {e}")

                log.info(f"Next scan in {POLL_INTERVAL_SEC // 60} min.")
                time.sleep(POLL_INTERVAL_SEC)

        except KeyboardInterrupt:
            log.info("Stopped by user (Ctrl+C).")
        finally:
            # Close all open positions cleanly
            if self.open_positions:
                log.info(f"Closing {len(self.open_positions)} open position(s) before exit ...")
                for name in list(self.open_positions.keys()):
                    self.close_position(name)
            self.disconnect()


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if LIVE_TRADING:
        print("\n" + "!"*60)
        print("  WARNING: LIVE_TRADING = True in ibkr_config.py")
        print("  This bot will place REAL orders with REAL money.")
        print("  Press Ctrl+C within 5 seconds to abort.")
        print("!"*60 + "\n")
        time.sleep(5)

    bot = IBKRBot()
    bot.run()
