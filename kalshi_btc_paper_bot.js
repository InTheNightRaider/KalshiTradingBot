/**
 * kalshi_btc_paper_bot.js — Mode 4a LIVE BTC Bot (single strategy)
 *
 * LIVE by default. Places real orders on Kalshi for Mode 4a only.
 * (Filename kept for workflow/dashboard compatibility — this is the
 * live bot, not paper. The full multi-mode research bot lives in
 * kalshi_multimode_archive.js and is NOT run.)
 *
 * STRATEGY — Mode 4a: 7-TF confluence value entries
 *   Markets : KXBTCD (hourly) + KXBTC15M (15-min up/down)
 *   Mid     : 55-80¢ — value entries, best backtested risk/reward
 *   Window  : 1-30 min left (price filter is the real gate)
 *   Signal  : 2+ of 7 timeframes agree on direction
 *   Bet     : $5 flat; after a loss, skip 2 signals then bet 3x
 *   Bankroll: starts $70
 *
 * SAFETY
 *   Kill switch: exits if today's live PnL <= -MAX_DAILY_LOSS.
 *   Set MODE=paper (or --paper) to simulate without placing orders.
 *
 * Usage:
 *   node kalshi_btc_paper_bot.js YOUR-API-KEY-ID          # LIVE
 *   node kalshi_btc_paper_bot.js YOUR-API-KEY-ID --paper  # simulate
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sb     = require('./supabase_client');
const gh     = require('./github_state');

// ── Module-level scan context (set at start of each scan tick) ────
let _scanBtc   = null;
let _scanR1    = null;
let _scanR5    = null;
let _scanState = null;

// ── Mode 4a config ────────────────────────────────────────────────
const MODE4A_START      = 70.00;
const MODE4A_BET        = 5.00;  // $5 flat production bet
const MODE4A_MID_LO     = 0.55;
const MODE4A_MID_HI     = 0.80;
const MODE4A_MIN_IN     = 0;
const MODE4A_MAX_IN     = 60;
const MODE4A_MIN_LEFT   = 1;
const MODE4A_MAX_LEFT   = 30;
const MODE4A_CONFLUENCE = 3;  // require 3+ of 7 timeframes to agree

// ── Recovery after loss ───────────────────────────────────────────
// Time-based cooldown: sit out 30 min after each loss.
const LOSS_COOLDOWN_MS = 30 * 60 * 1000;
// Recovery multiplier: 2x next bet for the first MAX_RECOVERY_ATTEMPTS
// losses in a streak, then reset to NORMAL (no chasing deeper holes).
const RECOVERY_MULTI         = 2;
const MAX_RECOVERY_ATTEMPTS  = 2;

// ── Bet-size tiers by bankroll ────────────────────────────────────
// Flat $5 until we prove sustained profit; step up gently after.
function getBaseBet(bankroll) {
  if (bankroll < 200) return 5;
  if (bankroll < 350) return 8;
  if (bankroll < 500) return 11;
  if (bankroll < 650) return 14;
  if (bankroll < 800) return 17;
  return 20;
}

// State machine: streak 0 → tier, streak 1..MAX → 2x tier, streak >MAX → tier.
function getCurrentBet(modeState) {
  const base   = getBaseBet(modeState.bankroll);
  const streak = modeState.lossStreak || 0;
  if (streak >= 1 && streak <= MAX_RECOVERY_ATTEMPTS) {
    return { cost: base * RECOVERY_MULTI, base, multi: RECOVERY_MULTI, recovery: true, attempt: streak };
  }
  return { cost: base, base, multi: 1, recovery: false, attempt: 0 };
}

// ── Salvage stop loss (no take-profit, no trailing stop) ──────────
// In the last SL_MIN_LEFT min, if our side mid is clearly losing AND
// there's a non-trivial bid, exit at bid to recoup some money instead
// of going to $0. Take profit / trailing stop were not shipped: data
// showed they overlapped with the 5m RSI slope filter and cut winners.
const SL_MIN_LEFT   = 3;
const SL_THRESHOLD  = 0.40;
const SL_FLOOR_BID  = 0.05;

// ── Hard Take Profit ──────────────────────────────────────────────
// Exit any open position the moment our side's mid is up TP_AMOUNT
// from entry. Sells at current bid (so actual profit ≈ TP - spread/2,
// roughly 12-14¢/contract after a 2-3¢ spread).
// Backtest on 27 live trades: +$27.53 over actual at 15¢ TP (22/27
// trades fire). The biggest single edge we have in the data.
const TP_AMOUNT = 0.15;

// ── 5m RSI slope filter (Version A) ───────────────────────────────
// At entry, look at the 5m RSI movement over the last 3 min. If it's
// moving against our trade direction (rising for NO, falling for YES),
// skip the entry. Backtest: caught 3 losses, no wins lost, +$6.15 over
// 13-trade sample. Tolerates small wobble (±SLOPE_TOLERANCE).
const SLOPE_LOOKBACK_MIN = 3;
const SLOPE_TOLERANCE    = 1;  // RSI points

function rsi5mSlope(state) {
  const log = state.confluenceLog || [];
  if (log.length < 3) return 0;
  const now = Date.now();
  const cutoff = now - SLOPE_LOOKBACK_MIN * 60 * 1000;
  const window = log.filter(e => {
    const t = new Date(e.ts).getTime();
    return t >= cutoff && e.r5 != null;
  });
  if (window.length < 3) return 0;
  return window[window.length - 1].r5 - window[0].r5;
}

// ── Kill switch — daily loss cap (live only) ──────────────────────
const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || '25');

const SCAN_INTERVAL = 30 * 1000;
const STATE_FILE    = path.join(__dirname, 'dashboard', 'btc_paper_state.json');

// ── Parse args ────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const keyId    = args.find(a => !a.startsWith('--')) || process.env.KALSHI_API_KEY;
const intArg   = args.indexOf('--interval');
const INTERVAL = intArg >= 0 ? parseInt(args[intArg + 1], 10) * 1000 : SCAN_INTERVAL;
// LIVE by default. Only paper if explicitly requested.
const LIVE_MODE = !(args.includes('--paper') || process.env.MODE === 'paper');

if (!keyId) {
  console.error('Usage: node kalshi_btc_paper_bot.js YOUR-API-KEY-ID [--paper] [--interval 30]');
  process.exit(1);
}

const BASE     = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH = '/trade-api/v2';
const pem      = fs.readFileSync(path.join(__dirname, 'kalshi_private_key.pem'), 'utf8');

// ── Helpers ───────────────────────────────────────────────────────
const ts    = () => new Date().toLocaleTimeString('en-US', { hour12: false });
const fmt$  = v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);

// ── Kalshi signing ────────────────────────────────────────────────
function signHeaders(method, urlPath) {
  const timestamp = Date.now().toString();
  const msg  = timestamp + method.toUpperCase() + API_PATH + urlPath;
  const sign = crypto.createSign('SHA256');
  sign.update(msg);
  const sig = sign.sign({
    key: pem,
    padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN,
  }, 'base64');
  return {
    'KALSHI-ACCESS-KEY':       keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };
}

function kalshiGet(urlPath) {
  const headers = signHeaders('GET', urlPath);
  return new Promise((resolve, reject) => {
    const req = https.get(BASE + urlPath, { headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function kalshiPost(urlPath, body) {
  const headers  = signHeaders('POST', urlPath);
  const bodyStr  = JSON.stringify(body);
  const url      = new URL(BASE + urlPath);
  const options  = {
    hostname: url.hostname,
    path:     url.pathname,
    method:   'POST',
    headers:  { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Binance API (data-api.binance.vision — no geo-restriction) ────
function binanceGet(urlPath) {
  return new Promise(resolve => {
    const req = https.get('https://data-api.binance.vision' + urlPath, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchKlines(interval, limit = 100) {
  const data = await binanceGet(`/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
  if (!Array.isArray(data)) return [];
  return data.map(k => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

async function fetchBtcPrice() {
  const data = await binanceGet('/api/v3/ticker/price?symbol=BTCUSDT');
  return data ? parseFloat(data.price) : null;
}

// ── Real Kalshi cash balance — the only source of truth for bet sizing.
// Returns dollars (Kalshi returns cents). null on any failure so callers
// can fall back to the internal tracker without blocking trading.
async function fetchKalshiBalance() {
  try {
    const r = await kalshiGet('/portfolio/balance');
    const cents = (r && typeof r.balance === 'number') ? r.balance : null;
    return cents == null ? null : cents / 100;
  } catch { return null; }
}

// ── Kalshi-settled trade records — source of truth for actual cost+pnl.
// /portfolio/settlements returns every closed position with real cost,
// revenue, and side counts. Use this instead of inferring outcomes from
// market.result + intended cost, which drifts (limit-vs-fill price,
// partial fills, etc.).
async function fetchKalshiSettlements(limit = 100) {
  try {
    const r = await kalshiGet(`/portfolio/settlements?limit=${limit}`);
    return Array.isArray(r?.settlements) ? r.settlements : [];
  } catch { return []; }
}

// Extract outcome for our specific side from a settlement record.
// Settlement shape: { ticker, market_result, yes_count, no_count,
//                     yes_total_cost (cents), no_total_cost (cents),
//                     revenue (cents), settled_time }
// Returns { won, actualCost, revenue, pnl, count } or null if our side
// has no contracts in this settlement.
function settlementOutcome(settlement, side) {
  const isYes  = side.toUpperCase() === 'YES';
  const count  = isYes ? (settlement.yes_count || 0) : (settlement.no_count || 0);
  if (count === 0) return null;
  const cents  = isYes ? (settlement.yes_total_cost || 0) : (settlement.no_total_cost || 0);
  const rev    = settlement.revenue || 0;
  // Kalshi's market_result is 'yes' / 'no' (or rarely 'void').
  const result = (settlement.market_result || '').toLowerCase();
  const won    = result === side.toLowerCase();
  return {
    won,
    actualCost: cents / 100,
    revenue:    rev   / 100,
    pnl:        (rev - cents) / 100,
    count,
  };
}

// ── RSI (Wilder's smoothed) ───────────────────────────────────────
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// ── After loss/win ────────────────────────────────────────────────
function updateStreak(modeState, won, modeKey) {
  if (won) {
    modeState.lossStreak      = 0;
    modeState.cooldownUntilMs = 0;
  } else {
    const streak = (modeState.lossStreak || 0) + 1;
    modeState.lossStreak      = streak;
    modeState.cooldownUntilMs = Date.now() + LOSS_COOLDOWN_MS;
    const mins = (LOSS_COOLDOWN_MS / 60000).toFixed(0);
    if (streak > MAX_RECOVERY_ATTEMPTS) {
      console.log(`  [${modeKey.toUpperCase()}] Loss streak ${streak} — recovery cap hit, cooling down ${mins}min then NORMAL bet`);
    } else {
      const nextBet = getBaseBet(modeState.bankroll) * RECOVERY_MULTI;
      console.log(`  [${modeKey.toUpperCase()}] Loss streak ${streak} — cooling down ${mins}min, next bet ${RECOVERY_MULTI}x = $${nextBet} (recovery ${streak}/${MAX_RECOVERY_ATTEMPTS})`);
    }
  }
}

// ── Contract timing (treat last 15 min as the active window) ──────
function windowTiming(closeTime) {
  const now   = Date.now();
  const close = new Date(closeTime).getTime();
  const left  = (close - now) / 60000;
  const into  = Math.max(0, 15 - left);
  return { minutesIn: into, minutesLeft: Math.max(0, left) };
}

// ── Mid-price helper ──────────────────────────────────────────────
function midPrice(bid, ask) {
  const b = parseFloat(bid || 0), a = parseFloat(ask || 0);
  if (!b && !a) return 0;
  if (!b) return a;
  if (!a) return b;
  return (b + a) / 2;
}

// ── Per-timeframe trend signal: 'UP', 'DOWN', or null ─────────────
function tfTrend(candles) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const closes = candles.map(c => c.close);
  const r      = rsi(closes);
  const n      = closes.length;
  const slopeUp = closes[n-1] > closes[n-2] && closes[n-2] > closes[n-3];
  const slopeDn = closes[n-1] < closes[n-2] && closes[n-2] < closes[n-3];
  const bull = (r && r > 55 ? 1 : 0) + (slopeUp ? 1 : 0);
  const bear = (r && r < 45 ? 1 : 0) + (slopeDn ? 1 : 0);
  if (bull >= 2 || (bull === 1 && bear === 0)) return 'UP';
  if (bear >= 2 || (bear === 1 && bull === 0)) return 'DOWN';
  return null;
}

// ── 7-TF confluence scorer ────────────────────────────────────────
function calcConfluence(candlesByTf, minScore) {
  const threshold = minScore || 2;
  const TFS     = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
  const signals = TFS.map(tf => tfTrend(candlesByTf[tf]));
  const up      = signals.filter(s => s === 'UP').length;
  const dn      = signals.filter(s => s === 'DOWN').length;
  const breakdown = {};
  TFS.forEach((tf, i) => { breakdown[tf] = signals[i]; });
  if (up > dn && up >= threshold) return { dir: 'UP',   score: up, breakdown };
  if (dn > up && dn >= threshold) return { dir: 'DOWN', score: dn, breakdown };
  return { dir: null, score: Math.max(up, dn), breakdown };
}

// ── Mode 4a evaluator ─────────────────────────────────────────────
function evalMode4a(mkt, candlesByTf, minutesIn, minutesLeft, minConfluenceOverride) {
  if (minutesIn < MODE4A_MIN_IN || minutesIn > MODE4A_MAX_IN ||
      minutesLeft < MODE4A_MIN_LEFT || minutesLeft > MODE4A_MAX_LEFT) {
    return { enter: false, reason: `Outside window (left ${minutesLeft.toFixed(1)})` };
  }

  const yesMid = midPrice(mkt.yes_bid, mkt.yes_ask);
  const noMid  = midPrice(mkt.no_bid,  mkt.no_ask);
  const yesOk  = yesMid >= MODE4A_MID_LO && yesMid <= MODE4A_MID_HI;
  const noOk   = noMid  >= MODE4A_MID_LO && noMid  <= MODE4A_MID_HI;

  if (!yesOk && !noOk) {
    const best = (Math.max(yesMid, noMid) * 100).toFixed(0);
    return { enter: false, reason: `Mid out of range (best ${best}¢ — need ${MODE4A_MID_LO*100}-${MODE4A_MID_HI*100}¢)` };
  }

  const minConf = minConfluenceOverride || MODE4A_CONFLUENCE;
  const { dir, score, breakdown } = calcConfluence(candlesByTf, minConf);
  if (!dir) {
    return { enter: false, reason: `Weak confluence (${score}/7 — need ${minConf}+)` };
  }

  // ── 30m + 1h must both agree — they're the real 15-min predictors ──
  // Short TFs (1m/3m/5m) counter-moving is fine and often a better entry;
  // but if the half-hour and hourly disagree we have no clear direction.
  const m30 = breakdown['30m'];
  const h1  = breakdown['1h'];
  if (m30 !== dir || h1 !== dir) {
    return { enter: false, reason: `30m(${m30||'—'})/1h(${h1||'—'}) not both ${dir} — skipping` };
  }

  // ── 1h RSI extreme → mean-reversion veto ──────────────────────────
  // If 1h is overbought (RSI>70) price will likely fall: no UP entries.
  // If 1h is oversold  (RSI<30) price will likely rise: no DOWN entries.
  const candles1h = candlesByTf['1h'];
  let r1h = null;
  if (candles1h && candles1h.length >= 15) {
    r1h = rsi(candles1h.map(c => c.close));
    if (r1h !== null) {
      if (r1h > 70 && dir === 'UP') {
        return { enter: false, reason: `1h RSI ${r1h.toFixed(0)} overbought — mean-reversion expects DOWN, no YES entry` };
      }
      if (r1h < 30 && dir === 'DOWN') {
        return { enter: false, reason: `1h RSI ${r1h.toFixed(0)} oversold — mean-reversion expects UP, no NO entry` };
      }
    }
  }

  let side, contractPx;
  if      (dir === 'UP'   && yesOk) { side = 'YES'; contractPx = yesMid; }
  else if (dir === 'DOWN' && noOk)  { side = 'NO';  contractPx = noMid;  }
  else {
    const wanted = dir === 'UP' ? 'YES' : 'NO';
    return { enter: false, reason: `${dir} trend but ${wanted} mid not in range` };
  }

  const tfStr = Object.entries(breakdown)
    .map(([tf, v]) => `${tf}:${v ? v[0] : '—'}`).join(' ');
  return {
    enter: true, side, contractPx,
    confluenceScore: score, confluenceDir: dir,
    // Diagnostics logged on every entry so the new gates can be backtested:
    tfBreakdown: breakdown,            // full 7-TF direction map
    dir30m: m30, dir1h: h1,            // the two predictor TFs
    rsi1h: r1h !== null ? +r1h.toFixed(1) : null,
    reason: `${score}/7 ${dir}  ${side}@${(contractPx*100).toFixed(0)}¢  ${minutesLeft.toFixed(1)}m left  [${tfStr}]`,
  };
}

// ── State I/O ─────────────────────────────────────────────────────
// Only mode4a is active. Any other keys in the existing state file
// (mode1..mode4b, liveMarket) are preserved untouched for history.
function ensureStateShape(state) {
  state = state || {};
  state.mode4a = {
    bankroll: MODE4A_START, trades: [], open: [],
    lossStreak: 0, skipSignals: 0, recoveryMulti: 1,
    ...(state.mode4a || {}),
  };
  if (!Array.isArray(state.mode4a.trades)) state.mode4a.trades = [];
  if (!Array.isArray(state.mode4a.open))   state.mode4a.open   = [];
  if (state.liveMarket === undefined) state.liveMarket = null;
  if (state.lastUpdate === undefined) state.lastUpdate = null;
  return state;
}

function loadState() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { raw = null; }
  return ensureStateShape(raw);
}

function saveState(state, pushLabel) {
  state.lastUpdate = new Date().toISOString();
  if (state.mode4a.trades.length > 500) {
    state.mode4a.trades = state.mode4a.trades.slice(-500);
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  if (gh.ENABLED && pushLabel) gh.pushState(pushLabel).catch(() => {});
}

// ── Resolve expired positions ─────────────────────────────────────
// Source of truth (in order):
//   1) Kalshi /portfolio/settlements — actual cost, revenue, pnl as
//      booked on the account. Matches your Kalshi UI exactly.
//   2) Market result + intended cost — fallback when settlement isn't
//      published yet (some markets take a minute or two to settle).

// ── Exit an open position early (salvage SL only) ─────────────────
// Places a SELL limit at the current bid. Limit-sell at bid fills
// against the resting bid order. Removes position from open[] and
// records a trade with resolutionSource='manual_exit'.
async function exitPosition(modeState, modeKey, pos, exitMid, exitBid, reason) {
  const count = pos.contractCount || Math.max(1, Math.floor(pos.cost / pos.contractPx));
  const priceInCents = Math.max(1, Math.floor(exitBid * 100));

  if (!LIVE_MODE) {
    const proceeds = count * exitBid;
    const pnl = parseFloat((proceeds - pos.cost).toFixed(2));
    modeState.bankroll = parseFloat((modeState.bankroll + proceeds).toFixed(4));
    updateStreak(modeState, pnl > 0, modeKey);
    modeState.trades.push({
      ...pos, resolved: true, won: pnl > 0, pnl,
      resolutionSource: 'manual_exit', exitReason: reason,
      exitMid, exitBid, resolved_at: new Date().toISOString(),
    });
    console.log(`  🛟 [EXIT-PAPER] ${pos.ticker} ${pos.side} ${count}x @ ${priceInCents}¢ (${reason})  pnl ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);
    return true;
  }

  const side = pos.side.toLowerCase();
  const orderBody = {
    ticker: pos.ticker,
    client_order_id: crypto.randomUUID(),
    side, count,
    action: 'sell',
    type:   'limit',
    [`${side}_price`]: priceInCents,
  };

  try {
    const resp = await kalshiPost('/portfolio/orders', orderBody);
    if (resp.status !== 200 && resp.status !== 201) {
      console.log(`  ⚠️ [EXIT FAILED] ${pos.ticker} HTTP ${resp.status}: ${JSON.stringify(resp.body).slice(0,160)}`);
      return false;
    }
    const proceeds = count * (priceInCents / 100);
    const pnl      = parseFloat((proceeds - pos.cost).toFixed(2));
    const won      = pnl > 0;
    modeState.bankroll = parseFloat((modeState.bankroll + proceeds).toFixed(4));
    updateStreak(modeState, won, modeKey);
    modeState.trades.push({
      ...pos, resolved: true, won, pnl,
      resolutionSource: 'manual_exit', exitReason: reason,
      exitMid, exitBid, resolved_at: new Date().toISOString(),
    });
    const icon = won ? '💰' : '🛟';
    console.log(`  ${icon} [EXIT ${reason}] ${pos.ticker} ${pos.side} ${count}x → sold @ ${priceInCents}¢  proceeds $${proceeds.toFixed(2)}  est pnl ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);
    return true;
  } catch (e) {
    console.log(`  ⚠️ [EXIT EXCEPTION] ${pos.ticker}: ${e.message}`);
    return false;
  }
}

async function resolveExpired(modeState, modeKey, markets) {
  const now = Date.now();
  const pending = [];

  // Pull the latest settlements once per scan (cheap; one API call).
  const haveExpired = modeState.open.some(p => now >= new Date(p.close_time).getTime() + 90_000);
  const settlements = haveExpired ? await fetchKalshiSettlements(100) : [];

  for (const pos of modeState.open) {
    const closeMs = new Date(pos.close_time).getTime();
    if (now < closeMs + 90_000) { pending.push(pos); continue; }

    let won, actualCost, pnl, source;

    // ── Path 1: Kalshi settlement record (preferred) ──
    const settlement = settlements.find(s => s.ticker === pos.ticker);
    const outcome    = settlement ? settlementOutcome(settlement, pos.side) : null;
    if (outcome) {
      won        = outcome.won;
      actualCost = outcome.actualCost;
      pnl        = parseFloat(outcome.pnl.toFixed(2));
      source     = 'settlement';
    } else {
      // ── Path 2: market.result + intended cost (fallback) ──
      const mkt = markets.find(m => m.ticker === pos.ticker);
      let result = mkt?.result;
      if (!result) {
        const resp = await kalshiGet('/markets/' + pos.ticker).catch(() => null);
        result = resp?.market?.result;
      }
      if (!result) { pending.push(pos); continue; }
      won        = result.toLowerCase() === pos.side.toLowerCase();
      actualCost = pos.cost;
      pnl        = won
        ? parseFloat((pos.cost / pos.contractPx - pos.cost).toFixed(2))
        : -pos.cost;
      source     = 'fallback';
    }

    // Local bankroll is overwritten by the next-scan Kalshi sync in LIVE
    // mode, so this mutation only matters for PAPER. Keep it for parity.
    modeState.bankroll = parseFloat(Math.max(0, modeState.bankroll + pnl).toFixed(4));

    updateStreak(modeState, won, modeKey);
    modeState.trades.push({
      ...pos,
      cost:           actualCost,         // overwrite intended with actual
      intendedCost:   pos.cost,           // keep original for diff visibility
      resolutionSource: source,
      resolved: true, won, pnl,
      resolved_at: new Date().toISOString(),
    });

    sb.resolvePosition(pos.sb_id, won, pnl, pos.priceTicks)
      .catch(e => console.log('  !! sb.resolvePosition: ' + e.message));
    if (_scanState) {
      sb.insertBotState(_scanState, 'resolution', modeKey, _scanBtc, _scanR1)
        .catch(e => console.log('  !! sb.insertBotState: ' + e.message));
    }

    const icon  = won ? '✅' : '❌';
    const note  = source === 'settlement'
      ? `actual cost $${actualCost.toFixed(2)} (intended $${pos.cost.toFixed(2)})`
      : 'fallback resolution';
    console.log(`  ${icon} [${modeKey.toUpperCase()}] ${pos.ticker} ${pos.side} → ${won?'WIN':'LOSS'} ${fmt$(pnl)}  ${note}  streak: ${modeState.lossStreak}L`);

    if (_scanState) saveState(_scanState, 'resolution');
  }

  modeState.open = pending;
}

// ── Enter a position (live unless --paper) ────────────────────────
async function enterPosition(modeState, modeKey, entry) {
  if (modeState.open.some(p => p.ticker === entry.ticker)) return false;
  if (entry.cost <= 0) return false;
  if (modeState.bankroll < entry.cost) return false;

  const isLive = LIVE_MODE;

  if (isLive) {
    const priceInCents = Math.round(entry.contractPx * 100);
    const count        = Math.max(1, Math.floor(entry.cost / entry.contractPx));
    const side         = entry.side.toLowerCase();
    const orderBody    = {
      ticker: entry.ticker,
      client_order_id: crypto.randomUUID(),  // required by Kalshi
      side,
      count,
      action: 'buy',
      type:   'limit',
      [`${side}_price`]: priceInCents,
    };

    try {
      const resp = await kalshiPost('/portfolio/orders', orderBody);
      if (resp.status !== 200 && resp.status !== 201) {
        console.log(`  ❌ [LIVE] Order FAILED (HTTP ${resp.status}): ${JSON.stringify(resp.body).slice(0, 300)}`);
        return false;
      }
      const orderId = resp.body?.order?.order_id || resp.body?.order_id || 'N/A';
      console.log(`  🟢 [LIVE] Order placed — ${entry.ticker} ${entry.side} ${count} contracts @ ${priceInCents}¢  order_id: ${orderId}`);
    } catch (e) {
      console.log(`  ❌ [LIVE] Order exception: ${e.message}`);
      return false;
    }
  }

  const posEntry = { ...entry, entered_at: new Date().toISOString(), live: isLive };
  modeState.open.push(posEntry);
  modeState.bankroll = parseFloat((modeState.bankroll - entry.cost).toFixed(4));

  sb.insertPosition(posEntry, modeKey, _scanR1, _scanR5)
    .then(id => { if (id) posEntry.sb_id = id; })
    .catch(e => console.log('  !! sb.insertPosition: ' + e.message));
  if (_scanState) {
    sb.insertBotState(_scanState, 'entry', modeKey, _scanBtc, _scanR1)
      .catch(e => console.log('  !! sb.insertBotState: ' + e.message));
  }

  if (_scanState) saveState(_scanState, 'entry');
  return true;
}

// ── Summary stats ─────────────────────────────────────────────────
function modeStats(ms) {
  const tot  = ms.trades.length;
  const wins = ms.trades.filter(t => t.won).length;
  const pnl  = ms.trades.reduce((s, t) => s + (t.pnl || 0), 0);
  return { tot, wins, losses: tot - wins, wr: tot > 0 ? wins / tot * 100 : 0, pnl };
}

function todayLivePnl(state) {
  const today = new Date().toISOString().slice(0, 10);
  let pnl = 0;
  for (const t of (state.mode4a.trades || [])) {
    if (t.live && t.resolved_at && t.resolved_at.startsWith(today)) pnl += (t.pnl || 0);
  }
  return pnl;
}

// ── Main scan ─────────────────────────────────────────────────────
async function scan() {
  const state = loadState();

  // Kill switch — bail if today's live PnL is below the floor.
  if (LIVE_MODE && MAX_DAILY_LOSS > 0) {
    const live = todayLivePnl(state);
    if (live <= -MAX_DAILY_LOSS) {
      console.log(`\n  🛑 [KILL SWITCH] Today's LIVE PnL ${live.toFixed(2)} <= -${MAX_DAILY_LOSS}. Stopping bot.`);
      process.exit(0);
    }
  }

  const modeLabel = LIVE_MODE ? '🟢 LIVE' : '📄 PAPER';
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  Mode 4a Bot [${modeLabel}]  |  ${ts()}  |  bank $${state.mode4a.bankroll.toFixed(2)}`);
  console.log(`${'═'.repeat(78)}`);

  // ── Binance data (all 7 TFs for confluence) ──────────────────
  const [btcPrice, candles1m, candles5m, candles3m, candles15m, candles30m, candles1h, candles4h] = await Promise.all([
    fetchBtcPrice(),
    fetchKlines('1m',  60),
    fetchKlines('5m',  35),
    fetchKlines('3m',  30),
    fetchKlines('15m', 25),
    fetchKlines('30m', 25),
    fetchKlines('1h',  25),
    fetchKlines('4h',  20),
  ]);

  if (!btcPrice || !candles1m.length) {
    console.log('  !! Could not fetch Binance data — skipping');
    return;
  }

  const rsi1m = rsi(candles1m.map(c => c.close));
  const rsi5m = rsi(candles5m.map(c => c.close));

  const candlesByTf = {
    '1m': candles1m, '3m': candles3m, '5m': candles5m,
    '15m': candles15m, '30m': candles30m, '1h': candles1h, '4h': candles4h,
  };
  console.log(`  BTC $${Math.round(btcPrice).toLocaleString()}  |  RSI 1m: ${rsi1m ? rsi1m.toFixed(1) : '--'}  RSI 5m: ${rsi5m ? rsi5m.toFixed(1) : '--'}`);

  // ── Confluence recorder ──────────────────────────────────────────
  // Compact per-scan snapshot of all 7 TF directions + key RSIs, so the
  // new gates (30m+1h agreement, 1h-RSI veto) can be backtested later.
  // Capped rolling buffer in the pushed state file (~720 = 6h at 30s).
  {
    const TFS  = ['1m','3m','5m','15m','30m','1h','4h'];
    const dirs = TFS.map(tf => { const d = tfTrend(candlesByTf[tf]); return d ? d[0] : '-'; }).join(''); // e.g. "UUDU-DD"
    const r1h  = candles1h.length >= 15 ? rsi(candles1h.map(c => c.close)) : null;
    const snap = {
      ts:  new Date().toISOString(),
      btc: Math.round(btcPrice),
      tf:  dirs,                                    // 7 chars, one per TF
      r1:  rsi1m  != null ? +rsi1m.toFixed(1)  : null,
      r5:  rsi5m  != null ? +rsi5m.toFixed(1)  : null,
      r1h: r1h    != null ? +r1h.toFixed(1)    : null,
    };
    if (!Array.isArray(state.confluenceLog)) state.confluenceLog = [];
    state.confluenceLog.push(snap);
    if (state.confluenceLog.length > 720) state.confluenceLog = state.confluenceLog.slice(-720);
  }

  _scanBtc   = btcPrice;
  _scanR1    = rsi1m;
  _scanR5    = rsi5m;
  _scanState = state;

  // ── Kalshi markets (hourly + 15-min BTC contracts) ───────────
  // Query /markets with series_ticker so Kalshi filters server-side.
  // A plain /markets?status=open scan paginates BTC out of the first
  // page (Kalshi has thousands of open markets), returning 0 BTC.
  const BTC_SERIES = ['KXBTCD', 'KXBTC15M'];
  const normalize  = m => ({
    ...m,
    yes_bid: m.yes_bid_dollars ?? m.yes_bid ?? 0,
    yes_ask: m.yes_ask_dollars ?? m.yes_ask ?? 0,
    no_bid:  m.no_bid_dollars  ?? m.no_bid  ?? 0,
    no_ask:  m.no_ask_dollars  ?? m.no_ask  ?? 0,
  });
  let allMkts = [];
  try {
    // Primary: server-side series filter (no pagination problem).
    const seriesResults = await Promise.all(
      BTC_SERIES.map(s => kalshiGet(`/markets?series_ticker=${s}&status=open&limit=200`).catch(() => ({})))
    );
    let raw = [];
    seriesResults.forEach((r, i) => {
      const mk = r.markets || [];
      if (mk.length) console.log(`  📡 ${BTC_SERIES[i]}: ${mk.length} market(s)`);
      raw.push(...mk);
    });

    // Fallback: broad scan filtered for any BTC ticker, if series came up empty.
    if (raw.length === 0) {
      const broad = await kalshiGet(`/markets?status=open&limit=1000`).catch(() => ({}));
      raw = (broad.markets || []).filter(m => m.ticker && m.ticker.includes('BTC'));
      if (raw.length) console.log(`  📡 broad scan: ${raw.length} BTC market(s)`);
    }

    allMkts = raw.map(normalize);
    if (allMkts.length === 0) {
      console.log('  !! No BTC markets found (series + broad scan both empty)');
    } else {
      console.log(`  📡 ${allMkts.length} BTC market(s) total — e.g. ${allMkts.slice(0, 3).map(m => m.ticker).join(', ')}`);
    }
  } catch (e) {
    console.log(`  !! Kalshi fetch failed: ${e.message}`);
  }

  // ── Resolve expired Mode 4a positions ────────────────────────
  await resolveExpired(state.mode4a, 'mode4a', allMkts);

  // ── Sync to real Kalshi cash balance (live only) ──────────────
  // The internal mode4a.bankroll tracker drifted from reality (manual
  // adjustments, paper/live mixing, init-time defaults). Bet-sizing
  // must use the actual account; otherwise we either skip valid entries
  // ("bankroll $3.85 < bet $5") or overbet a depleted account.
  // Sync AFTER resolveExpired so Kalshi's post-settlement balance wins
  // and we don't double-count pnl that's already in the real balance.
  if (LIVE_MODE) {
    const realBal = await fetchKalshiBalance();
    if (realBal !== null) {
      const drift = realBal - state.mode4a.bankroll;
      if (Math.abs(drift) >= 0.01) {
        console.log(`  💰 Bankroll synced to real Kalshi: $${realBal.toFixed(2)} (was $${state.mode4a.bankroll.toFixed(2)}, drift ${drift >= 0 ? '+' : ''}$${drift.toFixed(2)})`);
      }
      state.mode4a.bankroll = parseFloat(realBal.toFixed(2));
    } else {
      console.log('  !! Could not fetch Kalshi balance — using internal tracker');
    }
  }

  // ── Dashboard snapshot of nearby markets ─────────────────────
  const nearby = allMkts
    .filter(m => m.floor_strike && Math.abs(btcPrice - m.floor_strike) <= 3000)
    .sort((a, b) => Math.abs(btcPrice - a.floor_strike) - Math.abs(btcPrice - b.floor_strike));

  state.liveMarket = {
    btcPrice, rsi1m, rsi5m,
    timestamp: new Date().toISOString(),
    markets: nearby.slice(0, 6).map(m => {
      const { minutesIn, minutesLeft } = windowTiming(m.close_time);
      return {
        ticker: m.ticker, strike: m.floor_strike,
        distance: (btcPrice - m.floor_strike).toFixed(0),
        absDist:  Math.abs(btcPrice - m.floor_strike).toFixed(0),
        yesMid:   midPrice(m.yes_bid, m.yes_ask).toFixed(2),
        noMid:    midPrice(m.no_bid,  m.no_ask).toFixed(2),
        minutesIn:   minutesIn.toFixed(1),
        minutesLeft: minutesLeft.toFixed(1),
        close_time: m.close_time,
      };
    }),
  };

  // ── Nearby-market log: per-scan snapshot of mid/bid/ask for the 6
  // closest-to-money contracts. Lets us backtest "would we have taken
  // a better trade if the filter let us in?" — answers the gap the
  // priceTicks (entered-only) approach couldn't.
  // Rolling buffer in state file, capped at 360 entries (~3h at 30s).
  {
    if (!Array.isArray(state.nearbyMarketLog)) state.nearbyMarketLog = [];
    state.nearbyMarketLog.push({
      ts:  new Date().toISOString(),
      btc: Math.round(btcPrice),
      markets: nearby.slice(0, 6).map(m => {
        const { minutesLeft } = windowTiming(m.close_time);
        return {
          ticker: m.ticker,
          strike: m.floor_strike,
          yMid:   parseFloat(midPrice(m.yes_bid, m.yes_ask).toFixed(3)),
          nMid:   parseFloat(midPrice(m.no_bid,  m.no_ask).toFixed(3)),
          yBid:   parseFloat((m.yes_bid || 0).toFixed(3)),
          yAsk:   parseFloat((m.yes_ask || 0).toFixed(3)),
          nBid:   parseFloat((m.no_bid  || 0).toFixed(3)),
          nAsk:   parseFloat((m.no_ask  || 0).toFixed(3)),
          mLeft:  parseFloat(minutesLeft.toFixed(2)),
        };
      }),
    });
    if (state.nearbyMarketLog.length > 360) state.nearbyMarketLog = state.nearbyMarketLog.slice(-360);
  }

  // ── Live mark-to-market + tick log for open Mode 4a positions ──
  // Refreshed every 30s. Stores entry vs. now per side, unrealized P&L,
  // and contract count on each pos so the dashboard can show:
  //   entry $0.62 → now $0.74  count=8  value $5.92  unrealized +$0.92
  // Not fee/slippage-adjusted but "accurate enough for a 30s refresh."
  let openValueTotal = 0;
  let openUnrealized = 0;
  {
    const mktMap = {};
    for (const m of allMkts) mktMap[m.ticker] = m;
    const exitedTickers = [];
    let tickCount = 0;
    for (const pos of (state.mode4a.open || [])) {
      const m = mktMap[pos.ticker];
      if (!m) continue;
      const { minutesLeft } = windowTiming(m.close_time);
      const yesMid = midPrice(m.yes_bid, m.yes_ask);
      const noMid  = midPrice(m.no_bid,  m.no_ask);

      const isYes  = pos.side.toUpperCase() === 'YES';
      const nowPx  = isYes ? yesMid : noMid;
      const nowBid = isYes ? m.yes_bid : m.no_bid;
      const count  = Math.max(1, Math.floor(pos.cost / pos.contractPx));
      const curVal = parseFloat((count * nowPx).toFixed(2));
      const unPnl  = parseFloat((curVal - pos.cost).toFixed(2));

      pos.currentPx     = parseFloat(nowPx.toFixed(4));
      pos.contractCount = count;
      pos.currentValue  = curVal;
      pos.unrealizedPnl = unPnl;
      pos.lastQuoteAt   = new Date().toISOString();

      const arrow = unPnl >= 0 ? '↑' : '↓';
      console.log(`  📊 [OPEN] ${pos.ticker.slice(-22)} ${pos.side} ${count}x  entry ${(pos.contractPx*100).toFixed(0)}¢ → now ${(nowPx*100).toFixed(0)}¢  val $${curVal.toFixed(2)}  ${arrow} ${fmt$(unPnl)}  ${minutesLeft.toFixed(1)}m left`);

      if (!pos.priceTicks) pos.priceTicks = [];
      pos.priceTicks.push({
        ts:          new Date().toISOString(),
        btcPrice:    parseFloat(btcPrice.toFixed(2)),
        yesMid:      parseFloat(yesMid.toFixed(4)),
        noMid:       parseFloat(noMid.toFixed(4)),
        rsi1m:       rsi1m ? parseFloat(rsi1m.toFixed(1)) : null,
        minutesLeft: parseFloat(minutesLeft.toFixed(2)),
      });
      tickCount++;

      // ── Hard Take Profit: lock in TP_AMOUNT gain the moment we hit it.
      // Sells at current bid; actual ≈ TP - half-spread. Backtest shows
      // this fires on ~80% of trades and is the biggest single edge.
      const gain = nowPx - pos.contractPx;
      if (minutesLeft > 0.5 && gain >= TP_AMOUNT) {
        const reason = `TP +${(gain*100).toFixed(0)}¢ (entry ${(pos.contractPx*100).toFixed(0)}¢ → mid ${(nowPx*100).toFixed(0)}¢)`;
        const ok = await exitPosition(state.mode4a, 'mode4a', pos, nowPx, nowBid, reason);
        if (ok) { exitedTickers.push(pos.ticker); continue; }
      }

      // ── Salvage SL: in last 3 min, if losing badly with a real bid,
      // sell to recoup some money instead of waiting for the $0 settle.
      if (minutesLeft > 0.5 && minutesLeft <= SL_MIN_LEFT && nowPx < SL_THRESHOLD && nowBid >= SL_FLOOR_BID) {
        const reason = `SL ${(nowBid*100).toFixed(0)}¢ @ ${minutesLeft.toFixed(1)}m left`;
        const ok = await exitPosition(state.mode4a, 'mode4a', pos, nowPx, nowBid, reason);
        if (ok) { exitedTickers.push(pos.ticker); continue; }
      }
      openValueTotal += curVal;
      openUnrealized += unPnl;
    }
    if (tickCount > 0) console.log(`  📈 Tick logged for ${tickCount} open position(s)`);
    if (exitedTickers.length) {
      state.mode4a.open = state.mode4a.open.filter(p => !exitedTickers.includes(p.ticker));
    }
  }

  // Effective bankroll = cash + market value of open positions.
  // Refreshed every scan; used for display/dashboard, not for the
  // "can I afford this bet" check (that still uses cash only).
  state.mode4a.openValue        = parseFloat(openValueTotal.toFixed(2));
  state.mode4a.openUnrealized   = parseFloat(openUnrealized.toFixed(2));
  state.mode4a.effectiveBankroll= parseFloat((state.mode4a.bankroll + openValueTotal).toFixed(2));
  if (state.mode4a.open && state.mode4a.open.length > 0) {
    console.log(`  💼 cash $${state.mode4a.bankroll.toFixed(2)}  +  open $${openValueTotal.toFixed(2)} (${openUnrealized>=0?'+':''}${openUnrealized.toFixed(2)})  =  effective $${state.mode4a.effectiveBankroll.toFixed(2)}`);
  }

  // ── Mode 4a: scan every market in the entry window ───────────
  {
    const ms = state.mode4a;
    const candidates = allMkts
      .map(m => {
        const { minutesIn, minutesLeft } = windowTiming(m.close_time);
        return { m, minutesIn, minutesLeft };
      })
      .filter(({ minutesIn, minutesLeft }) =>
        minutesIn >= MODE4A_MIN_IN && minutesIn <= MODE4A_MAX_IN &&
        minutesLeft >= MODE4A_MIN_LEFT && minutesLeft <= MODE4A_MAX_LEFT
      );

    if (candidates.length === 0) console.log('  [M4a] No markets in window this scan');

    // Time-based loss cooldown: sit out 30min after each loss.
    // Old signal-counter (skipSignals) burned through in one scan when
    // many markets are open, allowing re-entry within seconds.
    const streak = ms.lossStreak || 0;
    if (ms.cooldownUntilMs && Date.now() < ms.cooldownUntilMs) {
      const minsLeft = ((ms.cooldownUntilMs - Date.now()) / 60000).toFixed(1);
      const dynReq   = streak >= 2 ? 5 : 4;
      console.log(`  [M4a] COOLDOWN ${minsLeft}m remaining (streak ${streak}L) — need ${dynReq}/7 after cooldown`);
    } else {
      // Dynamic confluence: raise bar after losses to avoid back-to-back losses.
      // 0 losses → 2/7 (normal), 1 loss → 4/7, 2+ losses → 5/7
      const dynConf = streak >= 2 ? 5 : streak >= 1 ? 4 : MODE4A_CONFLUENCE;
      if (streak > 0) console.log(`  [M4a] Loss streak ${streak} — requiring ${dynConf}/7 confluence`);

      for (const { m, minutesIn, minutesLeft } of candidates) {
        if (ms.open.some(p => p.ticker === m.ticker)) continue;

        const sig = evalMode4a(m, candlesByTf, minutesIn, minutesLeft, dynConf);
        if (!sig.enter) {
          console.log(`  [M4a] SKIP ${m.ticker.slice(-20)} -- ${sig.reason}`);
          continue;
        }

        // 5m RSI slope filter — skip if momentum is against trade direction.
        // For YES: 5m RSI must not be falling > SLOPE_TOLERANCE.
        // For NO:  5m RSI must not be rising > SLOPE_TOLERANCE.
        const slope = rsi5mSlope(state);
        const slopeOk = sig.side === 'YES'
          ? slope >= -SLOPE_TOLERANCE
          : slope <=  SLOPE_TOLERANCE;
        if (!slopeOk) {
          console.log(`  [M4a] SKIP ${m.ticker.slice(-20)} -- 5m RSI slope ${slope>=0?'+':''}${slope.toFixed(1)} against ${sig.side}`);
          continue;
        }

        const { cost, base, multi, recovery, attempt } = getCurrentBet(ms);
        if (ms.bankroll < cost) {
          console.log(`  [M4a] SKIP -- bankroll $${ms.bankroll.toFixed(2)} < bet $${cost.toFixed(2)}`);
          continue;
        }

        const profit   = cost * (1 / sig.contractPx - 1);
        const recovTag = recovery ? ` [${multi}x RECOVERY ${attempt}/${MAX_RECOVERY_ATTEMPTS}]` : '';
        const slopeTag = ` 5mΔ ${slope>=0?'+':''}${slope.toFixed(1)}`;
        console.log(`\n  [M4a] ENTER -- ${sig.reason}${slopeTag}  bet $${cost} (tier $${base} @ $${ms.bankroll.toFixed(0)} bank)${recovTag}  win: +$${profit.toFixed(2)}`);

        const entered = await enterPosition(ms, 'mode4a', {
          ticker: m.ticker, side: sig.side, cost, contractPx: sig.contractPx,
          payout: cost / sig.contractPx,
          mode: 'M4a', confluenceScore: sig.confluenceScore, confluenceDir: sig.confluenceDir,
          btcPrice, strike: m.floor_strike, distance: btcPrice - m.floor_strike,
          rsi1m, close_time: m.close_time, recoveryMulti: multi,
          // Backtest diagnostics — the gates the log was previously missing:
          tfBreakdown: sig.tfBreakdown, dir30m: sig.dir30m, dir1h: sig.dir1h, rsi1h: sig.rsi1h,
        });
        if (entered) {
          const tag = LIVE_MODE ? '[LIVE]' : '[PAPER]';
          console.log(`  [M4a] >> ${tag} ${sig.side} @ ${(sig.contractPx*100).toFixed(0)}¢  bet $${cost.toFixed(2)}  payout $${(cost/sig.contractPx).toFixed(2)}`);
        }
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────
  const s = modeStats(state.mode4a);
  const ms = state.mode4a;
  const { cost: curBet, recovery, attempt } = getCurrentBet(ms);
  const cdStr = (ms.cooldownUntilMs && Date.now() < ms.cooldownUntilMs)
    ? `  CD ${((ms.cooldownUntilMs - Date.now())/60000).toFixed(0)}m` : '';
  const recovStr = recovery ? `  REC ${attempt}/${MAX_RECOVERY_ATTEMPTS}` : '';
  console.log('\n  -- Stats ----------------------------------------------------------');
  console.log(`  Mode 4a: ${s.wins}/${s.tot} (${s.wr.toFixed(0)}% WR)  P&L ${fmt$(s.pnl)}  streak: ${ms.lossStreak}L  bank $${ms.bankroll.toFixed(2)}  bet $${curBet}  ${LIVE_MODE ? 'LIVE' : 'PAPER'}${cdStr}${recovStr}`);

  saveState(state, 'tick');
}

// ── Entry ─────────────────────────────────────────────────────────
if (LIVE_MODE) {
  console.log('\n*** Kalshi BTC Mode 4a Bot  [LIVE TRADING] ***');
  console.log('  WARNING: Real orders will be placed on your Kalshi account.');
  console.log(`  Key ID: ${keyId}`);
} else {
  console.log('\nKalshi BTC Mode 4a Bot  [PAPER — simulation]');
  console.log('  No real orders. Remove --paper (and MODE=paper) to go live.');
}
console.log(`  Bet tier: $5/$8/$11/$14/$17/$20 @ <$200/<$350/<$500/<$650/<$800/$800+  |  Recovery: ${RECOVERY_MULTI}x for ${MAX_RECOVERY_ATTEMPTS} attempts then reset`);
console.log(`  Mid: ${MODE4A_MID_LO*100}-${MODE4A_MID_HI*100}¢  Confluence: ${MODE4A_CONFLUENCE}/7  |  Cooldown: 30min  |  5m RSI slope filter ON`);
console.log(`  Hard TP: +${TP_AMOUNT*100}¢ from entry  |  Salvage SL: <${SL_THRESHOLD*100}¢ w/ ≤${SL_MIN_LEFT}m left`);
console.log(`  Daily loss cap: $${MAX_DAILY_LOSS}  |  Scan every ${INTERVAL/1000}s\n`);

// ── Resilient scan loop ───────────────────────────────────────────
async function safeScan() {
  try {
    await scan();
  } catch (e) {
    console.log(`\n  !! scan() threw: ${e.message || e}`);
    console.log('  !! Will retry next tick — bot stays alive');
  }
}

process.on('unhandledRejection', (err) => {
  console.log(`  !! unhandledRejection: ${err && err.message ? err.message : err}`);
});

safeScan();
setInterval(safeScan, INTERVAL);
