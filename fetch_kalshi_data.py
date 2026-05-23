# ============================================================
#  fetch_kalshi_data.py
#  Run this once on your machine to pull Kalshi market data.
#  Output: kalshi_data.json  (Claude reads this for analysis)
# ============================================================
import requests, os, json
from datetime import datetime, timezone, timedelta
from dotenv import dotenv_values

env = dotenv_values(os.path.join(os.path.dirname(__file__), ".env"))
EMAIL    = env.get("KALSHI_EMAIL")
PASSWORD = env.get("KALSHI_PASSWORD")

# Try demo first, fall back to prod
URLS = [
    "https://demo-api.kalshi.co/trade-api/v2",
    "https://api.kalshi.co/trade-api/v2",
]

def login(base):
    r = requests.post(f"{base}/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=10)
    if r.status_code == 200:
        return r.json().get("token") or r.json().get("member_id")
    return None

token, BASE = None, None
for url in URLS:
    t = login(url)
    if t:
        token, BASE = t, url
        print(f"Logged in via {url}")
        break

if not token:
    print("ERROR: Could not log in. Check KALSHI_EMAIL and KALSHI_PASSWORD in .env")
    exit(1)

H = {"Authorization": f"Bearer {token}"}

def get_markets(params):
    r = requests.get(f"{BASE}/markets", headers=H, params=params, timeout=15)
    if r.status_code == 200:
        return r.json().get("markets", [])
    print(f"  markets error {r.status_code}: {r.text[:200]}")
    return []

def get_events(params):
    r = requests.get(f"{BASE}/events", headers=H, params=params, timeout=15)
    if r.status_code == 200:
        return r.json().get("events", [])
    return []

def get_series_list():
    r = requests.get(f"{BASE}/series", headers=H, params={"limit": 200}, timeout=15)
    if r.status_code == 200:
        data = r.json()
        return data.get("series", data.get("items", []))
    return []

output = {}

# ── 1. All available series (so we know what categories exist) ──────────────
print("Fetching series list...")
series = get_series_list()
output["series"] = [{"ticker": s.get("ticker"), "title": s.get("title",""),
                     "category": s.get("category","")} for s in series]
print(f"  Got {len(series)} series")

# ── 2. Recently resolved markets (last 7 days) ──────────────────────────────
print("Fetching recently resolved markets...")
resolved = get_markets({"status": "finalized", "limit": 200})
output["resolved_markets"] = [
    {
        "ticker":           m.get("ticker"),
        "title":            m.get("title",""),
        "category":         m.get("category",""),
        "event_ticker":     m.get("event_ticker",""),
        "result":           m.get("result",""),
        "yes_bid":          m.get("yes_bid"),
        "yes_ask":          m.get("yes_ask"),
        "last_price":       m.get("last_price"),
        "volume":           m.get("volume"),
        "open_time":        m.get("open_time",""),
        "close_time":       m.get("close_time",""),
        "expiration_time":  m.get("expiration_time",""),
    }
    for m in resolved
]
print(f"  Got {len(resolved)} resolved markets")

# ── 3. Currently open markets ────────────────────────────────────────────────
print("Fetching open markets...")
open_markets = get_markets({"status": "open", "limit": 200})
output["open_markets"] = [
    {
        "ticker":       m.get("ticker"),
        "title":        m.get("title",""),
        "category":     m.get("category",""),
        "event_ticker": m.get("event_ticker",""),
        "yes_bid":      m.get("yes_bid"),
        "yes_ask":      m.get("yes_ask"),
        "last_price":   m.get("last_price"),
        "volume":       m.get("volume"),
        "close_time":   m.get("close_time",""),
    }
    for m in open_markets
]
print(f"  Got {len(open_markets)} open markets")

# ── 4. Recent events ─────────────────────────────────────────────────────────
print("Fetching recent events...")
events = get_events({"limit": 100, "status": "finalized"})
output["events"] = [
    {
        "event_ticker": e.get("event_ticker"),
        "title":        e.get("title",""),
        "category":     e.get("category",""),
        "sub_title":    e.get("sub_title",""),
    }
    for e in events
]
print(f"  Got {len(events)} events")

# ── 5. Portfolio / balance ────────────────────────────────────────────────────
print("Fetching portfolio balance...")
rb = requests.get(f"{BASE}/portfolio/balance", headers=H, timeout=10)
if rb.status_code == 200:
    output["balance"] = rb.json()
    print(f"  Balance: {rb.json()}")
else:
    output["balance"] = {"error": rb.status_code}

# ── Save ──────────────────────────────────────────────────────────────────────
out_path = os.path.join(os.path.dirname(__file__), "kalshi_data.json")
with open(out_path, "w") as f:
    json.dump(output, f, indent=2)

print(f"\nDone! Saved to: {out_path}")
print(f"  Series:           {len(output['series'])}")
print(f"  Resolved markets: {len(output['resolved_markets'])}")
print(f"  Open markets:     {len(output['open_markets'])}")
print(f"  Events:           {len(output['events'])}")
print("\nNow go back to Claude and say 'I ran the script' — it will read the file and analyze it.")
