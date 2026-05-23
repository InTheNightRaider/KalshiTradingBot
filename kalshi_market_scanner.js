/**
 * kalshi_market_scanner.js - BTC Contract Tick Data Collector
 *
 * Runs independently from the trading bot.
 * Every 60 seconds:
 *   1. Fetches BTC price + RSI from Binance
 *   2. Fetches ALL open KXBTCD markets from Kalshi
 *   3. Ranks top 100 by: score = volume * (1 / (1 + absDist / 200))
 *   4. Captures full snapshot: prices, odds, timing, RSI
 *   5. Appends one JSON line to dashboard/market_ticks.jsonl (LOCAL ONLY)
 *   6. Injects priceTicks into open positions in btc_paper_state.json
 *
 * Usage:
 *   node kalshi_market_scanner.js YOUR-API-KEY-ID
 *   node kalshi_market_scanner.js YOUR-API-KEY-ID --interval 60
 *
 * Output file format (one JSON line per scan):
 * {
 *   "ts": "2026-05-21T11:00:00.000Z",
 *   "btcPrice": 77234,
 *   "rsi1m": 43.2,
 *   "rsi5m": 26.1,
 *   "contracts": [
 *     {
 *       "ticker": "KXBTCD-26MAY2108-T77199.99",
 *       "strike": 77199.99,
 *       "dist": 34, "absDist": 34,
 *       "yesBid": 0.41, "yesAsk": 0.45, "yesMid": 0.43,
 *       "noBid": 0.54, "noAsk": 0.58, "noMid": 0.56,
 *       "volume": 1200, "openInterest": 500,
 *       "minutesLeft": 57.5, "minutesIn": 2.5,
 *       "score": 847.3,
 *       "close_time": "2026-05-21T12:00:00Z"
 *     }
 *   ]
 * }
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sb     = require('./supabase_client');

// --- Config ------------------------------------------------------------------
const SCAN_INTERVAL_MS = 60 * 1000;
const TOP_N            = 100;
const RANK_DIST_SCALE  = 200;
const STATE_FILE       = path.join(__dirname, 'dashboard', 'btc_paper_state.json');
const KEY_FILE         = path.join(__dirname, 'kalshi_private_key.pem');
const BASE             = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH         = '/trade-api/v2';

// --- Parse args --------------------------------------------------------------
const args     = process.argv.slice(2);
const keyId    = args.find(function(a) { return !a.startsWith('--'); });
const intArg   = args.indexOf('--interval');
const INTERVAL = intArg >= 0 ? parseInt(args[intArg + 1], 10) * 1000 : SCAN_INTERVAL_MS;

if (!keyId) {
  console.error('Usage: node kalshi_market_scanner.js YOUR-API-KEY-ID [--interval 60]');
  process.exit(1);
}

// --- Load PEM ----------------------------------------------------------------
var pem;
try {
  pem = fs.readFileSync(KEY_FILE, 'utf8');
} catch (e) {
  console.error('Could not read ' + KEY_FILE + ': ' + e.message);
  process.exit(1);
}

// --- Helpers -----------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }
function timeStr() { return new Date().toLocaleTimeString('en-US', { hour12: false }); }

function midPrice(bid, ask) {
  var b = parseFloat(bid || 0);
  var a = parseFloat(ask || 0);
  if (!b && !a) return null;
  if (!b) return a;
  if (!a) return b;
  return parseFloat(((b + a) / 2).toFixed(4));
}

// --- Kalshi signing ----------------------------------------------------------
function signHeaders(method, urlPath) {
  var timestamp = Date.now().toString();
  var msg = timestamp + method.toUpperCase() + API_PATH + urlPath;
  var sign = crypto.createSign('SHA256');
  sign.update(msg);
  var sig = sign.sign(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN },
    'base64'
  );
  return {
    'KALSHI-ACCESS-KEY':       keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'Content-Type':  'application/json',
    'Accept':        'application/json'
  };
}

function kalshiGet(urlPath) {
  var headers = signHeaders('GET', urlPath);
  return new Promise(function(resolve, reject) {
    var req = https.get(BASE + urlPath, { headers: headers }, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, function() { req.destroy(); reject(new Error('timeout')); });
  });
}

// --- Binance -----------------------------------------------------------------
function binanceGet(urlPath) {
  return new Promise(function(resolve) {
    var req = https.get('https://data-api.binance.vision' + urlPath, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(raw)); } catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(10000, function() { req.destroy(); resolve(null); });
  });
}

function fetchBtcPrice() {
  return binanceGet('/api/v3/ticker/price?symbol=BTCUSDT').then(function(data) {
    return data ? parseFloat(data.price) : null;
  });
}

function fetchKlines(interval, limit) {
  return binanceGet('/api/v3/klines?symbol=BTCUSDT&interval=' + interval + '&limit=' + (limit || 100))
    .then(function(data) {
      if (!Array.isArray(data)) return [];
      return data.map(function(k) {
        return {
          open: parseFloat(k[1]), high: parseFloat(k[2]),
          low:  parseFloat(k[3]), close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        };
      });
    });
}

// --- RSI (Wilder's smoothed) -------------------------------------------------
function calcRsi(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return null;
  var gain = 0, loss = 0, i, d;
  for (i = 1; i <= period; i++) {
    d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  var avgG = gain / period, avgL = loss / period;
  for (i = period + 1; i < closes.length; i++) {
    d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

// --- Contract timing ---------------------------------------------------------
function windowTiming(closeTime) {
  var nowMs   = Date.now();
  var closeMs = new Date(closeTime).getTime();
  var left    = (closeMs - nowMs) / 60000;
  var into    = Math.max(0, 15 - left);
  return {
    minutesLeft: parseFloat(Math.max(0, left).toFixed(2)),
    minutesIn:   parseFloat(Math.max(0, into).toFixed(2))
  };
}

// --- Ranking score -----------------------------------------------------------
function rankScore(volume, absDist) {
  var vol = volume || 0;
  var proxFactor = 1 / (1 + absDist / RANK_DIST_SCALE);
  return parseFloat((vol * proxFactor).toFixed(2));
}

// --- State I/O (inject priceTicks into open trading bot positions) -----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch(e) { return null; }
}

function saveState(state) {
  state.lastUpdate = nowIso();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function injectPriceTicks(state, allMkts, btcPrice, rsi1m) {
  if (!state) return false;
  var changed = false;
  var modes = ['mode1', 'mode2', 'mode3', 'mode4'];
  var mktMap = {};
  allMkts.forEach(function(m) { mktMap[m.ticker] = m; });

  modes.forEach(function(mk) {
    var ms = state[mk];
    if (!ms || !Array.isArray(ms.open)) return;
    ms.open.forEach(function(pos) {
      var mkt = mktMap[pos.ticker];
      if (!mkt) return;
      var timing = windowTiming(mkt.close_time);
      var yMid = midPrice(mkt.yes_bid, mkt.yes_ask);
      var nMid = midPrice(mkt.no_bid,  mkt.no_ask);
      if (!pos.priceTicks) pos.priceTicks = [];
      pos.priceTicks.push({
        ts:          nowIso(),
        btcPrice:    parseFloat(btcPrice.toFixed(2)),
        yesMid:      yMid,
        noMid:       nMid,
        rsi1m:       rsi1m,
        minutesLeft: timing.minutesLeft
      });
      changed = true;
    });
  });
  return changed;
}

// --- Main scan ---------------------------------------------------------------
var scanCount = 0;

function scan() {
  scanCount++;
  var thisScan = scanCount;
  console.log('\n--- Scanner | ' + timeStr() + ' | Scan #' + thisScan + ' ---');

  // 1. Binance data
  Promise.all([
    fetchBtcPrice(),
    fetchKlines('1m', 60),
    fetchKlines('5m', 35)
  ]).then(function(results) {
    var btcPrice  = results[0];
    var candles1m = results[1];
    var candles5m = results[2];
    var rsi1m     = candles1m.length ? calcRsi(candles1m.map(function(c) { return c.close; })) : null;
    var rsi5m     = candles5m.length ? calcRsi(candles5m.map(function(c) { return c.close; })) : null;

    if (!btcPrice) {
      console.log('  !! No BTC price - skipping');
      return;
    }
    console.log('  BTC $' + Math.round(btcPrice).toLocaleString() + '  |  RSI 1m: ' + (rsi1m || '--') + '  RSI 5m: ' + (rsi5m || '--'));

    // 2. Fetch all open KXBTCD markets
    return kalshiGet('/events?series_ticker=KXBTCD&status=open&limit=50')
      .then(function(eventsRaw) {
        var events = eventsRaw.events || [];
        console.log('  Fetching markets for ' + events.length + ' open events...');
        return Promise.all(
          events.map(function(ev) {
            return kalshiGet('/markets?event_ticker=' + ev.event_ticker + '&limit=200').catch(function() { return {}; });
          })
        ).then(function(mktArrays) {
          // Normalize field names - Kalshi uses *_dollars and *_fp suffixes
          var allMkts = mktArrays.reduce(function(acc, r) {
            return acc.concat(r.markets || []);
          }, []).map(function(m) {
            return Object.assign({}, m, {
              yes_bid: parseFloat(m.yes_bid_dollars || m.yes_bid || 0),
              yes_ask: parseFloat(m.yes_ask_dollars || m.yes_ask || 0),
              no_bid:  parseFloat(m.no_bid_dollars  || m.no_bid  || 0),
              no_ask:  parseFloat(m.no_ask_dollars  || m.no_ask  || 0),
              volume:  parseFloat(m.volume_fp || m.volume || 0),
              open_interest: parseFloat(m.open_interest_fp || m.open_interest || 0),
              last_price: parseFloat(m.last_price_dollars || m.last_price || 0)
            });
          });

          console.log('  Total open markets: ' + allMkts.length);

          // 3. Score and rank top N
          var scored = allMkts
            .filter(function(m) { return m.floor_strike != null && m.close_time; })
            .map(function(m) {
              var absDist = Math.abs(btcPrice - m.floor_strike);
              var timing  = windowTiming(m.close_time);
              var score   = rankScore(m.volume, absDist);
              return {
                ticker:       m.ticker,
                strike:       m.floor_strike,
                dist:         parseFloat((btcPrice - m.floor_strike).toFixed(2)),
                absDist:      parseFloat(absDist.toFixed(2)),
                yesBid:       m.yes_bid,
                yesAsk:       m.yes_ask,
                yesMid:       midPrice(m.yes_bid, m.yes_ask),
                noBid:        m.no_bid,
                noAsk:        m.no_ask,
                noMid:        midPrice(m.no_bid, m.no_ask),
                volume:       m.volume,
                openInterest: m.open_interest,
                lastPrice:    m.last_price,
                minutesLeft:  timing.minutesLeft,
                minutesIn:    timing.minutesIn,
                score:        score,
                close_time:   m.close_time
              };
            })
            .sort(function(a, b) { return b.score - a.score; })
            .slice(0, TOP_N);

          console.log('  Top ' + scored.length + ' contracts ranked (score = volume * proximity)');
          if (scored.length > 0) {
            var top = scored.slice(0, 3).map(function(c) {
              return c.ticker + ' (score ' + c.score + ', dist ' + (c.dist >= 0 ? '+' : '') + c.dist + ', vol ' + c.volume + ')';
            });
            console.log('  Top 3: ' + top.join(' | '));
          }

          // 4. Write to Supabase (market_scans + contract_ticks)
          var record = {
            ts:                    nowIso(),
            scanNum:               thisScan,
            btcPrice:              parseFloat(btcPrice.toFixed(2)),
            rsi1m:                 rsi1m,
            rsi5m:                 rsi5m,
            totalMarketsAvailable: allMkts.length,
            contracts:             scored
          };
          sb.insertScan(record, scored).then(function(scanId) {
            console.log('  Saved top 20 of ' + scored.length + ' contracts -> Supabase (scan id ' + scanId + ')');
          }).catch(function(e) {
            console.log('  !! Supabase write failed: ' + e.message);
          });

          // 5. Inject priceTicks into open trading bot positions
          try {
            var state   = loadState();
            var changed = injectPriceTicks(state, allMkts, btcPrice, rsi1m);
            if (changed) {
              saveState(state);
              console.log('  Injected price ticks into open positions');
            } else {
              console.log('  No open positions to tick');
            }
          } catch(e) {
            console.log('  !! Tick inject error: ' + e.message);
          }

        });
      });
  }).catch(function(e) {
    console.log('  !! Scan error: ' + e.message);
  });
}

// --- Startup -----------------------------------------------------------------
console.log('\n=== Kalshi Market Scanner | Top 100 BTC Contracts | 60s tick data ===');
console.log('  Output:   Supabase → market_scans + contract_ticks (top 20 per scan)');
console.log('  Interval: ' + (INTERVAL / 1000) + 's');
console.log('  Ranking:  score = volume * (1 / (1 + absDist/' + RANK_DIST_SCALE + '))');
console.log('  Press Ctrl+C to stop\n');

scan();
setInterval(scan, INTERVAL);
