#!/usr/bin/env python3
"""
Kalshi MASTER BOT  --  BTC/RSI Live  |  Sports/Econ/News Paper
===============================================================
BTC/RSI is the dominant LIVE strategy trading the real $50 balance.
Sports, Economics, and News RSS run as paper traders with $15 each --
real market signals, real resolutions, simulated P&L. All candidates
and paper trades are logged so we can calibrate after 1-2 weeks of data.
"""

import time, csv, os, sys, math, uuid
import requests
from datetime import datetime
from dashboard_exporter import export as export_dashboard

from kalshi_config import (
    STARTING_BALANCE, TARGET_BALANCE, WITHDRAW_TO,
    KELLY_FRACTION, MIN_BET, MAX_OPEN_POSITIONS,
    POLL_INTERVAL_SECONDS, FULL_SCAN_INTERVAL_SECONDS, TRADE_LOG_FILE,
)
from kalshi_client import KalshiClient
from kalshi_bot import (
    SportsStrategy,
    EconomicsStrategy,
    CryptoMarketStrategy,
    NewsStrategy,
    dedup_signals,
)

# -----------------------------------------------------------------------------
#  CONFIGURATION
# -----------------------------------------------------------------------------

LIVE_TRADING            = True

MASTER_STARTING_BALANCE = 50.00
MASTER_TARGET_BALANCE   = 2_000.00
MASTER_WITHDRAW_TO      = 1_000.00

MASTER_MAX_POSITIONS    = 4           # BTC-only live book -- tighter
MASTER_MAX_EXPOSURE     = 0.50
MASTER_MAX_BET          = 150.00
MASTER_KELLY            = 0.25
MASTER_MIN_EDGE         = 0.04

PAPER_STARTING_BALANCE  = 15.00       # each paper strategy starts with $15
PAPER_STRATEGIES        = {"sports", "economics", "news_rss"}

MASTER_TRADE_LOG        = "master_trades.csv"
PAPER_TRADE_LOG         = "paper_trades.csv"
SIGNAL_LOG              = "signal_log.csv"

# BTC/RSI is now the dominant live strategy
CONVICTION = {
    "btc_rsi"   : 1.60,   # dominant -- most validated
    "sports"    : 1.20,   # paper only
    "economics" : 1.10,   # paper only
    "news_rss"  : 1.00,   # paper only
}

# -----------------------------------------------------------------------------
#  COMPOSITE SCORING
# -----------------------------------------------------------------------------

def composite_score(signal: dict) -> float:
    price_d   = signal["price_cents"] / 100.0
    true_prob = signal["true_prob"]
    strategy  = signal.get("strategy", "news_rss")
    edge      = max(0.0, true_prob - price_d)
    conv      = CONVICTION.get(strategy, 1.0)
    midpoint_dist = abs(price_d - 0.50)
    liq = max(0.3, 1.0 - midpoint_dist * 1.5)
    return min(1.0, (edge * conv * liq) / 0.18)


# -----------------------------------------------------------------------------
#  KELLY SIZING
# -----------------------------------------------------------------------------

def kelly_size(balance: float, signal: dict, cs: float,
               max_bet: float = MASTER_MAX_BET) -> float:
    price_d  = signal["price_cents"] / 100.0
    tp       = signal["true_prob"]
    fee_per  = KalshiClient.calc_fee(1, signal["price_cents"])
    eff_k    = MASTER_KELLY * (0.5 + 0.5 * cs)
    kf       = KalshiClient.calc_kelly(tp, price_d, fee_per, eff_k)
    if signal.get("kelly_override") is not None:
        kf = max(kf, KalshiClient.calc_kelly(tp, price_d, fee_per,
                                              signal["kelly_override"]))
    return max(MIN_BET, min(max_bet, balance * kf))


# -----------------------------------------------------------------------------
#  LIVE SIGNAL SELECTION (BTC/RSI only)
# -----------------------------------------------------------------------------

def master_select(signals: list, balance: float,
                  open_positions: list) -> list:
    """Select live trades -- BTC/RSI signals only."""
    open_tickers  = {p["ticker"] for p in open_positions}
    open_count    = len(open_positions)
    category_seen = set()
    allocated     = 0.0
    selected      = []

    for sig in signals:
        # Live book: only BTC/RSI trades real money
        if sig.get("strategy") != "btc_rsi":
            continue
        if open_count + len(selected) >= MASTER_MAX_POSITIONS:
            break
        if allocated >= MASTER_MAX_EXPOSURE * balance:
            break
        if sig["ticker"] in open_tickers:
            continue
        cs = composite_score(sig)
        if cs < 0.15:
            continue
        reason = sig.get("reason", "").lower()
        if "btc" in reason or "bitcoin" in reason or "crypto" in reason:
            event_cat = "btc"
        else:
            event_cat = f"btc_{sig['ticker'][:12]}"
        if event_cat in category_seen:
            continue
        category_seen.add(event_cat)
        bet = kelly_size(balance, sig, cs)
        allocated += bet
        selected.append({**sig, "_composite_score": cs, "_bet_size": bet})

    return selected


# -----------------------------------------------------------------------------
#  PAPER SIGNAL SELECTION (Sports / Economics / News)
# -----------------------------------------------------------------------------

def paper_select(signals: list, strategy: str, balance: float,
                 open_positions: list) -> list:
    """Select paper trades for one non-BTC strategy."""
    open_tickers  = {p["ticker"] for p in open_positions}
    open_count    = len(open_positions)
    category_seen = set()
    allocated     = 0.0
    selected      = []
    paper_max     = min(5.00, balance * 0.35)   # cap paper bets at $5 or 35%

    for sig in [s for s in signals if s.get("strategy") == strategy]:
        if open_count + len(selected) >= 3:
            break
        if allocated >= balance * 0.60:
            break
        if sig["ticker"] in open_tickers:
            continue
        cs = composite_score(sig)
        if cs < 0.12:
            continue
        event_cat = f"{strategy}_{sig['ticker'][:14]}"
        if event_cat in category_seen:
            continue
        category_seen.add(event_cat)
        bet = kelly_size(balance, sig, cs, max_bet=paper_max)
        allocated += bet
        selected.append({**sig, "_composite_score": cs, "_bet_size": bet})

    return selected


# -----------------------------------------------------------------------------
#  SIGNAL LOGGER
# -----------------------------------------------------------------------------

_SIGNAL_LOG_HEADER = [
    "timestamp", "cycle", "scan_type",
    "strategy", "ticker", "title",
    "side", "price_pct", "true_prob_pct", "edge_pct",
    "composite_score", "volume",
    "kelly_pct", "bet_estimate_usd",
    "reason",
    "status",         # LIVE_TRADED | PAPER_TRADED | FILTERED
    "filter_reason",
    "live_balance", "paper_balance",
    "open_live", "open_paper",
]

def _init_csv(path, header):
    if not os.path.exists(path):
        with open(path, "w", newline="") as f:
            csv.writer(f).writerow(header)

def log_signals(cycle, scan_type, deduped, live_selected, paper_selected,
                live_balance, paper_balances, live_open, paper_open_counts):
    if not deduped:
        return
    _init_csv(SIGNAL_LOG, _SIGNAL_LOG_HEADER)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    live_tickers  = {s["ticker"] for s in live_selected}
    paper_tickers = {s["ticker"] for s in paper_selected}
    rows = []
    for sig in deduped:
        price_d   = sig["price_cents"] / 100.0
        true_prob = sig["true_prob"]
        edge      = true_prob - price_d
        cs        = composite_score(sig)
        fee_per   = KalshiClient.calc_fee(1, sig["price_cents"])
        eff_k     = MASTER_KELLY * (0.5 + 0.5 * cs)
        kf        = KalshiClient.calc_kelly(true_prob, price_d, fee_per, eff_k)
        strat     = sig.get("strategy", "")
        p_bal     = paper_balances.get(strat, 0)
        bet_est   = round(max(MIN_BET, min(MASTER_MAX_BET, live_balance * kf)), 2)

        if sig["ticker"] in live_tickers:
            status, freason = "LIVE_TRADED", ""
        elif sig["ticker"] in paper_tickers:
            status, freason = "PAPER_TRADED", ""
        else:
            if cs < 0.15:
                freason = f"low_score({cs:.3f})"
            elif edge < MASTER_MIN_EDGE:
                freason = f"low_edge({edge:.3f})"
            else:
                freason = "correlation_or_cap"
            status = "FILTERED"

        rows.append([
            ts, cycle, scan_type,
            strat, sig.get("ticker",""), sig.get("title","")[:80],
            sig.get("side",""),
            round(price_d*100,1), round(true_prob*100,1), round(edge*100,1),
            round(cs,4), sig.get("volume",0),
            round(kf*100,2), bet_est,
            sig.get("reason","")[:120],
            status, freason,
            round(live_balance,2), round(p_bal,2),
            live_open, paper_open_counts.get(strat,0),
        ])
    with open(SIGNAL_LOG, "a", newline="") as f:
        w = csv.writer(f)
        for row in rows:
            w.writerow(row)


# -----------------------------------------------------------------------------
#  PAPER ACCOUNT
# -----------------------------------------------------------------------------

_PAPER_HEADER = [
    "open_time", "strategy", "ticker", "title",
    "side", "price_cents", "contracts", "bet_usd", "fee_usd", "total_cost",
    "composite_score", "kelly_pct",
    "close_time", "result", "pnl", "paper_balance_after",
]

class PaperAccount:
    """Simulated trading account for one non-BTC strategy."""

    def __init__(self, strategy: str):
        self.strategy        = strategy
        self.balance         = PAPER_STARTING_BALANCE
        self.open_positions  = []
        self.closed_trades   = []
        _init_csv(PAPER_TRADE_LOG, _PAPER_HEADER)

    def place_bet(self, signal: dict) -> dict | None:
        price_d     = signal["price_cents"] / 100.0
        true_prob   = signal["true_prob"]
        cs          = signal.get("_composite_score", 0.5)
        paper_max   = min(5.00, self.balance * 0.35)

        fee_per     = KalshiClient.calc_fee(1, signal["price_cents"])
        eff_k       = MASTER_KELLY * (0.5 + 0.5 * cs)
        kf          = KalshiClient.calc_kelly(true_prob, price_d, fee_per, eff_k)
        if kf <= 0:
            return None

        dollar_bet  = max(MIN_BET, min(paper_max, self.balance * kf))
        contracts   = max(1, int(dollar_bet / (price_d + fee_per)))
        total_cost  = contracts * (price_d + fee_per)

        if total_cost > self.balance or contracts < 1:
            return None

        self.balance -= total_cost
        pos = {
            "open_time"      : datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "strategy"       : self.strategy,
            "ticker"         : signal["ticker"],
            "title"          : signal["title"],
            "side"           : signal["side"],
            "price_cents"    : signal["price_cents"],
            "contracts"      : contracts,
            "bet_usd"        : round(contracts * price_d, 4),
            "fee_usd"        : round(contracts * fee_per, 4),
            "total_cost"     : round(total_cost, 4),
            "composite_score": round(cs, 3),
            "kelly_pct"      : round(kf, 4),
        }
        self.open_positions.append(pos)
        return pos

    def check_resolutions(self, client: KalshiClient):
        still_open = []
        for pos in self.open_positions:
            result = client.get_market_result(pos["ticker"])
            if result is None:
                still_open.append(pos)
                continue
            won    = (result == pos["side"].lower())
            payout = pos["contracts"] * 1.00 if won else 0.0
            pnl    = payout - pos["total_cost"] if won else -pos["total_cost"]
            self.balance += payout
            label  = "WIN" if won else "LOSS"
            self.closed_trades.append({**pos, "result": label, "pnl": pnl})
            self._log(pos, label, pnl)
            print(f"  [PAPER-{self.strategy.upper()[:5]}] {label}"
                  f"  {pos['ticker']}  {pos['side']} x{pos['contracts']}"
                  f"  pnl ${pnl:+.2f}  paper_bal ${self.balance:.2f}")
        self.open_positions = still_open

    def _log(self, pos, result, pnl):
        with open(PAPER_TRADE_LOG, "a", newline="") as f:
            csv.writer(f).writerow([
                pos["open_time"], pos["strategy"], pos["ticker"],
                pos["title"][:60], pos["side"], pos["price_cents"],
                pos["contracts"], pos["bet_usd"], pos["fee_usd"],
                pos["total_cost"], pos["composite_score"],
                "{:.1f}%".format(pos["kelly_pct"]*100),
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                result, round(pnl,4), round(self.balance,4),
            ])

    def stats(self):
        n = len(self.closed_trades)
        if not n:
            return {"trades": 0, "wins": 0, "wr": 0, "pnl": 0, "bal": self.balance}
        wins = sum(1 for t in self.closed_trades if t["result"] == "WIN")
        return {
            "trades": n, "wins": wins,
            "wr": wins/n*100,
            "pnl": sum(t["pnl"] for t in self.closed_trades),
            "bal": self.balance,
        }

    def print_stats(self):
        s = self.stats()
        start = PAPER_STARTING_BALANCE
        print(f"  [PAPER {self.strategy.upper():<12}]  "
              f"bal ${self.balance:.2f} / start ${start:.2f}  "
              f"trades {s['trades']}  wr {s['wr']:.0f}%  "
              f"pnl ${s['pnl']:+.2f}  "
              f"open {len(self.open_positions)}")


# -----------------------------------------------------------------------------
#  LIVE MASTER TRADER
# -----------------------------------------------------------------------------

class MasterTrader:

    def __init__(self, client: KalshiClient):
        self.client         = client
        self.balance        = MASTER_STARTING_BALANCE
        self.open_positions = []
        self.closed_trades  = []
        self.harvest_done   = False
        _init_csv(MASTER_TRADE_LOG, [
            "open_time", "strategy", "ticker", "title",
            "side", "price_cents", "contracts", "bet_usd",
            "fee_usd", "total_cost", "composite_score", "kelly_pct",
            "close_time", "result", "pnl", "balance_after",
        ])
        if LIVE_TRADING:
            try:
                real_bal = client.get_portfolio_balance()
                if real_bal > 0:
                    self.balance = real_bal
                    print(f"  [Live] Synced balance: ${real_bal:.2f}")
                else:
                    print(f"  [Live] $0 returned -- using ${MASTER_STARTING_BALANCE:.2f}")
            except Exception as e:
                print(f"  [Live] Balance sync failed: {e}")

    def can_trade(self):
        return (not self.harvest_done
                and len(self.open_positions) < MASTER_MAX_POSITIONS
                and self.balance >= MIN_BET)

    def place_bet(self, signal: dict) -> dict | None:
        price_d     = signal["price_cents"] / 100.0
        price_cents = signal["price_cents"]
        true_prob   = signal["true_prob"]
        cs          = signal.get("_composite_score", 0.5)

        if signal.get("side") not in ("YES", "NO"):
            return None
        if price_cents <= 0 or price_cents >= 100:
            return None
        if price_d >= true_prob - MASTER_MIN_EDGE:
            return None

        fee_per   = KalshiClient.calc_fee(1, price_cents)
        eff_k     = MASTER_KELLY * (0.5 + 0.5 * cs)
        kf        = KalshiClient.calc_kelly(true_prob, price_d, fee_per, eff_k)
        if signal.get("kelly_override") is not None:
            kf = max(kf, KalshiClient.calc_kelly(
                true_prob, price_d, fee_per, signal["kelly_override"]))
        if kf <= 0:
            return None

        dollar_bet  = max(MIN_BET, min(MASTER_MAX_BET, self.balance * kf))
        contracts   = max(1, int(dollar_bet / (price_d + fee_per)))
        total_cost  = contracts * (price_d + fee_per)
        if total_cost > MASTER_MAX_EXPOSURE * self.balance:
            contracts  = max(1, int(MASTER_MAX_EXPOSURE * self.balance / (price_d + fee_per)))
            total_cost = contracts * (price_d + fee_per)
        if total_cost > self.balance or contracts < 1:
            return None

        order_id = None
        if LIVE_TRADING:
            resp = self.client.place_order(
                ticker=signal["ticker"], side=signal["side"].lower(),
                contracts=contracts, price_cents=price_cents, order_type="limit",
            )
            if "error" in resp:
                print(f"  [Live] REJECTED: {resp['error']}")
                return None
            order_id = resp.get("order_id")
            print(f"  [Live] Order -> {order_id}  status={resp.get('status','')}")
            try:
                self.balance = self.client.get_portfolio_balance()
            except Exception:
                self.balance -= total_cost
        else:
            self.balance -= total_cost

        pos = {
            "open_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "strategy": signal["strategy"], "ticker": signal["ticker"],
            "title": signal["title"], "side": signal["side"],
            "price_cents": price_cents, "contracts": contracts,
            "bet_usd": round(contracts * price_d, 4),
            "fee_usd": round(contracts * fee_per, 4),
            "total_cost": round(total_cost, 4),
            "composite_score": cs, "kelly_pct": kf,
            "true_prob": true_prob, "reason": signal.get("reason",""),
            "order_id": order_id,
        }
        self.open_positions.append(pos)
        return pos

    def check_resolutions(self):
        still_open = []
        for pos in self.open_positions:
            result = self.client.get_market_result(pos["ticker"])
            if result is None:
                still_open.append(pos)
                continue
            won    = (result == pos["side"].lower())
            payout = pos["contracts"] * 1.00 if won else 0.0
            pnl    = payout - pos["total_cost"] if won else -pos["total_cost"]
            if LIVE_TRADING:
                try:
                    self.balance = self.client.get_portfolio_balance()
                except Exception:
                    self.balance += payout if won else 0
            else:
                self.balance += payout
            label = "WIN" if won else "LOSS"
            self.closed_trades.append({**pos, "result": label, "pnl": pnl})
            self._log(pos, label, pnl)
            print(f"  [LIVE-BTC] {label}  {pos['ticker']}"
                  f"  {pos['side']} x{pos['contracts']}"
                  f"  pnl ${pnl:+.2f}  bal ${self.balance:.2f}")
            if self.balance >= MASTER_TARGET_BALANCE and not self.harvest_done:
                self._harvest_alert()
        self.open_positions = still_open

    def _harvest_alert(self):
        print("\n" + "="*64)
        print(f"  TARGET REACHED: ${self.balance:,.2f} !!!")
        print(f"  Withdraw ${self.balance-MASTER_WITHDRAW_TO:,.2f}  "
              f"Keep ${MASTER_WITHDRAW_TO:,.2f} for next cycle.")
        print("="*64)
        self.harvest_done = True

    def _log(self, pos, result, pnl):
        with open(MASTER_TRADE_LOG, "a", newline="") as f:
            csv.writer(f).writerow([
                pos["open_time"], pos["strategy"], pos["ticker"],
                pos["title"][:60], pos["side"], pos["price_cents"],
                pos["contracts"], pos["bet_usd"], pos["fee_usd"],
                pos["total_cost"], round(pos["composite_score"],3),
                "{:.1f}%".format(pos["kelly_pct"]*100),
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                result, round(pnl,4), round(self.balance,4),
            ])

    def stats(self):
        n = len(self.closed_trades)
        if not n:
            return {}
        wins = [t for t in self.closed_trades if t["result"]=="WIN"]
        return {
            "trades": n, "wins": len(wins), "losses": n-len(wins),
            "win_rate": len(wins)/n*100,
            "total_pnl": sum(t["pnl"] for t in self.closed_trades),
            "balance": self.balance,
        }

    def print_stats(self):
        s   = self.stats()
        bal = self.balance
        print("\n  " + "-"*62)
        if not s:
            print(f"  [LIVE BTC/RSI]  balance ${bal:.2f}  |  No closed trades yet.")
        else:
            print(f"  [LIVE BTC/RSI]  {s['wins']}W/{s['losses']}L"
                  f"  wr {s['win_rate']:.1f}%"
                  f"  pnl ${s['total_pnl']:+.2f}"
                  f"  bal ${bal:.2f}")
        pct    = min(1.0, (bal - MASTER_STARTING_BALANCE) /
                     max(MASTER_TARGET_BALANCE - MASTER_STARTING_BALANCE, 1))
        filled = int(round(pct * 44))
        bar    = "#"*filled + "."*(44-filled)
        print(f"  [{bar}] ${bal:.2f} / ${MASTER_TARGET_BALANCE:.0f}"
              f"  ({pct*100:.1f}%)")
        if self.open_positions:
            exp = sum(p["total_cost"] for p in self.open_positions)
            print(f"  Open {len(self.open_positions)}/{MASTER_MAX_POSITIONS}"
                  f"  exposure ${exp:.2f}")
            for p in self.open_positions:
                oid = f" [{p['order_id'][:8]}]" if p.get("order_id") else ""
                print(f"    {p['ticker']}  {p['side']} x{p['contracts']}"
                      f"  @ {p['price_cents']}c  ${p['total_cost']:.2f}{oid}")
        print("  " + "-"*62)


# -----------------------------------------------------------------------------
#  DISPLAY
# -----------------------------------------------------------------------------

def print_header():
    mode = "LIVE" if LIVE_TRADING else "PAPER"
    print("\n" + "="*64)
    print(f"  KALSHI MASTER BOT  |  {mode}  |  BTC dominant")
    print("="*64)
    print(f"  Live  : BTC/RSI  ->  ${MASTER_STARTING_BALANCE:.0f} real balance")
    print(f"  Paper : Sports / Economics / News RSS  ->  ${PAPER_STARTING_BALANCE:.0f} each")
    print(f"  Logs  : {MASTER_TRADE_LOG}  |  {PAPER_TRADE_LOG}  |  {SIGNAL_LOG}")
    print("="*64)
    print("  Press Ctrl+C to stop.\n")


def print_cycle(cycle, trader, papers, raw_count,
                live_sel, paper_sel_all, scan_tag):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"\n{'-'*64}")
    print(f"  [{ts}]  Cycle #{cycle}  [{scan_tag}]"
          f"  Live bal ${trader.balance:.2f}"
          f"  open {len(trader.open_positions)}/{MASTER_MAX_POSITIONS}")
    print(f"  Raw signals {raw_count}  ->  live {len(live_sel)}"
          f"  paper {len(paper_sel_all)}")
    for strat, paper in papers.items():
        s = paper.stats()
        print(f"    paper-{strat:<12}  bal ${paper.balance:.2f}"
              f"  trades {s['trades']}  pnl ${s['pnl']:+.2f}"
              f"  open {len(paper.open_positions)}")
    if live_sel:
        for s in live_sel:
            print(f"    [LIVE] {s['side']} {s['ticker']}"
                  f"  @ {s['price_cents']}c"
                  f"  cs={s.get('_composite_score',0):.2f}"
                  f"  bet~${s.get('_bet_size',0):.2f}")
    if paper_sel_all:
        for s in paper_sel_all:
            print(f"    [PAPER-{s.get('strategy','').upper()[:5]}]"
                  f" {s['side']} {s['ticker']}"
                  f"  @ {s['price_cents']}c"
                  f"  cs={s.get('_composite_score',0):.2f}")


# -----------------------------------------------------------------------------
#  MAIN LOOP
# -----------------------------------------------------------------------------

def run():
    print_header()

    client = KalshiClient()
    print("  Connecting...")
    try:
        client.login()
    except Exception as e:
        print(f"  Login failed: {e}")
        sys.exit(1)

    if LIVE_TRADING:
        try:
            bal = client.get_portfolio_balance()
            print(f"  Connected  |  Account balance: ${bal:.2f}")
        except Exception as e:
            print(f"  Connected  |  Balance fetch failed: {e}")
    else:
        print("  Connected  (PAPER mode)")
    print()

    # init logs
    _init_csv(SIGNAL_LOG, _SIGNAL_LOG_HEADER)
    _init_csv(PAPER_TRADE_LOG, _PAPER_HEADER)

    trader   = MasterTrader(client)
    papers   = {s: PaperAccount(s) for s in PAPER_STRATEGIES}

    sports   = SportsStrategy(client)
    econ     = EconomicsStrategy(client)
    btc_rsi  = CryptoMarketStrategy(client)
    news     = NewsStrategy(client)

    cycle          = 0
    last_full_scan = 0.0

    while True:
        cycle += 1
        now = time.time()
        do_full = (now - last_full_scan) >= FULL_SCAN_INTERVAL_SECONDS

        try:
            # 1. Check live resolutions
            if trader.open_positions:
                trader.check_resolutions()

            # 2. Check paper resolutions
            for paper in papers.values():
                if paper.open_positions:
                    paper.check_resolutions(client)

            # 3. Gather signals
            raw = []
            if do_full:
                raw.extend(sports.get_signals())
                raw.extend(econ.get_signals())
                raw.extend(btc_rsi.get_signals())
                last_full_scan = time.time()
            raw.extend(news.get_signals())

            deduped  = dedup_signals(raw, trader.open_positions)
            scan_tag = "FULL" if do_full else "NEWS"

            # 4. Live selection (BTC only)
            live_sel = master_select(deduped, trader.balance,
                                     trader.open_positions)

            # 5. Paper selection (Sports / Econ / News)
            paper_sel_all = []
            paper_sel_by  = {}
            for strat, paper in papers.items():
                sel = paper_select(deduped, strat, paper.balance,
                                   paper.open_positions)
                paper_sel_all.extend(sel)
                paper_sel_by[strat] = sel

            print_cycle(cycle, trader, papers, len(raw),
                        live_sel, paper_sel_all, scan_tag)

            # 6. Log all candidates
            try:
                p_bals  = {s: p.balance for s, p in papers.items()}
                p_opens = {s: len(p.open_positions) for s, p in papers.items()}
                log_signals(cycle, scan_tag, deduped,
                            live_sel, paper_sel_all,
                            trader.balance, p_bals,
                            len(trader.open_positions), p_opens)
            except Exception:
                pass

            # 7. Place LIVE trades (BTC only)
            if not trader.harvest_done:
                for sig in live_sel:
                    if not trader.can_trade():
                        break
                    pos = trader.place_bet(sig)
                    if pos:
                        print(f"  [LIVE] BTC/RSI  {pos['side']} {pos['ticker']}"
                              f"  x{pos['contracts']} @ {pos['price_cents']}c"
                              f"  ${pos['total_cost']:.2f}")
                        print(f"    {sig.get('reason','')[:80]}")

            # 8. Place PAPER trades
            for strat, sel in paper_sel_by.items():
                paper = papers[strat]
                for sig in sel:
                    if len(paper.open_positions) >= 3:
                        break
                    pos = paper.place_bet(sig)
                    if pos:
                        print(f"  [PAPER-{strat.upper()[:5]}]"
                              f"  {pos['side']} {pos['ticker']}"
                              f"  x{pos['contracts']} @ {pos['price_cents']}c"
                              f"  ${pos['total_cost']:.2f}")
                        print(f"    {sig.get('reason','')[:80]}")
                        if strat == "sports":
                            sports.record_series_bet(sig["ticker"])

            # 9. Export dashboard
            try:
                export_dashboard(
                    open_positions=trader.open_positions,
                    balance=trader.balance,
                )
            except Exception as ex:
                print(f"  [Dashboard] {ex}")

            # 10. Stats + sleep
            trader.print_stats()
            for paper in papers.values():
                paper.print_stats()
            print(f"\n  Next scan in {POLL_INTERVAL_SECONDS}s ...")
            time.sleep(POLL_INTERVAL_SECONDS)

        except KeyboardInterrupt:
            print("\n\n  Bot stopped.")
            trader.print_stats()
            for paper in papers.values():
                paper.print_stats()
            print(f"\n  Logs: {MASTER_TRADE_LOG}  |  {PAPER_TRADE_LOG}  |  {SIGNAL_LOG}")
            sys.exit(0)

        except requests.exceptions.RequestException as e:
            print(f"\n  [NET] {e} -- retrying in 30s")
            time.sleep(30)

        except Exception as e:
            import traceback
            print(f"\n  [ERR] {e}")
            traceback.print_exc()
            print("  Retrying in 30s ...")
            time.sleep(30)


if __name__ == "__main__":
    run()
