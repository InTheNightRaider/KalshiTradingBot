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
// Signal-counter skips burned through in seconds (10 markets × 2 skips
// = consumed in one scan cycle), so we switched to wall-clock cooldown.
const LOSS_COOLDOWN_MS = 30 * 60 * 1000;
// 2x on first trade after a loss cooldown expires — one shot to recover.
// After 2+ consecutive losses: flat $5 (no chasing a deep hole).
const RECOVERY_MULTI = 2;

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
    modeState.lossStreak    = 0;
    modeState.recoveryMulti = 1;
    modeState.cooldownUntilMs = 0;
  } else {
    const streak = (modeState.lossStreak || 0) + 1;
    modeState.lossStreak      = streak;
    modeState.cooldownUntilMs = Date.now() + LOSS_COOLDOWN_MS;
    // 2x recovery on first trade after cooldown; flat after 2+ losses
    modeState.recoveryMulti   = streak >= 2 ? 1 : RECOVERY_MULTI;
    const minsLabel = (LOSS_COOLDOWN_MS / 60000).toFixed(0);
    const betLabel  = modeState.recoveryMulti > 1 ? `, then $${(MODE4A_BET * modeState.recoveryMulti).toFixed(0)} recovery bet` : ', flat $5 (2+ losses)';
    console.log(`  [${modeKey.toUpperCase()}] Loss streak ${streak} — cooling down ${minsLabel}min${betLabel}`);
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

    modeState.bankroll = parseFloat(Math.max(0, modeState.bankroll + pnl).toFixed(4));

    updateStreak(modeState, won, modeKey);
    modeState.trades.push({ ...pos, resolved: true, won, pnl, resolved_at: new Date().toISOString() });

    sb.resolvePosition(pos.sb_id, won, pnl, pos.priceTicks)
      .catch(e => console.log('  !! sb.resolvePosition: ' + e.message));
    if (_scanState) {
      sb.insertBotState(_scanState, 'resolution', modeKey, _scanBtc, _scanR1)
        .catch(e => console.log('  !! sb.insertBotState: ' + e.message));
    }

    const icon = won ? '✅' : '❌';
    console.log(`  ${icon} [${modeKey.toUpperCase()}] ${pos.ticker} ${pos.side} @ ${(pos.contractPx*100).toFixed(0)}¢ → ${won?'WIN':'LOSS'} ${fmt$(pnl)}  streak: ${modeState.lossStreak}L`);

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

  // ── Intra-trade tick logging for open Mode 4a positions ──────
  {
    const mktMap = {};
    for (const m of allMkts) mktMap[m.ticker] = m;
    let tickCount = 0;
    for (const pos of (state.mode4a.open || [])) {
      const m = mktMap[pos.ticker];
      if (!m) continue;
      const { minutesLeft } = windowTiming(m.close_time);
      if (!pos.priceTicks) pos.priceTicks = [];
      pos.priceTicks.push({
        ts:          new Date().toISOString(),
        btcPrice:    parseFloat(btcPrice.toFixed(2)),
        yesMid:      parseFloat(midPrice(m.yes_bid, m.yes_ask).toFixed(4)),
        noMid:       parseFloat(midPrice(m.no_bid,  m.no_ask).toFixed(4)),
        rsi1m:       rsi1m ? parseFloat(rsi1m.toFixed(1)) : null,
        minutesLeft: parseFloat(minutesLeft.toFixed(2)),
      });
      tickCount++;
    }
    if (tickCount > 0) console.log(`  📈 Tick logged for ${tickCount} open position(s)`);
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

        const multi = ms.recoveryMulti || 1;
        const cost  = MODE4A_BET * multi;
        if (ms.bankroll < cost) {
          console.log(`  [M4a] SKIP -- bankroll $${ms.bankroll.toFixed(2)} < bet $${cost.toFixed(2)}`);
          continue;
        }

        const profit = cost * (1 / sig.contractPx - 1);
        const multiTag = multi > 1 ? ` [${multi}x RECOVERY]` : '';
        console.log(`\n  [M4a] ENTER -- ${sig.reason}  win: +$${profit.toFixed(2)}${multiTag}`);

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
  const multi = ms.recoveryMulti || 1;
  const curBet = MODE4A_BET * multi;
  const skipStr = ms.skipSignals > 0 ? `  SKIP ${ms.skipSignals}` : '';
  const multiStr = multi > 1 ? ` [${multi}x]` : '';
  console.log('\n  -- Stats ----------------------------------------------------------');
  console.log(`  Mode 4a: ${s.wins}/${s.tot} (${s.wr.toFixed(0)}% WR)  P&L ${fmt$(s.pnl)}  streak: ${ms.lossStreak}L  bank $${ms.bankroll.toFixed(2)}  bet $${curBet.toFixed(2)}${multiStr}  ${LIVE_MODE ? 'LIVE' : 'PAPER'}${skipStr}`);

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
console.log(`  Bet: $${MODE4A_BET}  Mid: ${MODE4A_MID_LO*100}-${MODE4A_MID_HI*100}¢  Confluence: ${MODE4A_CONFLUENCE}/7  |  Loss cooldown: 30min  |  Recovery: ${RECOVERY_MULTI}x (flat after 2L)`);
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
