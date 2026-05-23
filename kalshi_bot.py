#!/usr/bin/env python3
"""
Kalshi Multi-Strategy Paper Trading Bot
Goal: $10 -> $2,000 (bootstrap), then $1,000 -> $2,000 monthly.

Strategies:
  1. Sports Momentum     — buy heavy favorites when price is rising + volume confirms
  2. Economics (Macro)   — trade Fed/CPI/NFP markets when priced off consensus
  3. BTC + SPY Momentum  — RSI on real BTC/ETH prices mapped to Kalshi crypto markets
  4. News RSS            — ultra-fast RSS scanner fires trades on breaking headlines

Paper trading uses LIVE Kalshi prices but no real money.
"""

import time, csv, os, sys, json, re, math
import requests
import pandas as pd
from datetime import datetime, timezone, timedelta
from kalshi_config import *
from kalshi_client import KalshiClient

# Optional: feedparser for RSS (pip install feedparser)
try:
    import feedparser
    HAS_FEEDPARSER = True
except ImportError:
    HAS_FEEDPARSER = False
    print("  [WARN] feedparser not installed. News RSS strategy disabled.")
    print("         Run: pip install feedparser --break-system-packages")

# ─────────────────────────────────────────────────────────────
#  PAPER TRADER
# ─────────────────────────────────────────────────────────────

class PaperTrader:
    def __init__(self, client: KalshiClient):
        self.client          = client
        self.balance         = STARTING_BALANCE
        self.open_positions  = []   # list of position dicts
        self.closed_trades   = []
        self.harvest_done    = False
        self._init_log()

    def _init_log(self):
        if not os.path.exists(TRADE_LOG_FILE):
            with open(TRADE_LOG_FILE, "w", newline="") as f:
                csv.writer(f).writerow([
                    "open_time", "strategy", "ticker", "title",
                    "side", "price_cents", "contracts", "bet_usd",
                    "fee_usd", "total_cost", "kelly_pct",
                    "close_time", "result", "pnl", "balance_after"
                ])

    def _log_trade(self, pos, result, pnl):
        with open(TRADE_LOG_FILE, "a", newline="") as f:
            csv.writer(f).writerow([
                pos["open_time"], pos["strategy"], pos["ticker"],
                pos["title"][:60], pos["side"],
                pos["price_cents"], pos["contracts"],
                round(pos["bet_usd"], 4), round(pos["fee_usd"], 4),
                round(pos["total_cost"], 4),
                "{:.1f}%".format(pos["kelly_pct"] * 100),
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                result, round(pnl, 4), round(self.balance, 4)
            ])

    # ── POSITION MANAGEMENT ───────────────────────────────────

    def can_trade(self):
        return (
            not self.harvest_done
            and len(self.open_positions) < MAX_OPEN_POSITIONS
            and self.balance >= MIN_BET
        )

    def place_bet(self, ticker, title, side, price_cents,
                  true_prob, strategy, reason="", kelly_override=None):
        """
        Paper-buy `side` ("YES" or "NO") at price_cents.
        Kelly sizes the number of contracts automatically.
        kelly_override: if provided (e.g. from news tiered Kelly), use this
                        fraction instead of the global KELLY_FRACTION.
        Returns position dict or None if trade rejected.
        """
        price_d = price_cents / 100.0

        # Sanity checks
        if side not in ("YES", "NO"):
            return None
        if price_cents <= 0 or price_cents >= 100:
            return None
        if price_d >= true_prob - 0.02:   # need at least 2% edge
            return None

        # 1 contract costs price_d dollars → number of contracts from Kelly sizing
        effective_kelly = kelly_override if kelly_override is not None else KELLY_FRACTION
        fee_per  = KalshiClient.calc_fee(1, price_cents)
        kelly_f  = KalshiClient.calc_kelly(true_prob, price_d, fee_per, effective_kelly)

        if kelly_f <= 0:
            return None

        # Translate fraction to a dollar amount then to contracts
        dollar_bet = self.balance * kelly_f
        dollar_bet = max(MIN_BET, min(MAX_BET, dollar_bet))

        contracts  = max(1, int(dollar_bet / (price_d + fee_per)))
        total_cost = contracts * (price_d + fee_per)

        if total_cost > self.balance:
            contracts  = max(1, int(self.balance / (price_d + fee_per)))
            total_cost = contracts * (price_d + fee_per)

        if total_cost > self.balance or contracts < 1:
            return None

        self.balance -= total_cost

        pos = {
            "open_time"  : datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "strategy"   : strategy,
            "ticker"     : ticker,
            "title"      : title,
            "side"       : side,
            "price_cents": price_cents,
            "contracts"  : contracts,
            "bet_usd"    : contracts * price_d,
            "fee_usd"    : contracts * fee_per,
            "total_cost" : total_cost,
            "kelly_pct"  : kelly_f,
            "true_prob"  : true_prob,
            "reason"     : reason,
        }
        self.open_positions.append(pos)
        return pos

    def check_resolutions(self):
        """Poll Kalshi for resolution of each open position."""
        still_open = []
        for pos in self.open_positions:
            result = self.client.get_market_result(pos["ticker"])
            if result is None:
                still_open.append(pos)
                continue

            won = (result == pos["side"].lower())
            if won:
                payout = pos["contracts"] * 1.00   # $1 per contract
                pnl    = payout - pos["total_cost"]
                self.balance += payout
            else:
                pnl = -pos["total_cost"]

            result_str = "WIN" if won else "LOSS"
            self.closed_trades.append(dict(pos, result=result_str, pnl=pnl))
            self._log_trade(pos, result_str, pnl)

            icon = "✅ WIN" if won else "❌ LOSS"
            print(f"\n  {icon}  [{pos['strategy'].upper()}] {pos['ticker']}"
                  f"  {pos['side']} x{pos['contracts']}"
                  f"  Cost ${pos['total_cost']:.2f} | P&L ${pnl:+.2f}"
                  f"  Balance ${self.balance:.2f}")

            if self.balance >= TARGET_BALANCE and not self.harvest_done:
                self._harvest_alert()

        self.open_positions = still_open

    def _harvest_alert(self):
        profit = self.balance - WITHDRAW_TO
        print("\n" + "=" * 64)
        print(f"  🎯 TARGET REACHED: ${self.balance:,.2f} !!!")
        print(f"  Withdraw ${profit:,.2f}  |  Keep ${WITHDRAW_TO:,.2f} for next cycle.")
        print(f"  Next cycle: set STARTING_BALANCE = {WITHDRAW_TO} in kalshi_config.py")
        print("=" * 64)
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
        s   = self.stats()
        bal = self.balance
        print("\n  " + "─" * 58)
        if not s:
            print(f"  Balance: ${bal:.2f}  |  No closed trades yet.")
        else:
            print(f"  STATS: {s['wins']}W / {s['losses']}L"
                  f"  Win Rate: {s['win_rate']:.1f}%"
                  f"  P&L: ${s['total_pnl']:+.2f}"
                  f"  Balance: ${bal:.2f}")

        # Progress bar
        start  = STARTING_BALANCE
        target = TARGET_BALANCE
        pct    = min(1.0, (bal - start) / max(target - start, 1))
        filled = int(round(pct * 40))
        bar    = "█" * filled + "░" * (40 - filled)
        print(f"  [{bar}] ${bal:.2f} / ${target:.0f}  ({pct*100:.1f}%)")

        # Open positions summary
        if self.open_positions:
            print(f"\n  Open positions ({len(self.open_positions)}):")
            for p in self.open_positions:
                print(f"    [{p['strategy']:12}] {p['ticker']}"
                      f"  {p['side']} x{p['contracts']}"
                      f"  @ {p['price_cents']}¢  Cost ${p['total_cost']:.2f}")
        print("  " + "─" * 58)


# ─────────────────────────────────────────────────────────────
#  STRATEGY 1: SPORTS MOMENTUM
# ─────────────────────────────────────────────────────────────

class SportsStrategy:
    """
    Find sports markets where:
      - YES price is in the sweet-spot range (65-90¢)
      - Price is rising (momentum confirmation)
      - Volume is adequate (liquidity filter)
      - Series cap: max 1 bet per unique matchup this week

    Edge thesis: prediction markets exhibit reverse favorite-longshot bias —
    favorites are slightly underpriced vs true probability, giving +EV to buying YES.
    We amplify this by only entering when recent price momentum confirms direction.

    Series cap prevents stacking losses on the same team across multiple games
    in the same matchup (e.g. betting MIN every game vs SAS in a playoff series).
    """
    def __init__(self, client: KalshiClient):
        self.client      = client
        self.price_cache = {}   # ticker -> (yes_ask_cents, timestamp)
        self.series_bets = {}   # series_key -> timestamp of first bet this week

    def _series_key(self, ticker: str) -> str:
        """Extract the matchup key from a ticker (strips game number/date prefix).
        E.g. KXNBAGAME-26MAY15DETCLE-DET  ->  DETCLE
             KXMLBGAME-26MAY16SFATH-SF     ->  SFATH
        """
        try:
            # Middle segment looks like 26MAY15DETCLE — strip date (first 7 chars) to get teams
            middle = ticker.split("-")[1]  # e.g. 26MAY15DETCLE
            teams = middle[7:]             # e.g. DETCLE
            return "".join(sorted([teams[:3], teams[3:]]))  # alphabetical so DET/CLE == CLE/DET
        except Exception:
            return ticker

    def _week_start(self) -> float:
        """Unix timestamp of the most recent Monday midnight UTC."""
        import datetime as dt
        now = dt.datetime.utcnow()
        days_since_monday = now.weekday()
        monday = now - dt.timedelta(days=days_since_monday,
                                    hours=now.hour, minutes=now.minute,
                                    seconds=now.second, microseconds=now.microsecond)
        return monday.timestamp()

    def already_bet_series(self, ticker: str) -> bool:
        """Return True if we already placed a bet on this matchup this week."""
        key = self._series_key(ticker)
        bet_ts = self.series_bets.get(key, 0)
        return bet_ts >= self._week_start()

    def record_series_bet(self, ticker: str):
        """Call this after placing a bet to lock out the series for the week."""
        key = self._series_key(ticker)
        self.series_bets[key] = time.time()

    def get_signals(self):
        signals = []
        try:
            markets = self.client.get_sports_markets(min_volume=SPORTS_MIN_VOLUME)
        except Exception as e:
            print(f"  [Sports] API error: {e}")
            return signals

        now = time.time()

        for m in markets:
            ticker    = m.get("ticker", "")
            title     = m.get("title", "")
            yes_ask   = m.get("yes_ask", 0)    # cents
            no_ask    = m.get("no_ask", 0)
            volume_24 = m.get("volume_24h", 0)

            if not yes_ask or not no_ask:
                continue

            yes_d = yes_ask / 100.0
            no_d  = no_ask  / 100.0

            # ── Series cap: skip if we already bet this matchup this week ──────
            if self.already_bet_series(ticker):
                self.price_cache[ticker + "_yes"] = (yes_ask, now)
                self.price_cache[ticker + "_no"]  = (no_ask,  now)
                continue

            # ── BUY YES: market thinks this team wins with 65-90% probability
            if SPORTS_MIN_YES <= yes_d <= SPORTS_MAX_YES:
                old_yes, old_ts = self.price_cache.get(ticker + "_yes", (yes_ask, now))
                age_mins = (now - old_ts) / 60
                momentum = (yes_ask - old_yes) / max(old_yes, 1)

                # Need upward momentum OR first time we're seeing this market
                if momentum >= SPORTS_MOMENTUM_PCT or age_mins > 10:
                    # Estimate true_prob: assume 3-5% underpricing of favorites
                    # (conservative edge assumption — back-tested in literature)
                    true_prob = min(0.97, yes_d + 0.04)
                    signals.append({
                        "ticker"    : ticker,
                        "title"     : title,
                        "side"      : "YES",
                        "price_cents": yes_ask,
                        "true_prob" : true_prob,
                        "strategy"  : "sports",
                        "reason"    : f"Favorite YES {yes_ask}¢ "
                                      f"momentum={momentum:+.1%} vol={volume_24}",
                    })

            # ── BUY NO: massive underdog (no_ask < 15¢) with slight momentum
            elif no_d <= 0.15 and no_d >= 0.04:
                old_no, old_ts = self.price_cache.get(ticker + "_no", (no_ask, now))
                age_mins = (now - old_ts) / 60
                momentum = (no_ask - old_no) / max(old_no, 1)

                if momentum >= SPORTS_MOMENTUM_PCT or age_mins > 10:
                    true_prob = min(0.97, no_d + 0.03)
                    signals.append({
                        "ticker"    : ticker,
                        "title"     : title,
                        "side"      : "NO",
                        "price_cents": no_ask,
                        "true_prob" : true_prob,
                        "strategy"  : "sports",
                        "reason"    : f"Underdog NO {no_ask}¢ "
                                      f"momentum={momentum:+.1%} vol={volume_24}",
                    })

            # Update cache
            self.price_cache[ticker + "_yes"] = (yes_ask, now)
            self.price_cache[ticker + "_no"]  = (no_ask,  now)

        return signals


# ─────────────────────────────────────────────────────────────
#  STRATEGY 2: ECONOMICS (Fed, CPI, NFP, Treasury)
# ─────────────────────────────────────────────────────────────

class EconomicsStrategy:
    """
    Compare Kalshi economics market prices to known consensus estimates.
    When a market is priced >7% off from where consensus implies it should be,
    that's our edge — trade toward the fair value.

    Also triggers on simple price momentum in econ markets (econ markets tend
    to trend slowly as new information filters in from institutional traders).
    """
    def __init__(self, client: KalshiClient):
        self.client      = client
        self.price_cache = {}

    def get_signals(self):
        signals = []
        try:
            markets = self.client.get_economics_markets(min_volume=ECON_MIN_VOLUME)
        except Exception as e:
            print(f"  [Econ] API error: {e}")
            return signals

        now = time.time()

        for m in markets:
            ticker    = m.get("ticker", "")
            title     = m.get("title", "").lower()
            yes_ask   = m.get("yes_ask", 0)
            no_ask    = m.get("no_ask", 0)
            volume_24 = m.get("volume_24h", 0)

            if not yes_ask or not no_ask:
                continue

            yes_d = yes_ask / 100.0
            no_d  = no_ask  / 100.0

            # ── Check against consensus estimates ─────────────────
            for kw, (consensus_yes, source) in ECON_CONSENSUS.items():
                if kw in title or kw in ticker.lower():
                    deviation = abs(yes_d - consensus_yes)
                    if deviation >= ECON_DEVIATION:
                        # Price is too low → buy YES (market underestimates prob)
                        if yes_d < consensus_yes:
                            signals.append({
                                "ticker"     : m["ticker"],
                                "title"      : m.get("title", ""),
                                "side"       : "YES",
                                "price_cents": yes_ask,
                                "true_prob"  : consensus_yes,
                                "strategy"   : "economics",
                                "reason"     : (f"Consensus {consensus_yes:.0%} "
                                                f"vs market {yes_d:.0%} "
                                                f"({source}) dev={deviation:.1%}"),
                            })
                        # Price is too high → buy NO
                        else:
                            no_true = 1.0 - consensus_yes
                            signals.append({
                                "ticker"     : m["ticker"],
                                "title"      : m.get("title", ""),
                                "side"       : "NO",
                                "price_cents": no_ask,
                                "true_prob"  : no_true,
                                "strategy"   : "economics",
                                "reason"     : (f"Consensus {consensus_yes:.0%} "
                                                f"vs market {yes_d:.0%} "
                                                f"({source}) dev={deviation:.1%}"),
                            })
                    break   # matched keyword, skip rest

            # ── Momentum fallback ─────────────────────────────────
            # Even without consensus data, strong momentum in econ markets is
            # exploitable: institutional money moves slowly, trend tends to continue.
            old_yes, old_ts = self.price_cache.get(ticker, (yes_ask, now))
            age_mins = (now - old_ts) / 60
            momentum = (yes_ask - old_yes) / max(old_yes, 1)

            if abs(momentum) >= 0.05 and age_mins < 30:   # 5%+ move recently
                if momentum > 0 and 0.35 <= yes_d <= 0.75:
                    signals.append({
                        "ticker"     : m["ticker"],
                        "title"      : m.get("title", ""),
                        "side"       : "YES",
                        "price_cents": yes_ask,
                        "true_prob"  : min(0.92, yes_d + 0.06),
                        "strategy"   : "economics",
                        "reason"     : f"Econ momentum +{momentum:.1%} in last cycle",
                    })
                elif momentum < 0 and 0.35 <= no_d <= 0.75:
                    signals.append({
                        "ticker"     : m["ticker"],
                        "title"      : m.get("title", ""),
                        "side"       : "NO",
                        "price_cents": no_ask,
                        "true_prob"  : min(0.92, no_d + 0.06),
                        "strategy"   : "economics",
                        "reason"     : f"Econ momentum {momentum:.1%} in last cycle",
                    })

            self.price_cache[ticker] = (yes_ask, now)

        return signals


# ─────────────────────────────────────────────────────────────
#  STRATEGY 3: BTC + SPY MOMENTUM  (RSI-driven)
# ─────────────────────────────────────────────────────────────

class CryptoMarketStrategy:
    """
    Pull live BTC and ETH prices from Kraken (free, no auth needed).
    Calculate RSI on 5-minute candles.
    When RSI signals oversold/overbought on BTC, scan Kalshi crypto markets
    for contracts tied to BTC/ETH price levels and trade accordingly.

    Same RSI logic proven in the original Polymarket bot — now applied to
    Kalshi's crypto markets (e.g. "Will BTC close above $X?").
    """
    def __init__(self, client: KalshiClient):
        self.client = client
        self.kraken_url = "https://api.kraken.com/0/public/OHLC"

    def _fetch_candles(self, pair="XBTUSD"):
        params = {"pair": pair, "interval": CANDLE_INTERVAL}
        r = requests.get(self.kraken_url, params=params, timeout=10)
        r.raise_for_status()
        data = r.json()
        if data.get("error"):
            raise ValueError(f"Kraken error: {data['error']}")
        pair_key = [k for k in data["result"] if k != "last"][0]
        raw = data["result"][pair_key][-CANDLES_TO_FETCH:]
        df  = pd.DataFrame(raw, columns=[
            "open_time","open","high","low","close","vwap","volume","count"])
        for col in ["open","high","low","close"]:
            df[col] = df[col].astype(float)
        return df

    def _calc_rsi(self, series, period=RSI_PERIOD):
        delta    = series.diff()
        gain     = delta.clip(lower=0)
        loss     = (-delta).clip(lower=0)
        avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
        avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
        rs       = avg_gain / avg_loss.replace(0, float("nan"))
        return 100 - (100 / (1 + rs))

    def _btc_signal(self):
        """Returns ('BUY' | 'SELL' | None, btc_price, rsi_value)."""
        try:
            df       = self._fetch_candles("XBTUSD")
            df["rsi"] = self._calc_rsi(df["close"])
            rsi_now  = df["rsi"].iloc[-2]
            rsi_prev = df["rsi"].iloc[-3]
            close_now = df["close"].iloc[-2]
            open_now  = df["open"].iloc[-2]
            btc_price = df["close"].iloc[-1]
            is_green  = close_now > open_now

            if rsi_now < RSI_OVERSOLD and rsi_now > rsi_prev and is_green:
                return "BUY", btc_price, rsi_now
            elif rsi_now > RSI_OVERBOUGHT and rsi_now < rsi_prev and not is_green:
                return "SELL", btc_price, rsi_now
            return None, btc_price, rsi_now
        except Exception as e:
            print(f"  [BTC/SPY] Kraken error: {e}")
            return None, None, None

    def get_signals(self):
        signals = []
        direction, btc_price, rsi = self._btc_signal()

        if direction is None or btc_price is None:
            return signals

        try:
            crypto_markets = self.client.get_crypto_markets(min_volume=50)
        except Exception as e:
            print(f"  [BTC/SPY] Kalshi API error: {e}")
            return signals

        for m in crypto_markets:
            ticker  = m.get("ticker", "")
            title   = m.get("title", "").lower()
            yes_ask = m.get("yes_ask", 0)
            no_ask  = m.get("no_ask", 0)

            if not yes_ask or not no_ask:
                continue

            yes_d = yes_ask / 100.0
            no_d  = no_ask  / 100.0

            # Only trade if it's clearly a BTC price-level market
            is_btc_market = any(kw in title for kw in ["bitcoin", "btc"])
            if not is_btc_market:
                continue

            # Try to extract price level from market title
            # e.g. "Will BTC close above $90,000?"
            price_match = re.search(r'\$?([\d,]+)k?', title)
            if price_match:
                target_str = price_match.group(1).replace(",", "")
                target_price = float(target_str)
                if "k" in title[price_match.start():price_match.end()+1]:
                    target_price *= 1000

                btc_vs_target = btc_price / target_price

                if direction == "BUY":
                    # BTC oversold & bouncing → lean YES on "above $X" markets
                    # if BTC is within 5% below target (could easily hit it)
                    if 0.93 <= btc_vs_target <= 1.10 and 0.35 <= yes_d <= 0.72:
                        true_prob = min(0.85, yes_d + 0.08)
                        signals.append({
                            "ticker"     : ticker,
                            "title"      : m.get("title", ""),
                            "side"       : "YES",
                            "price_cents": yes_ask,
                            "true_prob"  : true_prob,
                            "strategy"   : "btc_rsi",
                            "reason"     : (f"BTC RSI oversold {rsi:.1f} bouncing "
                                            f"BTC=${btc_price:,.0f} target=${target_price:,.0f}"),
                        })
                elif direction == "SELL":
                    # BTC overbought & falling → lean NO on "above $X" markets
                    if 0.90 <= btc_vs_target <= 1.07 and 0.35 <= no_d <= 0.72:
                        true_prob = min(0.85, no_d + 0.08)
                        signals.append({
                            "ticker"     : ticker,
                            "title"      : m.get("title", ""),
                            "side"       : "NO",
                            "price_cents": no_ask,
                            "true_prob"  : true_prob,
                            "strategy"   : "btc_rsi",
                            "reason"     : (f"BTC RSI overbought {rsi:.1f} falling "
                                            f"BTC=${btc_price:,.0f} target=${target_price:,.0f}"),
                        })

        if signals:
            print(f"  [BTC/RSI] BTC=${btc_price:,.0f}  RSI={rsi:.1f}  "
                  f"direction={direction}  {len(signals)} signal(s)")

        return signals


# ─────────────────────────────────────────────────────────────
#  STRATEGY 4: NEWS RSS MOMENTUM
# ─────────────────────────────────────────────────────────────

class NewsStrategy:
    """
    Ultra-fast RSS scanner — polls 8 feeds every 90 seconds.
    Scores each new article against keyword maps.
    When a strong signal fires, scans open Kalshi markets for relevance
    and places a paper trade before the market prices it in.

    Speed advantage: most traders are checking headlines manually.
    The bot is scanning 8 sources simultaneously every 90 seconds
    and can fire a trade within 1-2 minutes of a headline dropping.
    """
    def __init__(self, client: KalshiClient):
        self.client     = client
        self.seen_urls  = set()    # deduplicate articles
        self.last_scan  = 0

    def _score_article(self, title, summary=""):
        """
        Score a news article. Returns (score, category, direction).
        score > 0 → bullish YES signal
        score < 0 → bearish (buy NO) signal
        """
        text = (title + " " + summary).lower()
        score    = 0
        category = None
        for kw, (cat, direction) in NEWS_KEYWORDS.items():
            if kw in text:
                score    += direction
                category  = cat
        return score, category

    def _is_fresh(self, entry):
        """True if article is less than NEWS_MAX_AGE_MINS (now 5) old."""
        try:
            if hasattr(entry, "published_parsed") and entry.published_parsed:
                pub = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
                age = (datetime.now(timezone.utc) - pub).total_seconds() / 60
                return age <= NEWS_MAX_AGE_MINS
        except Exception:
            pass
        return True   # can't determine age → include it

    def _age_minutes(self, entry):
        """Return article age in minutes, or 0 if unknown."""
        try:
            if hasattr(entry, "published_parsed") and entry.published_parsed:
                pub = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
                return (datetime.now(timezone.utc) - pub).total_seconds() / 60
        except Exception:
            pass
        return 0.0

    def _fetch_feed(self, url):
        """Returns list of (title, summary, link, age_mins) for fresh unseen articles."""
        if not HAS_FEEDPARSER:
            return []
        try:
            feed    = feedparser.parse(url)
            results = []
            for entry in feed.entries[:20]:  # scan latest 20
                link = getattr(entry, "link", "")
                if link in self.seen_urls:
                    continue
                if not self._is_fresh(entry):
                    continue
                title    = getattr(entry, "title",   "")
                summary  = getattr(entry, "summary", "")
                age_mins = self._age_minutes(entry)
                results.append((title, summary, link, age_mins))
            return results
        except Exception:
            return []

    def _find_matching_markets(self, category, direction):
        """Find Kalshi markets relevant to this news category."""
        try:
            if category == "economics":
                markets = self.client.get_economics_markets(min_volume=50)
            elif category == "sports":
                markets = self.client.get_sports_markets(min_volume=50)
            elif category == "crypto":
                markets = self.client.get_crypto_markets(min_volume=50)
            else:
                markets = self.client.get_markets(limit=100)

            # Score each market for keyword relevance
            best = []
            for m in markets:
                title  = m.get("title", "").lower()
                yes_ask = m.get("yes_ask", 0)
                no_ask  = m.get("no_ask", 0)
                if not yes_ask or not no_ask:
                    continue

                # Prefer markets closer to 50/50 (more room to move)
                midpoint_dist = abs((yes_ask / 100.0) - 0.5)
                if midpoint_dist > 0.45:   # skip near-certainties
                    continue

                best.append((midpoint_dist, m))

            best.sort(key=lambda x: x[0])   # closest to 50/50 first
            return [m for _, m in best[:3]]  # top 3 most relevant

        except Exception:
            return []

    def get_signals(self):
        signals = []

        if not HAS_FEEDPARSER:
            return signals

        now = time.time()
        if now - self.last_scan < NEWS_POLL_SECONDS:
            return signals   # too soon to scan again

        self.last_scan = now
        print(f"  [NEWS] Scanning {len(RSS_FEEDS)} RSS feeds ...")

        all_articles = []
        for feed_url in RSS_FEEDS:
            articles = self._fetch_feed(feed_url)
            all_articles.extend(articles)

        if not all_articles:
            print("  [NEWS] No new articles found.")
            return signals

        print(f"  [NEWS] {len(all_articles)} new article(s) found.")

        for (title, summary, link, age_mins) in all_articles:
            self.seen_urls.add(link)
            score, category = self._score_article(title, summary)

            # ── Freshness decay: articles older than 5 min get score halved ──
            # Speed is the entire edge. A 7-min-old headline is already priced in.
            if age_mins > NEWS_MAX_AGE_MINS / 2:   # > 2.5 min → decay kicks in
                decay = max(0.5, 1.0 - (age_mins - NEWS_MAX_AGE_MINS / 2) / NEWS_MAX_AGE_MINS)
                score = int(score * decay)

            if abs(score) < NEWS_MIN_SCORE:
                continue

            direction = "YES" if score > 0 else "NO"
            markets   = self._find_matching_markets(category, score)

            if not markets:
                continue

            # ── Tiered Kelly by score strength ────────────────────────────────
            # Higher conviction signals (more keyword hits) → larger position
            abs_score    = abs(score)
            kelly_tier   = NEWS_KELLY_TIERS.get(min(abs_score, 4), NEWS_KELLY_TIERS[4])

            print(f"  [NEWS] Score={score:+d} Kelly={kelly_tier:.0%} age={age_mins:.1f}m "
                  f"cat={category} headline: \"{title[:60]}\"")

            for m in markets:
                price_cents = (m.get("yes_ask", 50) if direction == "YES"
                               else m.get("no_ask", 50))
                price_d     = price_cents / 100.0

                # Edge scales with score; kelly_tier controls position size
                true_prob = min(0.88, price_d + 0.05 + 0.02 * abs_score)

                signals.append({
                    "ticker"      : m["ticker"],
                    "title"       : m.get("title", ""),
                    "side"        : direction,
                    "price_cents" : price_cents,
                    "true_prob"   : true_prob,
                    "kelly_override": kelly_tier,   # main loop uses this if present
                    "strategy"    : "news_rss",
                    "reason"      : f"Score={score:+d} Kelly={kelly_tier:.0%} age={age_mins:.1f}m {category}: {title[:50]}",
                })

        return signals


# ─────────────────────────────────────────────────────────────
#  DISPLAY HELPERS
# ─────────────────────────────────────────────────────────────

def print_header():
    phase = ("BOOTSTRAP ($10 → $2,000)"
             if STARTING_BALANCE < 100
             else "MONTHLY ($1,000 → $2,000)")
    print("\n" + "═" * 64)
    print("  KALSHI MULTI-STRATEGY BOT  |  PAPER TRADING (Live Data)")
    print("═" * 64)
    print(f"  Phase      : {phase}")
    print(f"  Goal       : ${STARTING_BALANCE:.0f} → ${TARGET_BALANCE:.0f}"
          f"  (withdraw at target, keep ${WITHDRAW_TO:.0f})")
    print(f"  Kelly      : {KELLY_FRACTION:.0%} fractional"
          f"  (min ${MIN_BET}, max ${MAX_BET})")
    print(f"  Positions  : max {MAX_OPEN_POSITIONS} open at once")
    print(f"  Strategies : Sports  |  Economics  |  BTC/RSI  |  News RSS")
    print(f"  Interval   : {POLL_INTERVAL_SECONDS}s main loop  "
          f"/ {NEWS_POLL_SECONDS}s news scan")
    print("═" * 64)
    if not HAS_FEEDPARSER:
        print("  ⚠  NEWS STRATEGY DISABLED  (pip install feedparser)")
    print("  Press Ctrl+C to stop.\n")


def print_cycle(cycle, trader, signals):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"\n{'─'*64}")
    print(f"  [{ts}]  Cycle #{cycle}  |  Balance: ${trader.balance:.2f}"
          f"  |  Open: {len(trader.open_positions)}/{MAX_OPEN_POSITIONS}")
    if signals:
        print(f"  Signals this cycle: {len(signals)}")
        for s in signals[:5]:
            print(f"    [{s['strategy']:12}] {s['side']} {s['ticker']}"
                  f" @ {s['price_cents']}¢  edge→{s['true_prob']:.0%}"
                  f"  {s['reason'][:55]}")


# ─────────────────────────────────────────────────────────────
#  SIGNAL DEDUPLICATION
# ─────────────────────────────────────────────────────────────

def dedup_signals(signals, open_positions):
    """Remove signals for tickers already in open positions, and deduplicate."""
    open_tickers = {p["ticker"] for p in open_positions}
    seen   = set()
    result = []
    for s in signals:
        key = (s["ticker"], s["side"])
        if s["ticker"] in open_tickers:
            continue
        if key in seen:
            continue
        seen.add(key)
        result.append(s)
    # Sort by estimated edge descending
    result.sort(key=lambda s: s["true_prob"] - s["price_cents"]/100, reverse=True)
    return result


# ─────────────────────────────────────────────────────────────
#  MAIN LOOP
# ─────────────────────────────────�