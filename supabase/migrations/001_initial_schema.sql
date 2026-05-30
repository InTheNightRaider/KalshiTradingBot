-- ============================================================
-- Kalshi BTC Trading Bot — Supabase Schema
-- Paste this entire file into: Supabase → SQL Editor → Run
-- Target: ~2.0–2.5 MB/day  (safe on 500 MB free tier ≈ 200+ days)
-- ============================================================

-- ── 1. market_scans ───────────────────────────────────────────────
-- One row per 60-second scanner tick.
-- btc stored as integer dollars; RSI stored ×10 as SMALLINT.
CREATE TABLE IF NOT EXISTS market_scans (
  id     BIGSERIAL PRIMARY KEY,
  ts     TIMESTAMPTZ NOT NULL,
  btc    INT         NOT NULL,          -- BTC price, whole dollars
  r1     SMALLINT,                      -- RSI 1m × 10  (432 = 43.2)
  r5     SMALLINT,                      -- RSI 5m × 10
  n_mkts SMALLINT                       -- total open markets visible
);
CREATE INDEX IF NOT EXISTS market_scans_ts_idx ON market_scans (ts DESC);

-- ── 2. contract_ticks ─────────────────────────────────────────────
-- Top 20 contracts per scan (ranked by volume × proximity).
-- Odds stored ×10000 as SMALLINT; times ×100 as SMALLINT.
CREATE TABLE IF NOT EXISTS contract_ticks (
  sid    BIGINT   NOT NULL REFERENCES market_scans(id) ON DELETE CASCADE,
  ticker TEXT     NOT NULL,
  strike INT      NOT NULL,             -- strike in whole dollars
  dist   SMALLINT,                      -- BTC − strike (signed, dollars)
  ym     SMALLINT,                      -- yes_mid × 10000
  nm     SMALLINT,                      -- no_mid  × 10000
  vol    INT,                           -- volume
  ml     SMALLINT,                      -- minutes_left × 100
  mi     SMALLINT,                      -- minutes_in   × 100
  PRIMARY KEY (sid, ticker)
);

-- ── 3. contract_captures ──────────────────────────────────────────
-- ONE row per (ticker, phase) — captured at first occurrence in each
-- window.  Primary key prevents duplicates automatically.
-- phase values: 'open' (0-3 min) | 'entry' (5-8 min) | 'resolution'
CREATE TABLE IF NOT EXISTS contract_captures (
  ticker    TEXT        NOT NULL,
  phase     TEXT        NOT NULL,
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  btc       INT,
  dist      SMALLINT,
  yes_odds  SMALLINT,                   -- × 1000
  no_odds   SMALLINT,                   -- × 1000
  r1        SMALLINT,                   -- × 10
  r5        SMALLINT,                   -- × 10
  vol       INT,
  mi        NUMERIC(5,2),               -- minutes into window
  m1_enter  BOOLEAN,
  m1_side   CHAR(3),
  m1_conf   SMALLINT,
  m2_enter  BOOLEAN,
  m2_side   CHAR(3),
  won       BOOLEAN,
  pnl       NUMERIC(7,4),
  PRIMARY KEY (ticker, phase)
);
CREATE INDEX IF NOT EXISTS contract_captures_ts_idx ON contract_captures (ts DESC);

-- ── 4. positions ──────────────────────────────────────────────────
-- Full lifecycle of every bot entry.
-- Inserted on entry; patched (won, pnl, resolved_ts, price_ticks) on resolution.
CREATE TABLE IF NOT EXISTS positions (
  id          BIGSERIAL   PRIMARY KEY,
  ticker      TEXT        NOT NULL,
  mode        SMALLINT    NOT NULL,     -- 1 / 2 / 3 / 4
  tier        SMALLINT,                 -- mode 4 tier (1 or 2)
  side        CHAR(3)     NOT NULL,     -- 'YES' or 'NO'
  cost        NUMERIC(7,2),
  px          NUMERIC(5,4),             -- entry contract price
  payout      NUMERIC(7,2),
  btc         INT,
  strike      INT,
  dist        SMALLINT,
  r1          SMALLINT,
  r5          SMALLINT,
  confidence  SMALLINT,
  close_ts    TIMESTAMPTZ,
  entered_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  won         BOOLEAN,
  pnl         NUMERIC(7,4),
  resolved_ts TIMESTAMPTZ,
  live        BOOLEAN     DEFAULT FALSE,
  price_ticks JSONB                     -- intra-trade tick array
);
CREATE INDEX IF NOT EXISTS positions_mode_won_idx  ON positions (mode, won);
CREATE INDEX IF NOT EXISTS positions_entered_ts_idx ON positions (entered_ts DESC);

-- ── 5. bot_state ──────────────────────────────────────────────────
-- Bankroll + streak snapshot written on every trade entry and resolution.
-- Lets you chart bankroll over time per mode.
CREATE TABLE IF NOT EXISTS bot_state (
  id      BIGSERIAL   PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event   TEXT,                          -- 'entry' | 'resolution'
  mode    SMALLINT,
  m1_bank NUMERIC(8,2),
  m2_bank NUMERIC(8,2),
  m4_bank NUMERIC(8,2),
  m1_ls   SMALLINT,                      -- loss streak
  m2_ls   SMALLINT,
  m3_ls   SMALLINT,
  m4_ls   SMALLINT,
  btc     INT,
  r1      SMALLINT
);
CREATE INDEX IF NOT EXISTS bot_state_ts_idx ON bot_state (ts DESC);

-- ── Row-Level Security ────────────────────────────────────────────
-- Service-role key bypasses RLS automatically (bot writes).
-- Enable RLS + read-only anon policy so the dashboard can query safely.
ALTER TABLE market_scans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_ticks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_captures  ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_state          ENABLE ROW LEVEL SECURITY;

-- Allow anon (dashboard) to read all rows
CREATE POLICY "anon read market_scans"      ON market_scans      FOR SELECT USING (true);
CREATE POLICY "anon read contract_ticks"    ON contract_ticks    FOR SELECT USING (true);
CREATE POLICY "anon read contract_captures" ON contract_captures FOR SELECT USING (true);
CREATE POLICY "anon read positions"         ON positions         FOR SELECT USING (true);
CREATE POLICY "anon read bot_state"         ON bot_state         FOR SELECT USING (true);
