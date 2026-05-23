#!/usr/bin/env python3
"""
Kalshi REST API v2 client.
Auth priority:
  1. KALSHI_API_KEY  in .env  (recommended — no login request needed)
  2. KALSHI_EMAIL + KALSHI_PASSWORD  (legacy email/password login)
Supports both paper trading (read-only) and live order placement.
"""

import math, os, time, socket, uuid, requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

BASE_URL = "https://trading-api.kalshi.com/trade-api/v2"


class KalshiClient:

    def __init__(self):
        self.session   = requests.Session()
        self.session.headers.update({"Content-Type": "application/json",
                                     "Accept": "application/json"})
        self._last_req = 0
        self._base_url = BASE_URL
        self._authed   = False

        # API key takes priority — no login request needed at all
        self._api_key  = os.getenv("KALSHI_API_KEY")
        self._email    = os.getenv("KALSHI_EMAIL")
        self._password = os.getenv("KALSHI_PASSWORD")

    # ── AUTH ──────────────────────────────────────────────────────

    def login(self):
        """
        Authenticate.  Uses API key if present (just sets the header),
        otherwise falls back to email/password login endpoint.
        """
        if self._api_key:
            # API key auth — set header directly, no network request needed
            self.session.headers["Authorization"] = self._api_key
            self._authed = True
            print(f"  [Kalshi] Authenticated via API key  (key: ...{self._api_key[-6:]})")
            return

        # Legacy email/password fallback
        if not self._email or not self._password:
            raise ValueError(
                "No KALSHI_API_KEY found in .env.\n"
                "Add: KALSHI_API_KEY=your_key_here\n"
                "Get your key at: kalshi.com → Settings → API")

        for url in [BASE_URL,
                    "https://api.elections.kalshi.com/trade-api/v2"]:
            try:
                r = requests.post(f"{url}/login",
                                  json={"email": self._email,
                                        "password": self._password},
                                  timeout=10)
                if r.status_code == 200:
                    data  = r.json()
                    token = data.get("token") or data.get("member_id")
                    if token:
                        self._base_url = url
                        self.session.headers["Authorization"] = f"Bearer {token}"
                        self._authed = True
                        print(f"  [Kalshi] Logged in as {self._email}")
                        return
            except Exception:
                continue

        raise ConnectionError(
            "Could not authenticate with Kalshi.\n"
            "Check KALSHI_API_KEY (or KALSHI_EMAIL + KALSHI_PASSWORD) in .env")

    def ensure_auth(self):
        if not self._authed:
            self.login()

    # ── HTTP ──────────────────────────────────────────────────────

    def _get(self, path, params=None):
        self.ensure_auth()
        gap = time.time() - self._last_req
        if gap < 0.3:
            time.sleep(0.3 - gap)
        for attempt in range(3):
            try:
                r = self.session.get(f"{self._base_url}{path}",
                                     params=params, timeout=10)
                self._last_req = time.time()
                if r.status_code == 429:
                    w = int(r.headers.get("Retry-After", 5))
                    print(f"  [API] Rate-limited, waiting {w}s ...")
                    time.sleep(w)
                    continue
                r.raise_for_status()
                return r.json()
            except requests.exceptions.Timeout:
                if attempt == 2: raise
                time.sleep(2)
            except requests.exceptions.ConnectionError:
                if attempt == 2: raise
                time.sleep(3)
        return {}

    # ?? MARKETS ??????????????????????????????????????????????

    def get_markets(self, status="open", limit=200, category=None,
                    cursor=None, **kwargs):
        """
        Returns list of market dicts. Key fields:
          ticker      str   'NBA-GSW-BOS-20260518-Y'
          title       str   human-readable title
          category    str   'Sports' | 'Economics' | 'Crypto' | ...
          yes_ask     int   cents to buy YES  (0-100)
          no_ask      int   cents to buy NO
          yes_bid     int   best YES bid
          no_bid      int   best NO bid
          volume      int   all-time volume
          volume_24h  int   24-hour volume
          close_time  str   ISO expiry datetime
          result      str   '' | 'yes' | 'no'
        """
        p = {"limit": limit, "status": status}
        if category: p["category"] = category
        if cursor:   p["cursor"]   = cursor
        p.update(kwargs)
        return self._get("/markets", p).get("markets", [])

    def get_all_open_markets(self, category=None):
        """Paginate through all open markets (up to 1 000)."""
        out, cursor = [], None
        for _ in range(5):
            p = {"limit": 200, "status": "open"}
            if category: p["category"] = category
            if cursor:   p["cursor"]   = cursor
            data  = self._get("/markets", p)
            batch = data.get("markets", [])
            out.extend(batch)
            cursor = data.get("cursor")
            if not cursor or len(batch) < 200:
                break
            time.sleep(0.3)
        return out

    def get_market(self, ticker):
        return self._get(f"/markets/{ticker}").get("market", {})

    def get_market_result(self, ticker):
        r = self.get_market(ticker).get("result", "")
        return r if r in ("yes", "no") else None

    def get_recent_trades(self, ticker, limit=40):
        return self._get(f"/markets/{ticker}/trades",
                         {"limit": limit}).get("trades", [])

    def get_price_change(self, ticker, n=20):
        """Returns (current_yes_ask_cents, pct_change_recent)."""
        try:
            m      = self.get_market(ticker)
            trades = self.get_recent_trades(ticker, limit=n)
            prices = [t["yes_price"] for t in trades if t.get("yes_price")]
            if len(prices) < 2:
                return m.get("yes_ask"), 0.0
            return m.get("yes_ask"), (prices[0]-prices[-1]) / max(prices[-1], 1)
        except Exception:
            return None, 0.0

    # ?? CATEGORY HELPERS ??????