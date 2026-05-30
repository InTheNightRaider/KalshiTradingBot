"""Quick test — shows exactly why Dukascopy is failing."""
import urllib.request, lzma, struct
from datetime import datetime, timezone

# Test a single known trading day
test_days = [
    (2026, 3, 1),   # March 1 2026
    (2026, 2, 3),   # Feb 3 2026
    (2025, 11, 21), # Nov 21 2025
]

for year, month_real, day in test_days:
    month_idx = month_real - 1  # Dukascopy 0-indexed
    url = (f"https://datafeed.dukascopy.com/datafeed/EURUSD/"
           f"{year}/{month_idx:02d}/{day:02d}/BID_candles_M5_1.bi5")
    print(f"\nTesting: {year}-{month_real:02d}-{day:02d}")
    print(f"  URL: {url}")
    try:
        req  = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        data = urllib.request.urlopen(req, timeout=25).read()
        print(f"  Downloaded: {len(data)} bytes compressed")
        raw = lzma.decompress(data)
        print(f"  Decompressed: {len(raw)} bytes  ({len(raw)//24} records if 24-byte, {len(raw)//20} if 20-byte)")

        # Try 24-byte big-endian: uint32 + 4x uint32 + float32
        if len(raw) >= 24:
            rec = struct.unpack('>IIIIIf', raw[:24])
            prices_100k = [r/100000 for r in rec[1:5]]
            print(f"  Format A (>IIIIIf): time={rec[0]}ms, prices={[round(p,5) for p in prices_100k]}")

        # Try 24-byte big-endian: uint32 + 5x float32
        if len(raw) >= 24:
            rec2 = struct.unpack('>Ifffff', raw[:24])
            print(f"  Format B (>Ifffff): time={rec2[0]}ms, prices={[round(p,5) for p in rec2[1:]]}")

        break  # Stop after first success

    except Exception as e:
        print(f"  ERROR: {e}")
