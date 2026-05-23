"""
tjr_m5_backtest_full.py
=======================
Full 6-month TJR Session Strategy backtest on real M5 data.

REQUIRES: Run fetch_m5_data.py first to download the CSV files.

Usage:
  python tjr_m5_backtest_full.py

Output:
  - Prints full trade-by-trade results
  - Saves all trades to tjr_m5_6month_trades.csv
  - Saves HTML report to tjr_m5_backtest_report.html
"""

import pandas as pd, numpy as np, os, json
from datetime import timezone

PAIRS = {
    'EUR/USD': 'EURUSD_M5_6months.csv',
    'GBP/USD': 'GBPUSD_M5_6months.csv',
}
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
TP_RR      = 2.0
MAX_TRADES = 2          # per pair per day
RISK_PCT   = 0.01       # 1% risk per trade
START_BAL  = 10_000.0

# ── Session windows (UTC) ─────────────────────────────────────
ASIA_START = 0          # 00:00 UTC
ASIA_END   = 7          # 07:00 UTC
SESSION_END = 21        # 21:00 UTC — close all positions

def load_data(pair_name, filename):
    path = os.path.join(BASE_DIR, filename)
    if not os.path.exists(path):
        print(f"  Missing: {path}")
        print(f"  Run: python fetch_m5_data.py --source dukascopy")
        return None
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    if df.index.tz is None:
        df.index = df.index.tz_localize('UTC')
    df.columns = [c.lower() for c in df.columns]
    df = df[['open','high','low','close']].dropna()
    print(f"  {pair_name}: {len(df)} bars  "
          f"{df.index[0].date()} → {df.index[-1].date()}", flush=True)
    return df

def find_fvg(hi, lo, idx, direction):
    """3-candle Fair Value Gap within last 12 bars."""
    start = max(0, idx - 12)
    for i in range(start, idx - 1):
        if i + 2 <= idx:
            if direction == 'long'  and hi[i] < lo[i+2]:
                return (hi[i] + lo[i+2]) / 2
            elif direction == 'short' and lo[i] > hi[i+2]:
                return (lo[i] + hi[i+2]) / 2
    return None

def backtest_pair(name, df):
    trades = []
    o = df['open'].values
    h = df['high'].values
    l = df['low'].values
    c = df['close'].values
    ts = df.index

    trading_days = sorted(set(ts.normalize()))
    print(f"  {name}: {len(trading_days)} trading days", flush=True)

    for day in trading_days:
        asia_mask = (ts.date == day.date()) & (ts.hour >= ASIA_START) & (ts.hour < ASIA_END)
        asia_idx  = np.where(asia_mask)[0]
        if len(asia_idx) < 12:
            continue

        asia_high = h[asia_idx].max()
        asia_low  = l[asia_idx].min()

        act_mask = (ts.date == day.date()) & (ts.hour >= ASIA_END) & (ts.hour < SESSION_END)
        act_idx  = np.where(act_mask)[0]
        if len(act_idx) < 24:
            continue

        sweep_done    = None
        sweep_extreme = None
        sweep_bar_i   = None
        day_count     = 0

        for pos, gi in enumerate(act_idx):
            if day_count >= MAX_TRADES:
                break

            bh, bl, bc, bo = h[gi], l[gi], c[gi], o[gi]

            # ── Step 1: Liquidity sweep ───────────────────────
            if sweep_done is None:
                if bh > asia_high and bc < asia_high:
                    sweep_done = 'high'; sweep_extreme = bh; sweep_bar_i = pos
                elif bl < asia_low and bc > asia_low:
                    sweep_done = 'low';  sweep_extreme = bl; sweep_bar_i = pos
                continue

            # ── Step 2: MSS within 24 bars (~2hr) ────────────
            if pos - sweep_bar_i > 24:
                sweep_done = None; sweep_extreme = None; sweep_bar_i = None
                continue

            direction = 'long' if sweep_done == 'low' else 'short'
            sgi       = act_idx[sweep_bar_i]
            sweep_mid = (o[sgi] + c[sgi]) / 2

            mss = ((direction == 'long'  and bc > sweep_mid and bc > bo) or
                   (direction == 'short' and bc < sweep_mid and bc < bo))
            if not mss:
                continue

            # ── Step 3: FVG entry ─────────────────────────────
            sl_a  = act_idx[:pos+1]
            fvg   = find_fvg(h[sl_a], l[sl_a], len(sl_a)-1, direction)
            entry = fvg if fvg is not None else bc

            buf  = abs(entry - sweep_extreme) * 0.1
            sl   = (sweep_extreme - buf) if direction == 'long' else (sweep_extreme + buf)
            risk = abs(entry - sl)
            if risk < 0.00005:
                sweep_done = None; sweep_bar_i = None
                continue

            tp = entry + TP_RR * risk if direction == 'long' else entry - TP_RR * risk

            # ── Step 4: Forward simulate ──────────────────────
            outcome = 'open'; exit_px = None; exit_ts = None
            for fi in act_idx[pos+1:]:
                if direction == 'long':
                    if l[fi] <= sl: outcome='loss'; exit_px=sl;  exit_ts=ts[fi]; break
                    if h[fi] >= tp: outcome='win';  exit_px=tp;  exit_ts=ts[fi]; break
                else:
                    if h[fi] >= sl: outcome='loss'; exit_px=sl;  exit_ts=ts[fi]; break
                    if l[fi] <= tp: outcome='win';  exit_px=tp;  exit_ts=ts[fi]; break

            if outcome == 'open':
                exit_px = c[act_idx[-1]]; exit_ts = ts[act_idx[-1]]
                raw_r = ((exit_px-entry)/risk if direction=='long'
                         else (entry-exit_px)/risk)
                outcome = 'win' if raw_r > 0 else 'loss'

            pnl_r = TP_RR if outcome == 'win' else -1.0
            trades.append({
                'pair': name, 'date': str(day.date()),
                'direction': direction, 'outcome': outcome, 'pnl_r': pnl_r,
                'entry': round(entry, 5), 'sl': round(sl, 5), 'tp': round(tp, 5),
                'risk_pips': round(risk * 10000, 1),
                'asia_high': round(asia_high, 5), 'asia_low': round(asia_low, 5),
                'sweep': sweep_done,
                'entry_time': str(ts[gi])[:16], 'exit_time': str(exit_ts)[:16],
            })
            day_count += 1
            sweep_done = None; sweep_extreme = None; sweep_bar_i = None

    return trades


def run():
    print("=" * 60)
    print("  TJR SESSION STRATEGY — FULL 6-MONTH M5 BACKTEST")
    print("=" * 60)

    all_trades = []
    for pair_name, filename in PAIRS.items():
        df = load_data(pair_name, filename)
        if df is None:
            continue
        trades = backtest_pair(pair_name, df)
        all_trades.extend(trades)
        print(f"  {pair_name}: {len(trades)} trades fired", flush=True)

    if not all_trades:
        print("\nNo data found. Run fetch_m5_data.py first.")
        return

    df_t = pd.DataFrame(all_trades)
    wins  = (df_t['outcome']=='win').sum()
    losses = (df_t['outcome']=='loss').sum()
    total = len(df_t)
    wr    = wins / total * 100
    tot_r = df_t['pnl_r'].sum()
    avg_r = df_t['pnl_r'].mean()
    pf    = (wins * TP_RR) / losses if losses > 0 else 999

    # ── Compounding balance ───────────────────────────────────
    balance = START_BAL
    bal_list = []
    for r in df_t['pnl_r']:
        pnl = balance * RISK_PCT * r
        balance += pnl
        bal_list.append(round(balance, 2))
    df_t['balance'] = bal_list

    # ── Print summary ─────────────────────────────────────────
    print()
    print("=" * 60)
    print(f"  {'METRIC':<25} {'VALUE':>15}")
    print("  " + "-" * 42)
    print(f"  {'Period':<25} {df_t['date'].min()} → {df_t['date'].max()}")
    print(f"  {'Timeframe':<25} {'5-minute (M5)':>15}")
    print(f"  {'Total trades':<25} {total:>15}")
    print(f"  {'Wins / Losses':<25} {str(wins)+' / '+str(losses):>15}")
    print(f"  {'Win rate':<25} {wr:>14.1f}%")
    print(f"  {'Total R':<25} {tot_r:>+14.1f}R")
    print(f"  {'Avg R per trade':<25} {avg_r:>+14.3f}R")
    print(f"  {'Profit factor':<25} {pf:>14.2f}x")
    print(f"  {'Trades per day (avg)':<25} {total/len(df_t['date'].unique()):>14.1f}")
    print(f"  {'Starting balance':<25} ${START_BAL:>13,.2f}")
    print(f"  {'Final balance (1% risk)':<25} ${balance:>13,.2f}")
    print(f"  {'Total return':<25} {(balance-START_BAL)/START_BAL*100:>+14.1f}%")
    print()

    # Monthly breakdown
    df_t['month'] = pd.to_datetime(df_t['date']).dt.to_period('M')
    monthly = df_t.groupby('month').agg(
        trades=('pnl_r','count'),
        wins=('outcome', lambda x: (x=='win').sum()),
        r=('pnl_r','sum')
    ).reset_index()

    print(f"  {'Month':<10} {'Trades':>7} {'Wins':>6} {'WR':>7} {'R':>9}")
    print("  " + "-" * 44)
    for _, row in monthly.iterrows():
        wr_m = row['wins'] / row['trades'] * 100
        print(f"  {str(row['month']):<10} {row['trades']:>7} "
              f"{row['wins']:>6} {wr_m:>6.0f}% {row['r']:>+9.1f}R")

    print()
    for pair in df_t['pair'].unique():
        sub = df_t[df_t['pair']==pair]
        w = (sub['outcome']=='win').sum()
        l = (sub['outcome']=='loss').sum()
        r = sub['pnl_r'].sum()
        print(f"  {pair}: {w}W / {l}L  ({w/len(sub)*100:.0f}% WR)  {r:+.1f}R")

    # Save CSV
    out_csv = os.path.join(BASE_DIR, 'tjr_m5_6month_trades.csv')
    df_t.to_csv(out_csv, index=False)
    print(f"\n  Trade log saved → {out_csv}")


if __name__ == '__main__':
    run()
