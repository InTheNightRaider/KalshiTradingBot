"""
fetch_m5_data.py
================
Downloads 6 months of 5-minute EUR/USD and GBP/USD data.

TWO METHODS — run whichever works for you:

  METHOD 1 (IBKR) — requires TWS or IB Gateway running
    python fetch_m5_data.py --source ibkr

  METHOD 2 (Dukascopy) — no account needed, just internet
    python fetch_m5_data.py --source dukascopy

Output: saves CSV files that tjr_m5_backtest_full.py reads.
"""

import argparse, struct, lzma, time, os, sys
import urllib.request
from datetime import datetime, timedelta, timezone
import pandas as pd

PAIRS_DUKA = {'EUR/USD': 'EURUSD', 'GBP/USD': 'GBPUSD'}
PAIRS_IBKR = {'EUR/USD': ('EUR', 'USD'), 'GBP/USD': ('GBP', 'USD')}
OUT_DIR    = os.path.dirname(os.path.abspath(__file__))
MONTHS     = 6

def fetch_dukascopy(pair_name, duka_sym):
    """Download day-by-day M5 candles from Dukascopy public feed."""
    print(f"\n[Dukascopy] {pair_name}")
    end   = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=MONTHS * 31)

    all_bars = []
    day = start
    while day < end:
        # Skip weekends
        if day.weekday() >= 5:
            day += timedelta(days=1)
            continue

        year  = day.year
        month = day.month - 1   # Dukascopy uses 0-indexed months
        d     = day.day
        url = (f"https://datafeed.dukascopy.com/datafeed/"
               f"{duka_sym}/{year}/{month:02d}/{d:02d}/BID_candles_M5_1.bi5")

        try:
            req  = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            data = urllib.request.urlopen(req, timeout=20).read()
            raw  = lzma.decompress(data)

            # 24-byte records: uint32 time_ms + 4x uint32 price + float32 volume
            # Prices are stored as integer * 100000 for 5-decimal pairs
            n = len(raw) // 24
            for i in range(n):
                o = i * 24
                time_ms, op, hi, lo, cl, vol = struct.unpack('>IIIIIf', raw[o:o+24])
                bar_time = (day.replace(tzinfo=timezone.utc)
                            + timedelta(milliseconds=int(time_ms)))
                all_bars.append({
                    'datetime': bar_time,
                    'open':  op  / 100000,
                    'high':  hi  / 100000,
                    'low':   lo  / 100000,
                    'close': cl  / 100000,
                    'volume': vol
                })
            print(f"  {day.date()} — {n} bars", flush=True)

        except Exception as e:
            if '404' not in str(e):   # 404 = weekend/holiday, skip silently
                print(f"  {day.date()} — skip ({e})", flush=True)

        day += timedelta(days=1)
        time.sleep(0.15)   # be polite to Dukascopy

    if not all_bars:
        print("  No data retrieved.")
        return None

    df = pd.DataFrame(all_bars).set_index('datetime')
    # Validate — EUR/USD should be between 0.8 and 1.5
    med = df['close'].median()
    if not (0.8 < med < 2.0):
        # Prices might be raw — try dividing differently
        print(f"  Price check failed (median={med:.5f}), adjusting scale...")
        for col in ['open','high','low','close']:
            df[col] = df[col] / 10

    out = os.path.join(OUT_DIR, f"{pair_name.replace('/','')}_M5_6months.csv")
    df.to_csv(out)
    print(f"  Saved {len(df)} bars → {out}")
    return df


def fetch_ibkr(pair_name, base, quote):
    """Pull M5 history from IBKR via ib_insync (requires TWS/Gateway running)."""
    try:
        from ib_insync import IB, Forex
    except ImportError:
        print("  Install: pip install ib_insync")
        return None

    print(f"\n[IBKR] {pair_name} — connecting to TWS on port 7497...")
    ib = IB()
    try:
        ib.connect('127.0.0.1', 7497, clientId=15, timeout=10)
    except Exception as e:
        print(f"  Could not connect: {e}")
        print("  Make sure TWS or IB Gateway is running (paper port 7497)")
        return None

    contract = Forex(base + quote)
    ib.qualifyContracts(contract)

    print(f"  Requesting 6 months of M5 data...", flush=True)
    bars = ib.reqHistoricalData(
        contract,
        endDateTime='',
        durationStr='6 M',
        barSizeSetting='5 mins',
        whatToShow='MIDPOINT',
        useRTH=False,
        keepUpToDate=False,
    )
    ib.disconnect()

    if not bars:
        print("  No data returned. Check market data permissions in TWS.")
        return None

    df = pd.DataFrame([{
        'datetime': pd.Timestamp(b.date, tz='UTC'),
        'open':  b.open,
        'high':  b.high,
        'low':   b.low,
        'close': b.close,
        'volume': b.volume,
    } for b in bars]).set_index('datetime')

    out = os.path.join(OUT_DIR, f"{pair_name.replace('/','')}_M5_6months.csv")
    df.to_csv(out)
    print(f"  Saved {len(df)} bars → {out}")
    return df


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', choices=['ibkr','dukascopy'], default='dukascopy',
                        help='Data source: ibkr (needs TWS running) or dukascopy (no account needed)')
    args = parser.parse_args()

    print(f"{'='*55}")
    print(f"  Fetching 6-month M5 data via {args.source.upper()}")
    print(f"{'='*55}")

    for pair_name in ['EUR/USD', 'GBP/USD']:
        if args.source == 'dukascopy':
            fetch_dukascopy(pair_name, PAIRS_DUKA[pair_name])
        else:
            base, quote = PAIRS_IBKR[pair_name]
            fetch_ibkr(pair_name, base, quote)

    print("\nDone. Run tjr_m5_backtest_full.py to run the backtest.")
