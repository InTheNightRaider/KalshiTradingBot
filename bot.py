#!/usr/bin/env python3
"""
RSI Trading Bot
Modes:
  Paper trading  -- LIVE_TRADING = False in config.py  (default, safe)
  Kalshi demo    -- LIVE_TRADING = True, KALSHI_DEMO = True
  Kalshi live    -- LIVE_TRADING = True, KALSHI_DEMO = False
Goal: $10 -> $2000 bootstrap, then $1000 -> $2000 monthly cycles.
"""

import time, csv, os, sys, requests
import pandas as pd
from datetime import datetime
from config import (
    RSI_PERIOD, RSI_OVERSOLD, RSI_OVERBOUGHT,
    MOMENTUM_FILTER, CANDLE_CONFIRM,
    SYMBOL, CANDLE_INTERVAL, CANDLES_TO_FETCH,
    STARTING_BALANCE, TARGET_BALANCE, WITHDRAW_TO,
    KELLY_FRACTION, MIN_BET, MAX_BET,
    POSITION_DURATION_SEC, POLL_INTERVAL_SECONDS,
    TRADE_LOG_FILE, SHOW_CHART, MAX_OPEN_POSITIONS,
    LIVE_TRADING, KALSHI_DEMO,
    KALSHI_MAX_HOURS_TO_EXPIRY, KALSHI_MIN_HOURS_TO_EXPIRY,
)

KRAKEN_URL = "https://api.kraken.com/0/public/OHLC"

# ── DATA FEED ────────────────────────────────────────────────

def fetch_candles(symbol=SYMBOL, interval=CANDLE_INTERVAL, limit=CANDLES_TO_FETCH):
    params = {"pair": symbol, "interval": interval}
    resp = requests.get(KRAKEN_URL, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise ValueError("Kraken error: " + str(data["error"]))
    pair_key = [k for k in data["result"] if k != "last"][0]
    raw = data["result"][pair_key][-limit:]
    df = pd.DataFrame(raw, columns=[
        "open_time","open","high","low","close","vwap","volume","count"
    ])
    for col in ["open","high","low","close"]:
        df[col] = df[col].astype(float)
    df["open_time"] = pd.to_datetime(df["open_time"], unit="s")
    return df

# ── INDICATORS ───────────────────────────────────────────────

def calculate_rsi(series, period=RSI_PERIOD):
    delta    = series.diff()
    gain     = delta.clip(lower=0)
    loss     = (-delta).clip(lower=0)
    avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
    rs       = avg_gain / avg_loss.replace(0, float("nan"))
    return 100 - (100 / (1 + rs))

def calculate_sma(series, period=50):
    """50-period Simple Moving Average for trend filter."""
    return series.rolling(window=period, min_periods=period).mean()

def rsi_signal(rsi_now, rsi_prev, is_green, price_now=None, sma_now=None,
               rsi_history=None):
    """Return ('YES', kelly_mult), ('NO', kelly_mult), or None.

    Standard filters:
      1. RSI threshold (oversold / overbought)
      2. Momentum filter — RSI must be turning back
      3. Candle confirm — body must agree with direction
      4. SMA trend filter — only trade WITH the trend

    Capitulation bounce mode (new):
      If RSI < 22 (extreme) AND 3 consecutive rising RSI candles confirm
      reversal, enter YES at 0.5× Kelly even against the SMA downtrend.
      These are hard-flush capitulation bottoms that reliably snap back.
    """
    CAPITULATION_RSI   = 22    # must be more extreme than standard oversold
    CAPITULATION_KELLY = 0.5   # half Kelly — counter-trend, so smaller size

    # ── Check for capitulation bounce first (works even in downtrend) ────────
    if (rsi_history is not None and len(rsi_history) >= 3
            and rsi_now < CAPITULATION_RSI):
        # Require 3 consecutive rising RSI values — confirms reversal, not just noise
        r = list(rsi_history)
        if r[-1] > r[-2] > r[-3]:
            return ("YES", CAPITULATION_KELLY)

    # ── Standard signal path ─────────────────────────────────────────────────
    if rsi_now < RSI_OVERSOLD:
        signal = "YES"
    elif rsi_now > RSI_OVERBOUGHT:
        signal = "NO"
    else:
        return None

    if MOMENTUM_FILTER:
        if signal == "YES" and rsi_now <= rsi_prev: return None
        if signal == "NO"  and rsi_now >= rsi_prev: return None

    if CANDLE_CONFIRM:
        if signal == "YES" and not is_green: return None
        if signal == "NO"  and is_green:     return None

    # SMA trend filter — skip counter-trend entries
    if price_now is not None and sma_now is not None and not pd.isna(sma_now):
        if signal == "YES" and price_now < sma_now: return None   # oversold in downtrend — skip
        if signal == "NO"  and price_now > sma_now: return None   # overbought in uptrend  — skip

    return (signal, 1.0)   # standard signal → full Kelly multiplier

# ── BET SIZING ───────────────────────────────────────────────

def calculate_bet(balance):
    raw = balance * KELLY_FRACTION
    return round(max(MIN_BET, min(MAX_BET, raw)), 2)

# ── ASCII DISPLAY ────────────────────────────────────────────

def rsi_bar(value, width=30):
    filled = int(round(value / 100 * width))
    bar = "#" * filled + "-" * (width - filled)
    if value < RSI_OVERSOLD:
        tag = "OVERSOLD  -> BUY YES"
    elif value > RSI_OVERBOUGHT:
        tag = "OVERBOUGHT -> BUY NO"
    else:
        tag = "neutral"
    return "  [" + bar + "] " + "{:5.1f}  {}".format(value, tag)

def print_rsi_history(rsi_series, n=5):
    recent = rsi_series.dropna().iloc[-n:]
    print("  RSI history (newest at bottom):")
    for val in recent:
        print(rsi_bar(val))

def progress_bar(balance, target=TARGET_BALANCE, start=STARTING_BALANCE, width=30):
    pct = min(1.0, (balance - start) / max(target - start, 1))
    filled = int(round(pct * width))
    bar = "#" * filled + "-" * (width - filled)
    return "  [{bar}] ${bal:,.2f} / ${tgt:,.0f}  ({pct:.1f}%)".format(
        bar=bar, bal=balance, tgt=target, pct=pct * 100
    )

def print_header(mode_label):
    phase = "BOOTSTRAP ($10 -> $2,000)" if STARTING_BALANCE < 100 else "MONTHLY ($1,000 -> $2,000)"
    print("\n" + "=" * 62)
    print("  RSI BOT  |  {}".format(mode_label))
    print("=" * 62)
    print("  Phase    : {}".format(phase))
    print("  Goal     : ${:.0f} -> ${:.0f}".format(STARTING_BALANCE, TARGET_BALANCE))
    print("  Bet size : Kelly {:.0f}% of balance  (min ${:.0f}, max ${:.0f})".format(
        KELLY_FRACTION * 100, MIN_BET, MAX_BET))
    print("  RSI      : <{} oversold / >{} overbought  +  momentum + candle".format(
        RSI_OVERSOLD, RSI_OVERBOUGHT))
    print("  Candles  : {}-min  |  Poll every {}s".format(
        CANDLE_INTERVAL, POLL_INTERVAL_SECONDS))
    print("=" * 62)
    print("  Press Ctrl+C to stop.\n")

def print_cycle(cycle, price, rsi_now, rsi_prev, is_green, balance, mode_label):
    ts      = datetime.now().strftime("%H:%M:%S")
    nxt     = calculate_bet(balance)
    rsi_dir = "rising" if rsi_now > rsi_prev else "falling"
    candle  = "green" if is_green else "red"
    print("\n" + "-" * 62)
    print("  [{}]  Cycle #{} | {} | Balance: ${:.2f} | Next bet: ${:.2f}".format(
        ts, cycle, mode_label, balance, nxt))
    print("  BTC: ${:,.2f}  |  RSI: {:.2f} ({})  |  Candle: {}".format(
        price, rsi_now, rsi_dir, candle))

# ── LOG ──────────────────────────────────────────────────────

def init_log():
    if not os.path.exists(TRADE_LOG_FILE):
        with open(TRADE_LOG_FILE, "w", newline="") as f:
            csv.writer(f).writerow([
                "open_time","signal","entry_btc","rsi",
                "bet_usd","close_time","exit_btc",
                "result","pnl","balance_after","mode"
            ])

def write_log(pos, exit_price, result, pnl, balance, mode):
    with open(TRADE_LOG_FILE, "a", newline="") as f:
        csv.writer(f).writerow([
            pos["open_time"], pos["signal"],
            round(pos["entry_price"], 2), round(pos["rsi"], 2),
            round(pos["bet_usd"], 2),
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            round(exit_price, 2), result, round(pnl, 2),
            round(balance, 2), mode
        ])

# ── PAPER TRADER ─────────────────────────────────────────────

class PaperTrader:
    MODE = "PAPER"

    def __init__(self):
        self.balance        = STARTING_BALANCE
        self.open_positions = []
        self.closed_trades  = []
        self.harvest_done   = False
        init_log()

    def can_trade(self):
        return (
            not self.harvest_done
            and len(self.open_positions) < MAX_OPEN_POSITIONS
            and self.balance >= MIN_BET
        )

    def place_bet(self, signal, btc_price, rsi, kelly_mult=1.0):
        raw_bet = calculate_bet(self.balance)
        bet     = round(max(MIN_BET, min(MAX_BET, raw_bet * kelly_mult)), 2)
        if self.balance < bet:
            print("  WARNING: Balance too low to bet.")
            return None
        pos = {
            "open_time"  : datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "signal"     : signal,
            "entry_price": btc_price,
            "rsi"        : rsi,
            "bet_usd"    : bet,
            "resolve_at" : time.time() + POSITION_DURATION_SEC,
        }
        self.balance -= bet
        self.open_positions.append(pos)
        return pos

    def resolve_expired(self, current_price):
        still_open = []
        for pos in self.open_positions:
            if time.time() < pos["resolve_at"]:
                still_open.append(pos)
                continue
            went_up = current_price > pos["entry_price"]
            correct = (
                (pos["signal"] == "YES" and went_up) or
                (pos["signal"] == "NO"  and not went_up)
            )
            pnl    = pos["bet_usd"] if correct else -pos["bet_usd"]
            result = "WIN" if correct else "LOSS"
            if correct:
                self.balance += pos["bet_usd"] * 2
            self.closed_trades.append(dict(pos, exit_price=current_price, pnl=pnl, result=result))
            write_log(pos, current_price, result, pnl, self.balance, self.MODE)
            direction = "UP" if went_up else "DOWN"
            icon = "[WIN] " if correct else "[LOSS]"
            print("\n  {} RESOLVED [{}]  Bet ${:.2f} | Entry ${:.2f} -> ${:.2f} ({})  P&L: ${:+.2f}".format(
                icon, pos["signal"], pos["bet_usd"],
                pos["entry_price"], current_price, direction, pnl))
            if self.balance >= TARGET_BALANCE and not self.harvest_done:
                self._harvest_alert()
        self.open_positions = still_open

    def _harvest_alert(self):
        profit = self.balance - WITHDRAW_TO
        print("\n" + "=" * 62)
        print("  *** TARGET REACHED: ${:.2f} ***".format(self.balance))
        print("  Withdraw ${:.2f} profit.".format(profit))
        print("  Reset balance to ${:.2f} and start next cycle.".format(WITHDRAW_TO))
        print("=" * 62)
        self.harvest_done = True

    def stats(self):
        if not self.closed_trades:
            return {}
        wins  = [t for t in self.closed_trades if t["result"] == "WIN"]
        total = len(self.closed_trades)
        return {
            "trades"   : total,
            "wins"     : len(wins),
            "losses"   : total - len(wins),
            "win_rate" : len(wins) / total * 100,
            "total_pnl": sum(t["pnl"] for t in self.closed_trades),
            "balance"  : self.balance,
        }

    def print_stats(self):
        s = self.stats()
        bal = self.balance
        if not s:
            print("  Balance: ${:.2f}  |  No closed trades yet.".format(bal))
        else:
            print("\n  STATS: {}W / {}L  |  Win Rate: {:.1f}%  |  P&L: ${:+.2f}  |  Balance: ${:.2f}".format(
                s["wins"], s["losses"], s["win_rate"], s["total_pnl"], bal))
        print(progress_bar(bal))

# ── KALSHI TRADER ────────────────────────────────────────────

class KalshiTrader:
    """
    Same interface as PaperTrader but places real Kalshi orders.
    KALSHI_DEMO = True  -> uses Kalshi's demo environment (no real money)
    KALSHI_DEMO = False -> REAL MONEY — only when you're ready
    """

    def __init__(self):
        from kalshi_client import KalshiClient
        self.MODE    = "KALSHI-DEMO" if KALSHI_DEMO else "KALSHI-LIVE"
        self.client  = KalshiClient(demo=KALSHI_DEMO)
        self.client.login()

        # Sync starting balance from Kalshi account
        self.balance        = self.client.get_balance()
        self.open_positions = []
        self.closed_trades  = []
        self.harvest_done   = False
        init_log()

        print("  Kalshi balance: ${:.2f}".format(self.balance))

    def can_trade(self):
        return (
            not self.harvest_done
            and len(self.open_positions) < MAX_OPEN_POSITIONS
            and self.balance >= MIN_BET
        )

    def place_bet(self, signal, btc_price, rsi):
        bet = calculate_bet(self.balance)
        if self.balance < bet:
            print("  WARNING: Balance too low.")
            return None

        # Find the best Kalshi market for this signal
        result = self.client.find_best_market(signal, btc_price)
        if result is None:
            print("  No suitable Kalshi market found — skipping trade.")
            return None

        market, side = result
        ticker = market["ticker"]
        strike = market["strike"]
        expiry = market["exp"]
        hrs    = round(market["hours_until"], 1)

        print("  Kalshi market: {} | Strike: ${:,.0f} | Expires: {} ({:.1f}h)".format(
            ticker, strike, expiry, hrs))

        # Place the order
        try:
            order = self.client.place_market_order(ticker, side, bet)
            order_id = order.get("order", {}).get("order_id", "?")
            print("  Order placed: {} {} ${:.2f} | ID: {}".format(
                side.upper(), ticker, bet, order_id))
        except Exception as e:
            print("  Order failed: {}".format(e))
            return None

        pos = {
            "open_time"  : datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "signal"     : signal,
            "entry_price": btc_price,
            "rsi"        : rsi,
            "bet_usd"    : bet,
            "resolve_at" : time.time() + (hrs * 3600),
            "ticker"     : ticker,
            "side"       : side,
            "order_id"   : order_id,
            "strike"     : strike,
        }
        self.balance -= bet
        self.open_positions.append(pos)
        return pos

    def resolve_expired(self, current_price):
        """Check open positions — resolve ones past their expiry time."""
        still_open = []
        for pos in self.open_positions:
            if time.time() < pos["resolve_at"]:
                t_left = int(pos["resolve_at"] - time.time())
                still_open.append(pos)
                continue

            # Determine outcome based on price vs strike
            strike = pos.get("strike", pos["entry_price"])
            side   = pos.get("side", "yes")
            above  = current_price > strike

            if side == "yes":
                correct = above
            else:
                correct = not above

            # Kalshi pays $1 per contract if correct, $0 if not
            # Our bet_usd ≈ number of contracts at ~$0.50 each
            pnl    = pos["bet_usd"] if correct else -pos["bet_usd"]
            result = "WIN" if correct else "LOSS"

            if correct:
                self.balance += pos["bet_usd"] * 2  # approximate (actual depends on entry price)

            # Sync real balance from Kalshi
            try:
                real_bal = self.client.get_balance()
                self.balance = real_bal
            except Exception:
                pass

            self.closed_trades.append(dict(pos, exit_price=current_price, pnl=pnl, result=result))
            write_log(pos, current_price, result, pnl, self.balance, self.MODE)

            icon = "[WIN] " if correct else "[LOSS]"
            print("\n  {} [{}] {} | Entry BTC ${:,.0f} | Strike ${:,.0f} | Now ${:,.0f}  P&L: ${:+.2f}".format(
                icon, pos["signal"], pos["ticker"],
                pos["entry_price"], strike, current_price, pnl))

            if self.balance >= TARGET_BALANCE and not self.harvest_done:
                self._harvest_alert()

        self.open_positions = still_open

    def _harvest_alert(self):
        profit = self.balance - WITHDRAW_TO
        print("\n" + "=" * 62)
        print("  *** TARGET REACHED: ${:.2f} ***".format(self.balance))
        print("  Withdraw ${:.2f} profit.".format(profit))
        print("=" * 62)
        self.harvest_done = True

    def stats(self):
        if not self.closed_trades:
            return {}
        wins  = [t for t in self.closed_trades if t["result"] == "WIN"]
        total = len(self.closed_trades)
        return {
            "trades"   : total,
            "wins"     : len(wins),
            "losses"   : total - len(wins),
            "win_rate" : len(wins) / total * 100,
            "total_pnl": sum(t["pnl"] for t in self.closed_trades),
            "balance"  : self.balance,
        }

    def print_stats(self):
        s = self.stats()
        bal = self.balance
        if not s:
            print("  Balance: ${:.2f}  |  No closed trades yet.".format(bal))
        else:
            print("\n  STATS: {}W / {}L  |  Win Rate: {:.1f}%  |  P&L: ${:+.2f}  |  Balance: ${:.2f}".format(
                s["wins"], s["losses"], s["win_rate"], s["total_pnl"], bal))
        print(progress_bar(bal))

# ── MAIN LOOP ────────────────────────────────────────────────

def run():
    # Pick trader based on config
    if LIVE_TRADING:
        trader = KalshiTrader()
        mode_label = trader.MODE
    else:
        trader = PaperTrader()
        mode_label = "PAPER TRADING"

    print_header(mode_label)
    cycle = 0
    loss_cooldown_until = 0   # unix timestamp — no new trades before this time

    while True:
        cycle += 1
        try:
            df            = fetch_candles()
            current_price = df["close"].iloc[-1]
            df["rsi"]     = calculate_rsi(df["close"])
            df["sma50"]   = calculate_sma(df["close"], period=50)

            rsi_now   = df["rsi"].iloc[-2]
            rsi_prev  = df["rsi"].iloc[-3]
            close_now = df["close"].iloc[-2]
            open_now  = df["open"].iloc[-2]
            sma_now   = df["sma50"].iloc[-2]
            is_green  = bool(close_now > open_now)
            trend     = "UP" if (not pd.isna(sma_now) and close_now > sma_now) else "DOWN"

            # Last 3 RSI values for capitulation bounce detection
            rsi_history = df["rsi"].dropna().iloc[-4:-1].tolist()

            print_cycle(cycle, current_price, rsi_now, rsi_prev, is_green,
                        trader.balance, mode_label)
            print("  SMA50: ${:,.2f}  |  Trend: {}  |  Cooldown: {}".format(
                sma_now if not pd.isna(sma_now) else 0,
                trend,
                "ACTIVE ({:.0f}s left)".format(loss_cooldown_until - time.time())
                    if time.time() < loss_cooldown_until else "none"))

            if SHOW_CHART:
                print_rsi_history(df["rsi"], n=5)

            prev_closed = len(trader.closed_trades)
            trader.resolve_expired(current_price)

            # If a trade just closed as a loss, start 3-hour cooldown
            if len(trader.closed_trades) > prev_closed:
                last = trader.closed_trades[-1]
                if last["result"] != "WIN":
                    loss_cooldown_until = time.time() +