/**
 * kalshi_btc_paper_bot.js — Multi-Mode BTC 15-min Paper Trading Bot
 *
 * MODE 1 — Early Entry (minutes 0-2)
 *   70%+ directional confidence from RSI + momentum + volume + streak
 *   Step bet: $10->$25->$50->$150->$400->$777 (half-step after 4-loss pause)
 *
 * MODE 2 — Mid Window Confirmation (minutes 5-10)
 *   BTC must be $200+ from strike, RSI not in reversal, momentum flat/continuing
 *   Step bet: $10->$25->$50->$150->$400->$777 (half-step after 4-loss pause)
 *
 * MODE 3 — Contrarian Lottery (paper only, $1 flat, never real money)
 *   One side hits 90%+ probability AND price is moving against the crowd
 *
 * CONTRACT CAPTURE SYSTEM
 *   Logs real Kalshi YES/NO prices, BTC price, distance, RSI at:
 *     - Window open (minute 0-2): captures open conditions + Mode 1 signal
 *     - Entry window (minute 5-7): captures entry conditions + Mode 2 signal
 *     - Resolution: captures final result
 *   Saved to dashboard/btc_contract_log.json for backtesting validation
 *
 * RISK MANAGEMENT
 *   Base bet: $7.00 flat per trade
 *   After 4 consecutive losses: pause 3 hours, drop to $3.50
 *   Back to $7.00 after 2 consecutive wins at reduced size
 *
 * Usage:
 *   node kalshi_btc_paper_bot.js YOUR-API-KEY-ID
 *   node kalshi_btc_paper_bot.js YOUR-API-KEY-ID --interval 60
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sb     = require('./supabase_client');
const gh     = require('./github_state');

// ── Module-level scan context (set at start of each scan tick) ────
// Used by enterPosition / resolveExpired which don't receive these
// as parameters but need them for Supabase writes.
let _scanBtc   = null;
let _scanR1    = null;
let _scanR5    = null;
let _scanState = null;

// ── Config ────────────────────────────────────────────────────────
const PAPER_START        = 50.00;
const MODE1_BET          = 3.00;        // Mode 1: flat $3 per trade (matches Mode 4)
const MIN_BET            = 1.50;        // floor after pause (half of $3)
const PAUSE_LOSSES       = 4;           // consecutive losses before pause
const PAUSE_DURATION_MS  = 3 * 60 * 60 * 1000;  // 3 hours
const WINS_TO_RESTORE    = 2;           // wins at reduced size before restoring full bet
const MIN_CONFIDENCE     = 70;          // Mode 1: minimum % to enter
const MODE2_MIN_DIST     = 200;         // Mode 2: min $ distance from strike
const CONTRARIAN_BET     = 1.00;        // Mode 3: $1 flat, paper only
const CONTRARIAN_THRESH  = 0.90;        // Mode 3: 90%+ one side triggers check

// ── Mode 4: 7-TF Confluence Late-Window Strategy ──────────────────
// Entry window : 9–15 min into contract (0–6 min remaining) — the "last
//                6 minutes" sweet spot. Wider than before; previous 7-12
//                window almost never triggered.
// Mid filter   : YES or NO mid must be 0.70–0.96. Hard ceiling at 96¢
//                (no profit margin above that); floor at 70¢ so we still
//                need some directional signal in the market.
// Confluence   : 3+ of 7 timeframes (1m,3m,5m,15m,30m,1h,4h) agree on
//                direction. Was 4; relaxed to fire more often.
// Direction    : UP trend → bet YES  |  DOWN trend → bet NO
// Bet          : $5 flat per entry, one entry per contract
const MODE4_BET         = 5.00;
const MODE4_MID_LO      = 0.70;
const MODE4_MID_HI      = 0.96;
const MODE4_MIN_IN      = 9;           // min minutes into contract to consider
const MODE4_MAX_IN      = 14.5;        // up to 30s before close
const MODE4_MIN_LEFT    = 0.5;         // allow entry up to last 30 seconds
const MODE4_MAX_LEFT    = 6;           // earliest entry when 6 min remain
const MODE4_CONFLUENCE  = 3;           // TFs that must agree (out of 7)

// ── Kill switch — daily loss cap (LIVE only) ──────────────────────
// Bot exits if its cumulative live PnL today is below -MAX_DAILY_LOSS.
const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || '25');

const SCAN_INTERVAL      = 30 * 1000;   // 30 seconds
const STATE_FILE         = path.join(__dirname, 'dashboard', 'btc_paper_state.json');

// ── Parse args ────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const keyId     = args.find(a => !a.startsWith('--')) || process.env.KALSHI_API_KEY;
const intArg    = args.indexOf('--interval');
const INTERVAL  = intArg >= 0 ? parseInt(args[intArg + 1], 10) * 1000 : SCAN_INTERVAL;
const LIVE_MODE = args.includes('--live') || process.env.MODE === 'live';

if (!keyId) {
  console.error('Usage: node kalshi_btc_paper_bot.js YOUR-API-KEY-ID [--live] [--interval 30]');
  process.exit(1);
}

const BASE     = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH = '/trade-api/v2';
const pem      = fs.readFileSync(path.join(__dirname, 'kalshi_private_key.pem'), 'utf8');

// ── Helpers ───────────────────────────────────────────────────────
const ts    = () => new Date().toLocaleTimeString('en-US', { hour12: false });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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

// ── Bet sizing ────────────────────────────────────────────────────
// Mode 1 uses flat $3 (MODE1_BET). Step table kept for reference / future use.
function getStepBet(bankroll) {
  if (bankroll >= 8000) return 777;
  if (bankroll >= 4000) return 400;
  if (bankroll >= 1500) return 150;
  if (bankroll >= 500)  return 50;
  if (bankroll >= 200)  return 25;
  return 10;
}

function getBetSize(modeState) {
  const now    = Date.now();
  const flatBet = MODE1_BET;
  // Still in pause window — no trading
  if (modeState.pauseUntil && now < modeState.pauseUntil) {
    const minsLeft = ((modeState.pauseUntil - now) / 60000).toFixed(0);
    return { bet: null, reason: `Paused ${minsLeft}min remaining (4-loss streak)` };
  }
  // Pause ended — half-bet until WINS_TO_RESTORE consecutive wins
  if (modeState.useReducedBet) {
    const reduced = Math.max(MIN_BET, flatBet / 2);
    return { bet: reduced, reason: `Reduced $${reduced.toFixed(2)} post-pause` };
  }
  return { bet: flatBet, reason: `Flat $${flatBet.toFixed(2)}` };
}

// ── After loss/win — update streak and pause logic ─────────────────
function updateStreak(modeState, won, modeKey) {
  if (won) {
    modeState.lossStreak = 0;
    // Count consecutive wins at reduced size toward restoration
    if (modeState.useReducedBet) {
      modeState.reducedWins = (modeState.reducedWins || 0) + 1;
      if (modeState.reducedWins >= WINS_TO_RESTORE) {
        modeState.useReducedBet = false;
        modeState.reducedWins   = 0;
        modeState.pauseUntil    = null;
        console.log(`  📈 [${modeKey.toUpperCase()}] 2 wins in a row — restored to step bet`);
      }
    }
  } else {
    modeState.lossStreak = (modeState.lossStreak || 0) + 1;
    modeState.reducedWins = 0;
    if (modeState.lossStreak >= PAUSE_LOSSES) {
      modeState.pauseUntil    = Date.now() + PAUSE_DURATION_MS;
      modeState.useReducedBet = true;
      const resume = new Date(modeState.pauseUntil).toLocaleTimeString('en-US', { hour12: false });
      console.log(`  ⏸ [${modeKey.toUpperCase()}] ${PAUSE_LOSSES} consecutive losses — paused 3h until ${resume}, dropping to half-step`);
    }
  }
}

// ── Contract timing ───────────────────────────────────────────────
function windowTiming(closeTime) {
  const now  = Date.now();
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

// ── MODE 1: Early Entry Signal ────────────────────────────────────
function evalMode1(mkt, btcPrice, rsi1m, rsi5m, candles1m, prevContractSide) {
  const strike   = mkt.floor_strike;
  const distance = btcPrice - strike;
  let bull = 50;

  if (rsi1m !== null) {
    if      (rsi1m < 25) bull += 18;
    else if (rsi1m < 35) bull += 10;
    else if (rsi1m < 45) bull += 4;
    else if (rsi1m > 75) bull -= 18;
    else if (rsi1m > 65) bull -= 10;
    else if (rsi1m > 55) bull -= 4;
  }
  if (rsi5m !== null) {
    if      (rsi5m < 35) bull += 10;
    else if (rsi5m > 65) bull -= 10;
    else if (rsi5m < 45) bull += 4;
    else if (rsi5m > 55) bull -= 4;
  }

  const recent = candles1m.slice(-4, -1);
  const greens  = recent.filter(c => c.close > c.open).length;
  const reds    = recent.filter(c => c.close < c.open).length;
  if      (greens === 3) bull += 14;
  else if (greens === 2) bull += 6;
  else if (reds   === 3) bull -= 14;
  else if (reds   === 2) bull -= 6;

  if (prevContractSide === 'YES') bull += 6;
  else if (prevContractSide === 'NO') bull -= 6;

  const avgVol = candles1m.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  const lastC  = candles1m[candles1m.length - 1];
  if (lastC && avgVol > 0 && lastC.volume > avgVol * 1.5) {
    bull += lastC.close >= lastC.open ? 9 : -9;
  }

  if      (distance >  500) bull += 12;
  else if (distance >  200) bull += 7;
  else if (distance < -500) bull -= 12;
  else if (distance < -200) bull -= 7;

  bull = clamp(Math.round(bull), 0, 100);
  const side       = distance >= 0 ? 'YES' : 'NO';
  const confidence = side === 'YES' ? bull : 100 - bull;

  if (confidence >= MIN_CONFIDENCE)
    return { enter: true, side, confidence, reason: `${confidence}% confidence` };
  return { enter: false, side, confidence, reason: `${confidence}% — need ${MIN_CONFIDENCE}%+` };
}

// ── MODE 2: Mid Window Confirmation ──────────────────────────────
function evalMode2(mkt, btcPrice, rsi1m, rsi5m, candles1m) {
  const strike   = mkt.floor_strike;
  const distance = btcPrice - strike;
  const absDist  = Math.abs(distance);
  const side     = distance >= 0 ? 'YES' : 'NO';

  if (absDist < MODE2_MIN_DIST)
    return { enter: false, reason: `$${absDist.toFixed(0)} from strike — need $${MODE2_MIN_DIST}+` };

  if (rsi1m !== null) {
    if (side === 'YES' && rsi1m > 72)
      return { enter: false, reason: `RSI(1m) ${rsi1m.toFixed(0)} — overbought` };
    if (side === 'NO'  && rsi1m < 28)
      return { enter: false, reason: `RSI(1m) ${rsi1m.toFixed(0)} — oversold` };
  }

  const recent = candles1m.slice(-3);
  if (side === 'YES' && recent.filter(c => c.close < c.open).length === 3)
    return { enter: false, reason: 'Momentum reversing — 3 red candles' };
  if (side === 'NO'  && recent.filter(c => c.close > c.open).length === 3)
    return { enter: false, reason: 'Momentum reversing — 3 green candles' };

  let confidence = 65;
  if      (absDist >= 600) confidence = 80;
  else if (absDist >= 400) confidence = 73;
  else if (absDist >= 300) confidence = 69;

  if (rsi5m !== null) {
    if (side === 'YES' && rsi5m < 50) confidence += 3;
    if (side === 'NO'  && rsi5m > 50) confidence += 3;
  }

  return { enter: true, side, confidence, absDist, reason: `$${absDist.toFixed(0)} from strike` };
}

// ── MODE 3: Contrarian Lottery ────────────────────────────────────
function evalMode3(mkt, candles1m) {
  const yesMid    = midPrice(mkt.yes_bid, mkt.yes_ask);
  const noMid     = midPrice(mkt.no_bid,  mkt.no_ask);
  const crowdSide = yesMid >= CONTRARIAN_THRESH ? 'YES' : noMid >= CONTRARIAN_THRESH ? 'NO' : null;
  if (!crowdSide)
    return { enter: false, reason: `No side at ${CONTRARIAN_THRESH*100}%+` };

  const recent   = candles1m.slice(-4, -1);
  const priceUp  = recent[recent.length - 1].close > recent[0].open;
  const crowdUp  = crowdSide === 'YES';
  if (priceUp === crowdUp)
    return { enter: false, reason: `Price moving WITH crowd` };

  const contraside = crowdSide === 'YES' ? 'NO' : 'YES';
  const contractPx = contraside === 'YES' ? yesMid : noMid;
  const crowdPct   = Math.max(yesMid, noMid);
  return {
    enter: true, side: contraside, contractPx: contractPx || 0.10,
    reason: `Crowd ${(crowdPct*100).toFixed(0)}% ${crowdSide} but price going ${priceUp?'UP':'DOWN'}`,
  };
}

// ── MODE 4: Per-timeframe trend signal ───────────────────────────
// Returns 'UP', 'DOWN', or null (neutral/conflicted).
// Uses RSI(14) + 3-candle slope — 2 matching signals = directional.
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

// ── MODE 4: 7-TF confluence scorer ───────────────────────────────
function calcConfluence(candlesByTf) {
  const TFS     = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
  const signals = TFS.map(tf => tfTrend(candlesByTf[tf]));
  const up      = signals.filter(s => s === 'UP').length;
  const dn      = signals.filter(s => s === 'DOWN').length;
  const breakdown = {};
  TFS.forEach((tf, i) => { breakdown[tf] = signals[i]; });
  if (up > dn && up >= MODE4_CONFLUENCE) return { dir: 'UP',   score: up, breakdown };
  if (dn > up && dn >= MODE4_CONFLUENCE) return { dir: 'DOWN', score: dn, breakdown };
  return { dir: null, score: Math.max(up, dn), breakdown };
}

// ── MODE 4: 7-TF Confluence Late-Window Evaluator ─────────────────
// Returns: { enter, side, contractPx, confluenceScore, confluenceDir, reason }
function evalMode4(mkt, candlesByTf, minutesIn, minutesLeft) {
  // Window: 7–12 min in (3–8 min remaining)
  if (minutesIn < MODE4_MIN_IN || minutesIn > MODE4_MAX_IN ||
      minutesLeft < MODE4_MIN_LEFT || minutesLeft > MODE4_MAX_LEFT) {
    return { enter: false, reason: `Outside window (in ${minutesIn.toFixed(1)} / left ${minutesLeft.toFixed(1)})` };
  }

  const yesMid = midPrice(mkt.yes_bid, mkt.yes_ask);
  const noMid  = midPrice(mkt.no_bid,  mkt.no_ask);
  const yesOk  = yesMid >= MODE4_MID_LO && yesMid <= MODE4_MID_HI;
  const noOk   = noMid  >= MODE4_MID_LO && noMid  <= MODE4_MID_HI;

  if (!yesOk && !noOk) {
    const best = Math.max(yesMid, noMid).toFixed(0);
    return { enter: false, reason: `Mid out of range (best ${best}¢ — need ${MODE4_MID_LO*100}-${MODE4_MID_HI*100}¢)` };
  }

  const { dir, score, breakdown } = calcConfluence(candlesByTf);
  if (!dir) {
    return { enter: false, reason: `Weak confluence (${score}/7 TFs — need ${MODE4_CONFLUENCE}+)` };
  }

  let side, contractPx;
  if      (dir === 'UP'   && yesOk) { side = 'YES'; contractPx = yesMid; }
  else if (dir === 'DOWN' && noOk)  { side = 'NO';  contractPx = noMid;  }
  else {
    const wanted = dir === 'UP' ? 'YES' : 'NO';
    return { enter: false, reason: `${dir} trend but ${wanted} mid not in range` };
  }

  const tfStr = Object.entries(breakdown)
    .map(([tf, v]) => `${tf}:${v ? v[0] : '—'}`)
    .join(' ');
  return {
    enter: true, side, contractPx,
    confluenceScore: score, confluenceDir: dir,
    reason: `${score}/7 ${dir}  ${side}@${(contractPx*100).toFixed(0)}¢  ${minutesLeft.toFixed(1)}m left  [${tfStr}]`,
  };
}

// ── UTC date helper ───────────────────────────────────────────────
function utcDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Contract Capture → Supabase ───────────────────────────────────
// Replaces the old local btc_contract_log.json system.
// Fires async (fire-and-forget) — never blocks the scan loop.
// Supabase upsert uses ignore-duplicates so only the first capture
// per (ticker, phase) persists (no overwriting mid-window).
function captureContract(ticker, phase, data) {
  sb.upsertCapture(ticker, phase, data).catch(function(e) {
    console.log('  !! capture ' + phase + ' ' + ticker + ': ' + e.message);
  });
}

// ── State I/O ─────────────────────────────────────────────────────
const defaultModeState = (bankroll) => ({
  bankroll, trades: [], open: [], lossStreak: 0,
  pauseUntil: null, useReducedBet: false, reducedWins: 0,
});

function ensureStateShape(state) {
  state = state || {};
  state.mode1 = { ...defaultModeState(PAPER_START), ...(state.mode1 || {}) };
  state.mode2 = { ...defaultModeState(PAPER_START), ...(state.mode2 || {}) };
  state.mode3 = { bankroll: 0, trades: [], open: [], lossStreak: 0, paperOnly: true, ...(state.mode3 || {}) };
  state.mode4 = { ...defaultModeState(PAPER_START), ...(state.mode4 || {}) };
  // Guarantee arrays exist even if loaded JSON had them missing or null
  for (const mk of ['mode1', 'mode2', 'mode3', 'mode4']) {
    if (!Array.isArray(state[mk].trades)) state[mk].trades = [];
    if (!Array.isArray(state[mk].open))   state[mk].open   = [];
  }
  // Mode 4 legacy daily-cap field — kept for backward compat with existing state files
  if (!state.mode4.daily) state.mode4.daily = { date: utcDateStr(), count: 0 };
  if (state.prevContractSide === undefined) state.prevContractSide = null;
  if (state.liveMarket === undefined)       state.liveMarket = null;
  if (state.lastUpdate === undefined)       state.lastUpdate = null;
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
  for (const mk of ['mode1', 'mode2', 'mode3', 'mode4']) {
    if (state[mk] && Array.isArray(state[mk].trades) && state[mk].trades.length > 500) {
      state[mk].trades = state[mk].trades.slice(-500);
    }
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  // In CI: commit + push so the dashboard can read it via the GitHub API.
  // Fire-and-forget — never blocks the scan loop.
  if (gh.ENABLED && pushLabel) gh.pushState(pushLabel).catch(() => {});
}

// GitHub push removed — all logging now goes to Supabase.


// ── Resolve expired positions ─────────────────────────────────────
async function resolveExpired(modeState, modeKey, markets) {
  const now = Date.now();
  const pending = [];

  for (const pos of modeState.open) {
    const closeMs = new Date(pos.close_time).getTime();
    if (now < closeMs + 90_000) { pending.push(pos); continue; }

    let won = null;
    const mkt = markets.find(m => m.ticker === pos.ticker);
    if (mkt?.result) {
      won = mkt.result.toUpperCase() === pos.side.toUpperCase();
    } else {
      const resp = await kalshiGet('/markets/' + pos.ticker).catch(() => null);
      const m    = resp?.market;
      if (m?.result) won = m.result.toUpperCase() === pos.side.toUpperCase();
      else { pending.push(pos); continue; }
    }

    const pnl = won
      ? parseFloat((pos.cost / pos.contractPx - pos.cost).toFixed(2))
      : -pos.cost;

    if (modeKey !== 'mode3') {
      modeState.bankroll = parseFloat(Math.max(0, modeState.bankroll + (won ? pos.cost / pos.contractPx : 0) - pos.cost + pos.cost).toFixed(4));
      // Simpler: bankroll += pnl
      modeState.bankroll = parseFloat(Math.max(0, modeState.bankroll + pnl).toFixed(4));
    }

    updateStreak(modeState, won, modeKey);
    modeState.trades.push({ ...pos, resolved: true, won, pnl, resolved_at: new Date().toISOString() });

    // Write resolution to Supabase
    captureContract(pos.ticker, 'resolution', { won, pnl });
    sb.resolvePosition(pos.sb_id, won, pnl, pos.priceTicks)
      .catch(e => console.log('  !! sb.resolvePosition: ' + e.message));
    if (_scanState) {
      sb.insertBotState(_scanState, 'resolution', modeKey, _scanBtc, _scanR1)
        .catch(e => console.log('  !! sb.insertBotState: ' + e.message));
    }

    if (modeKey === 'mode1') global._lastResolved = pos.side;

    const icon = won ? '✅' : '❌';
    console.log(`  ${icon} [${modeKey.toUpperCase()}] ${pos.ticker} ${pos.side} @ ${(pos.contractPx*100).toFixed(0)}¢ → ${won?'WIN':'LOSS'} ${fmt$(pnl)}  streak: ${modeState.lossStreak} losses`);

    // Resolution event — commit state so dashboard reflects W/L + new bankroll immediately.
    if (_scanState) saveState(_scanState, 'resolution');
  }

  modeState.open = pending;
}

// ── Enter a position (paper or live) ─────────────────────────────
async function enterPosition(modeState, modeKey, entry) {
  if (modeState.open.some(p => p.ticker === entry.ticker)) return false;
  if (entry.cost <= 0) return false;
  if (modeKey !== 'mode3' && modeState.bankroll < entry.cost) return false;

  // Only Mode 4 trades live — all other modes are paper-only
  const isLive = LIVE_MODE && modeKey === 'mode4';

  if (isLive) {
    // Convert to Kalshi order format:
    //   count      = number of $1-face contracts (floor of cost / contractPx)
    //   yes_price / no_price = price in cents (integer 1-99)
    const priceInCents = Math.round(entry.contractPx * 100);
    const count        = Math.max(1, Math.floor(entry.cost / entry.contractPx));
    const side         = entry.side.toLowerCase();   // "yes" or "no"
    const orderBody    = {
      ticker: entry.ticker,
      side,
      count,
      action: 'buy',
      type:   'limit',
      [`${side}_price`]: priceInCents,
    };

    try {
      const resp = await kalshiPost('/orders', orderBody);
      if (resp.status !== 200 && resp.status !== 201) {
        console.log(`  ❌ [LIVE] Order FAILED (HTTP ${resp.status}): ${JSON.stringify(resp.body).slice(0, 300)}`);
        return false;   // do NOT update paper state on API failure
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
  if (modeKey !== 'mode3') {
    modeState.bankroll = parseFloat((modeState.bankroll - entry.cost).toFixed(4));
  }

  // Write to Supabase (fire-and-forget — store id for later resolution patch)
  sb.insertPosition(posEntry, modeKey, _scanR1, _scanR5)
    .then(id => { if (id) posEntry.sb_id = id; })
    .catch(e => console.log('  !! sb.insertPosition: ' + e.message));
  if (_scanState) {
    sb.insertBotState(_scanState, 'entry', modeKey, _scanBtc, _scanR1)
      .catch(e => console.log('  !! sb.insertBotState: ' + e.message));
  }

  // Persist + commit on entry so the dashboard reflects the new position immediately.
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

// ── Main scan ─────────────────────────────────────────────────────
function todayLivePnl(state) {
  const today = new Date().toISOString().slice(0, 10);
  let pnl = 0;
  for (const mk of ['mode1', 'mode2', 'mode3', 'mode4']) {
    const trades = (state[mk] && state[mk].trades) || [];
    for (const t of trades) {
      if (t.live && t.resolved_at && t.resolved_at.startsWith(today)) {
        pnl += (t.pnl || 0);
      }
    }
  }
  return pnl;
}

async function scan() {
  const state = loadState();

  // Kill switch — bail if live PnL today is below the floor (live mode only).
  if (LIVE_MODE && MAX_DAILY_LOSS > 0) {
    const live = todayLivePnl(state);
    if (live <= -MAX_DAILY_LOSS) {
      console.log(`\n  🛑 [KILL SWITCH] Today's LIVE PnL ${live.toFixed(2)} <= -${MAX_DAILY_LOSS}. Stopping bot.`);
      process.exit(0);
    }
  }

  const modeLabel = LIVE_MODE ? '🟢 LIVE' : '📄 PAPER';
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`  BTC Bot [${modeLabel}]  |  ${ts()}  |  M1: $${state.mode1.bankroll.toFixed(2)}  M2: $${state.mode2.bankroll.toFixed(2)}`);
  console.log(`${'═'.repeat(78)}`);

  // ── Binance data (all 7 TFs for Mode 4 confluence) ───────────
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

  // Candle map for Mode 4 confluence scorer
  const candlesByTf = {
    '1m': candles1m, '3m': candles3m, '5m': candles5m,
    '15m': candles15m, '30m': candles30m, '1h': candles1h, '4h': candles4h,
  };
  console.log(`  BTC $${Math.round(btcPrice).toLocaleString()}  |  RSI 1m: ${rsi1m ? rsi1m.toFixed(1) : '--'}  RSI 5m: ${rsi5m ? rsi5m.toFixed(1) : '--'}`);

  // Update module-level scan context (used by enterPosition + resolveExpired)
  _scanBtc   = btcPrice;
  _scanR1    = rsi1m;
  _scanR5    = rsi5m;
  _scanState = state;

  // ── Kalshi markets ────────────────────────────────────────────
  let allMkts = [];
  try {
    const eventsRaw = await kalshiGet('/events?series_ticker=KXBTCD&status=open&limit=10');
    const events    = eventsRaw.events || [];
    const mktArrays = await Promise.all(
      events.map(ev => kalshiGet(`/markets?event_ticker=${ev.event_ticker}&limit=200`).catch(() => ({})))
    );
    allMkts = mktArrays.flatMap(r => r.markets || []).map(m => ({
      ...m,
      yes_bid: m.yes_bid_dollars ?? m.yes_bid ?? 0,
      yes_ask: m.yes_ask_dollars ?? m.yes_ask ?? 0,
      no_bid:  m.no_bid_dollars  ?? m.no_bid  ?? 0,
      no_ask:  m.no_ask_dollars  ?? m.no_ask  ?? 0,
    }));
  } catch (e) {
    console.log(`  !! Kalshi fetch failed: ${e.message}`);
  }

  // ── Resolve expired positions ─────────────────────────────────
  await Promise.all([
    resolveExpired(state.mode1, 'mode1', allMkts),
    resolveExpired(state.mode2, 'mode2', allMkts),
    resolveExpired(state.mode3, 'mode3', allMkts),
    resolveExpired(state.mode4, 'mode4', allMkts),
  ]);
  if (global._lastResolved) {
    state.prevContractSide = global._lastResolved;
    delete global._lastResolved;
  }

  // ── Find active nearby markets ────────────────────────────────
  const nearby = allMkts
    .filter(m => m.floor_strike && Math.abs(btcPrice - m.floor_strike) <= 3000)
    .sort((a, b) => Math.abs(btcPrice - a.floor_strike) - Math.abs(btcPrice - b.floor_strike));

  // Live market data for dashboard
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

  // ── INTRA-TRADE TICK LOGGING ─────────────────────────────────
  // For every open position in any mode, if its market is still live
  // in allMkts, record a price snapshot. Builds a priceTicks timeline
  // so we can see how YES/NO odds moved during the hold window.
  {
    const mktMap = {};
    for (const m of allMkts) mktMap[m.ticker] = m;
    let tickCount = 0;
    for (const mk of ['mode1', 'mode2', 'mode3', 'mode4']) {
      for (const pos of (state[mk]?.open || [])) {
        const m = mktMap[pos.ticker];
        if (!m) continue;
        const { minutesLeft } = windowTiming(m.close_time);
        const yMid = midPrice(m.yes_bid, m.yes_ask);
        const nMid = midPrice(m.no_bid,  m.no_ask);
        if (!pos.priceTicks) pos.priceTicks = [];
        pos.priceTicks.push({
          ts:          new Date().toISOString(),
          btcPrice:    parseFloat(btcPrice.toFixed(2)),
          yesMid:      parseFloat(yMid.toFixed(4)),
          noMid:       parseFloat(nMid.toFixed(4)),
          rsi1m:       rsi1m ? parseFloat(rsi1m.toFixed(1)) : null,
          minutesLeft: parseFloat(minutesLeft.toFixed(2)),
        });
        tickCount++;
      }
    }
    if (tickCount > 0) console.log(`  📈 Tick logged for ${tickCount} open position(s)`);
  }

  // ── Evaluate each market ──────────────────────────────────────
  for (const mkt of nearby.slice(0, 4)) {
    const { minutesIn, minutesLeft } = windowTiming(mkt.close_time);
    if (minutesLeft < 1 || minutesLeft > 15) continue;

    const yesMid  = midPrice(mkt.yes_bid, mkt.yes_ask);
    const noMid   = midPrice(mkt.no_bid,  mkt.no_ask);
    const dist    = btcPrice - mkt.floor_strike;
    const distStr = (dist >= 0 ? '+' : '') + dist.toFixed(0);

    console.log(`\n  -- ${mkt.ticker}  strike $${mkt.floor_strike?.toLocaleString()}  dist ${distStr}  ${minutesIn.toFixed(1)}min in / ${minutesLeft.toFixed(1)}min left  YES ${(yesMid*100).toFixed(0)}c NO ${(noMid*100).toFixed(0)}c`);

    const mktMeta = {
      strike:      mkt.floor_strike,
      windowStart: new Date(new Date(mkt.close_time).getTime() - 15*60*1000).toISOString(),
      windowEnd:   mkt.close_time,
    };

    // -- CONTRACT CAPTURE: window open phase (0-3 min) --------
    if (minutesIn >= 0 && minutesIn < 3) {
      const sig1 = evalMode1(mkt, btcPrice, rsi1m, rsi5m, candles1m, state.prevContractSide);
      captureContract(mkt.ticker, 'open', {
        minutesIn:  parseFloat(minutesIn.toFixed(2)),
        btcPrice:   parseFloat(btcPrice.toFixed(2)),
        distance:   parseFloat(dist.toFixed(2)),
        yesOdds:    parseFloat(yesMid.toFixed(3)),
        noOdds:     parseFloat(noMid.toFixed(3)),
        rsi1m:      rsi1m ? parseFloat(rsi1m.toFixed(1)) : null,
        rsi5m:      rsi5m ? parseFloat(rsi5m.toFixed(1)) : null,
        volume:     mkt.volume ?? null,
        mode1Signal: { enter: sig1.enter, side: sig1.side, confidence: sig1.confidence, reason: sig1.reason },
      });
    }

    // -- MODE 1: 0-2 min --------------------------------------
    if (minutesIn >= 0 && minutesIn <= 2 && minutesLeft >= 12) {
      const { bet, reason: betReason } = getBetSize(state.mode1);
      const sig = evalMode1(mkt, btcPrice, rsi1m, rsi5m, candles1m, state.prevContractSide);
      console.log(`  [M1] ${sig.enter && bet ? 'ENTER' : 'SKIP '} -- ${sig.reason}${bet ? '' : '  |  ' + betReason}`);

      if (sig.enter && bet !== null) {
        const contractPx = sig.side === 'YES' ? yesMid : noMid;
        if (contractPx > 0.02 && contractPx < 0.98) {
          const entered = await enterPosition(state.mode1, 'mode1', {
            ticker: mkt.ticker, side: sig.side, cost: bet, contractPx,
            payout: bet / contractPx, confidence: sig.confidence, mode: 'Mode 1',
            btcPrice, strike: mkt.floor_strike, distance: dist,
            rsi1m, rsi5m, close_time: mkt.close_time,
          });
          if (entered) {
            const tag = LIVE_MODE ? '[LIVE]' : '[PAPER]';
            console.log(`  [M1] >> ${tag} ENTERED ${sig.side} @ ${(contractPx*100).toFixed(0)}c  cost $${bet.toFixed(2)}  payout $${(bet/contractPx).toFixed(2)}`);
          }
        }
      }
    } else if (state.mode1.pauseUntil && Date.now() < state.mode1.pauseUntil) {
      const minsLeft = ((state.mode1.pauseUntil - Date.now()) / 60000).toFixed(0);
      if (minutesIn <= 2) console.log(`  [M1] PAUSED ${minsLeft}min remaining`);
    }

    // -- CONTRACT CAPTURE: entry phase (5-8 min) --------------
    if (minutesIn >= 5 && minutesIn < 8) {
      const sig2 = evalMode2(mkt, btcPrice, rsi1m, rsi5m, candles1m);
      captureContract(mkt.ticker, 'entry', {
        minutesIn:   parseFloat(minutesIn.toFixed(2)),
        btcPrice:    parseFloat(btcPrice.toFixed(2)),
        distance:    parseFloat(dist.toFixed(2)),
        yesOdds:     parseFloat(yesMid.toFixed(3)),
        noOdds:      parseFloat(noMid.toFixed(3)),
        rsi1m:       rsi1m ? parseFloat(rsi1m.toFixed(1)) : null,
        mode2Signal: { enter: sig2.enter, side: sig2.side, confidence: sig2.confidence, reason: sig2.reason },
      });
    }

    // -- MODE 2: 5-10 min ------------------------------------
    if (minutesIn >= 5 && minutesIn <= 10) {
      const { bet, reason: betReason } = getBetSize(state.mode2);
      const sig = evalMode2(mkt, btcPrice, rsi1m, rsi5m, candles1m);
      console.log(`  [M2] ${sig.enter && bet ? 'ENTER' : 'SKIP '} -- ${sig.reason}${bet ? '' : '  |  ' + betReason}`);

      if (sig.enter && bet !== null) {
        const contractPx = sig.side === 'YES' ? yesMid : noMid;
        if (contractPx > 0.02 && contractPx < 0.98) {
          const entered = await enterPosition(state.mode2, 'mode2', {
            ticker: mkt.ticker, side: sig.side, cost: bet, contractPx,
            payout: bet / contractPx, confidence: sig.confidence, mode: 'Mode 2',
            btcPrice, strike: mkt.floor_strike, distance: dist,
            rsi1m, rsi5m, close_time: mkt.close_time,
          });
          if (entered) {
            const tag = LIVE_MODE ? '[LIVE]' : '[PAPER]';
            console.log(`  [M2] >> ${tag} ENTERED ${sig.side} @ ${(contractPx*100).toFixed(0)}c  cost $${bet.toFixed(2)}  payout $${(bet/contractPx).toFixed(2)}`);
          }
        }
      }
    } else if (state.mode2.pauseUntil && Date.now() < state.mode2.pauseUntil) {
      if (minutesIn >= 5 && minutesIn <= 10) {
        const minsLeft = ((state.mode2.pauseUntil - Date.now()) / 60000).toFixed(0);
        console.log(`  [M2] PAUSED ${minsLeft}min remaining`);
      }
    }

    // -- MODE 3: Contrarian (always scans) -------------------
    const sig3 = evalMode3(mkt, candles1m);
    if (sig3.enter) {
      console.log(`  [M3] CONTRA -- ${sig3.reason}`);
      const entered = await enterPosition(state.mode3, 'mode3', {
        ticker: mkt.ticker, side: sig3.side, cost: CONTRARIAN_BET,
        contractPx: sig3.contractPx, payout: CONTRARIAN_BET / sig3.contractPx,
        mode: 'Mode 3', btcPrice, strike: mkt.floor_strike, close_time: mkt.close_time, paperOnly: true,
      });
      if (entered) console.log(`  [M3] >> [PAPER] $1 ${sig3.side} @ ${(sig3.contractPx*100).toFixed(0)}c`);
    }
  }


  // -- MODE 4: 7-TF Confluence Late-Window Strategy --------------
  // Entry window: 9-14.5 min in / 0.5-6 min left | mid: 0.70-0.96 | 3/7 TFs | $5 flat
  {
    const paused4 = state.mode4.pauseUntil && Date.now() < state.mode4.pauseUntil;
    if (paused4) {
      const minsLeft = ((state.mode4.pauseUntil - Date.now()) / 60000).toFixed(0);
      console.log(`\n  [M4] PAUSED -- ${minsLeft}min remaining`);
    } else {
      // Scan ALL markets in the late window (not just the nearest few)
      const lateCandidates = allMkts
        .map(m => {
          const { minutesIn, minutesLeft } = windowTiming(m.close_time);
          return { m, minutesIn, minutesLeft };
        })
        .filter(({ minutesIn, minutesLeft }) =>
          minutesIn >= MODE4_MIN_IN && minutesIn <= MODE4_MAX_IN &&
          minutesLeft >= MODE4_MIN_LEFT && minutesLeft <= MODE4_MAX_LEFT
        );

      if (lateCandidates.length === 0) {
        console.log(`\n  [M4] No markets in late window this scan`);
      }

      for (const { m, minutesIn, minutesLeft } of lateCandidates) {
        // One entry per contract — skip if already holding
        if (state.mode4.open.some(p => p.ticker === m.ticker)) continue;

        const sig = evalMode4(m, candlesByTf, minutesIn, minutesLeft);
        if (!sig.enter) {
          console.log(`  [M4] SKIP ${m.ticker.slice(-20)} -- ${sig.reason}`);
          continue;
        }

        const { bet } = getBetSize(state.mode4);
        const cost    = bet ?? MODE4_BET;
        const profit  = cost * (1 / sig.contractPx - 1);
        console.log(`\n  [M4] ENTER -- ${sig.reason}  win: +$${profit.toFixed(2)}`);

        const entered = await enterPosition(state.mode4, 'mode4', {
          ticker: m.ticker, side: sig.side, cost, contractPx: sig.contractPx,
          payout: cost / sig.contractPx,
          mode: 'Mode 4', confluenceScore: sig.confluenceScore, confluenceDir: sig.confluenceDir,
          btcPrice, strike: m.floor_strike, distance: btcPrice - m.floor_strike,
          rsi1m, close_time: m.close_time,
        });
        if (entered) {
          const tag = LIVE_MODE ? '[LIVE]' : '[PAPER]';
          console.log(`  [M4] >> ${tag} ${sig.side} @ ${(sig.contractPx*100).toFixed(0)}c  bet $${cost.toFixed(2)}  payout $${(cost/sig.contractPx).toFixed(2)}`);
        }
      }
    }
  }

  // -- Summary ----------------------------------------------
  console.log('\n  -- Stats ----------------------------------------------------------');
  for (const [mk, label] of [['mode1','Mode 1'],['mode2','Mode 2'],['mode3','Mode 3']]) {
    const s  = modeStats(state[mk]);
    const ms = state[mk];
    const bankStr  = mk !== 'mode3' ? `  bank $${ms.bankroll.toFixed(2)}` : '  (paper)';
    const flatBet  = MODE1_BET;
    const curBet   = ms.useReducedBet ? Math.max(MIN_BET, flatBet / 2) : flatBet;
    const pauseStr = ms.pauseUntil && Date.now() < ms.pauseUntil ? '  PAUSED' : ms.useReducedBet ? `  reduced $${curBet.toFixed(2)}` : '';
    const liveTag  = mk === 'mode1' ? ' [LIVE]' : mk === 'mode2' ? ' [paper]' : '';
    const betStr   = mk !== 'mode3' ? `  bet $${curBet.toFixed(2)}${liveTag}` : '';
    console.log(`  ${label}: ${s.wins}/${s.tot} (${s.wr.toFixed(0)}% WR)  P&L ${fmt$(s.pnl)}  streak: ${ms.lossStreak}L${bankStr}${betStr}${pauseStr}`);
  }

  // Mode 4 stats
  {
    const s4  = modeStats(state.mode4);
    const ms4 = state.mode4;
    const p4  = ms4.pauseUntil && Date.now() < ms4.pauseUntil ? '  PAUSED' : ms4.useReducedBet ? '  reduced' : '';
    const curBet = ms4.useReducedBet ? Math.max(MODE4_BET / 2, 2.50) : MODE4_BET;
    console.log(`  Mode 4: ${s4.wins}/${s4.tot} (${s4.wr.toFixed(0)}% WR)  P&L ${fmt$(s4.pnl)}  streak: ${ms4.lossStreak}L  bank $${ms4.bankroll.toFixed(2)}  bet $${curBet.toFixed(2)} [7-TF confluence]${p4}`);
  }

  saveState(state, 'tick');  // keeps local cache + (in CI) commits to GitHub
}

// -- Entry -----------------------------------------------------------------
if (LIVE_MODE) {
  console.log('\n*** Kalshi BTC 15-min Multi-Mode Bot  [LIVE TRADING] ***');
  console.log('  WARNING: Real orders will be placed on your Kalshi account.');
  console.log(`  Key ID: ${keyId}`);
} else {
  console.log('\nKalshi BTC 15-min Multi-Mode Bot  [PAPER MODE]');
  console.log('  No real orders will be placed. Pass --live to enable live trading.');
}
console.log(`  Bet: $${MODE1_BET} flat (M1/M2)  $${MODE4_BET} flat (M4)  |  Pause after ${PAUSE_LOSSES} losses for 3h`);
console.log(`  Scan every ${INTERVAL/1000}s  |  Ctrl+C to stop\n`);

// -- Resilient scan loop ------------------------------------------------------
// Wrap each tick in try/catch so a single bad scan (network blip, API change,
// JSON parse error) doesn't kill the entire 6-hour run.
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
