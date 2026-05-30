/**
 * paper_bot.js — Continuous paper trading bot
 *
 * Every 30 seconds:
 *   1. Fetches BTC spot + 15-min trend from Kraken
 *   2. Scans all open KXBTCD markets
 *   3. Applies directional bias — favors YES in uptrends, NO in downtrends
 *   4. Enters best qualifying trade (score >= MIN_SCORE, direction aligned)
 *   5. Resolves expired positions, logs results
 *
 * Usage:
 *   node paper_bot.js YOUR-API-KEY-ID
 *   node paper_bot.js YOUR-API-KEY-ID --interval 60   (60-second scans)
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Config ──────────────────────────────────────────────────────
const MIN_SCORE      = 55;
const DIRECTION_BONUS = 12;   // added to score when trade aligns with trend
const DIRECTION_PEN   = 15;   // subtracted from score when trade fights trend
const PAPER_START    = 50.00;
const TRADE_SIZE_PCT = 0.50;  // 50% of current bankroll per trade
const MAX_POSITIONS  = 1;     // max concurrent open paper positions
const LOG_FILE       = path.join(__dirname, 'paper_trades.json');

// ── Parse args ──────────────────────────────────────────────────
const args   = process.argv.slice(2);
const keyId  = args.find(a => !a.startsWith('--'));
const intArg = args.indexOf('--interval');
const INTERVAL_SEC = intArg >= 0 ? parseInt(args[intArg + 1], 10) : 30;

if (!keyId) {
  console.error('Usage: node paper_bot.js YOUR-API-KEY-ID [--interval 30]');
  process.exit(1);
}

const BASE     = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH = '/trade-api/v2';
const pem      = fs.readFileSync(path.join(__dirname, 'kalshi_private_key.pem'), 'utf8');

// ── Signing ──────────────────────────────────────────────────────
function signHeaders(method, urlPath) {
  const ts  = Date.now().toString();
  const msg = ts + method.toUpperCase() + API_PATH + urlPath;
  const sign = crypto.createSign('SHA256');
  sign.update(msg);
  const sig = sign.sign(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN }, 'base64');
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts,
           'KALSHI-ACCESS-SIGNATURE': sig, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

function get(urlPath) {
  const headers = signHeaders('GET', urlPath);
  return new Promise((resolve, reject) => {
    const req = https.get(BASE + urlPath, { headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Kraken: spot price + 15-min OHLC ────────────────────────────
function fetchKraken() {
  return new Promise((resolve) => {
    const req = https.get('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=15&since=0', res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const key = Object.keys(j.result).find(k => k !== 'last');
          const candles = j.result[key]; // [time, open, high, low, close, vwap, volume, count]
          const last  = candles[candles.length - 1];
          const prev  = candles[candles.length - 2];
          const price = parseFloat(last[4]);     // last close
          const open15 = parseFloat(prev[1]);    // open of previous 15m candle
          const chg15  = (price - open15) / open15 * 100;
          resolve({ price, chg15, open15 });
        } catch(e) { resolve({ price: null, chg15: 0, open15: 0 }); }
      });
    });
    req.on('error', () => resolve({ price: null, chg15: 0, open15: 0 }));
  });
}

// ── Direction bias from 15-min trend ────────────────────────────
// Returns: 'BULL' | 'BEAR' | 'NEUTRAL'
function getDirectionBias(chg15) {
  if (chg15 >  0.05) return 'BULL';  // up > 0.05% in last 15m
  if (chg15 < -0.05) return 'BEAR';  // down > 0.05% in last 15m
  return 'NEUTRAL';
}

// ── Score a market ───────────────────────────────────────────────
function scoreMarket(mkt, btcPrice, bias) {
  const strike    = mkt.floor_strike;
  if (!strike || !btcPrice) return null;
  const closeTime = new Date(mkt.close_time);
  const minsLeft  = (closeTime - Date.now()) / 60000;
  if (minsLeft < 5 || minsLeft > 35) return null;  // sweet spot only

  const distAbs  = btcPrice - strike;
  const distPct  = Math.abs(distAbs) / btcPrice * 100;
  const side     = distAbs >= 0 ? 'YES' : 'NO';

  const yesBid    = parseFloat(mkt.yes_bid || mkt.yes_bid_dollars || '0');
  const yesAsk    = parseFloat(mkt.yes_ask || mkt.yes_ask_dollars || '0');
  const noBid     = parseFloat(mkt.no_bid  || mkt.no_bid_dollars  || '0');
  const noAsk     = parseFloat(mkt.no_ask  || mkt.no_ask_dollars  || '0');
  const contractPx = side === 'YES' ? (yesBid + yesAsk) / 2 : (noBid + noAsk) / 2;

  if (contractPx < 0.65 || contractPx > 0.97) return null;

  let score = 0;
  // Distance from strike
  if (distPct >= 0.05) score += 15;
  if (distPct >= 0.15) score += 15;
  if (distPct >= 0.35) score += 15;
  if (distPct >= 0.70) score += 10;
  // Timing sweet spot
  if (minsLeft >= 10 && minsLeft <= 35)      score += 30;
  else if (minsLeft >= 5 && minsLeft < 10)   score += 10;
  // Contract price zone (not too cheap, not too expensive)
  if (contractPx >= 0.78 && contractPx <= 0.94) score += 15;

  // Directional alignment bonus / penalty
  if (bias !== 'NEUTRAL') {
    const aligned = (bias === 'BULL' && side === 'YES') || (bias === 'BEAR' && side === 'NO');
    score += aligned ? DIRECTION_BONUS : -DIRECTION_PEN;
  }

  const pot_return = (1 - contractPx) / contractPx * 100;
  return { side, contractPx, minsLeft, distAbs, distPct, score, pot_return, strike,
           ticker: mkt.ticker, close_time: mkt.close_time };
}

// ── Persistence ──────────────────────────────────────────────────
function loadState() {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch(e) {
    return { bankroll: PAPER_START, trades: [], open: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(state, null, 2));
}

// ── Render helpers ───────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function pad(str, n) { return String(str).padEnd(n); }

function printHeader(btcPrice, chg15, bias, bankroll, openCount) {
  const arrow = bias === 'BULL' ? '▲' : bias === 'BEAR' ? '▼' : '─';
  const biasColor = bias === 'BULL' ? '\x1b[32m' : bias === 'BEAR' ? '\x1b[31m' : '\x1b[33m';
  const reset = '\x1b[0m';
  const chgStr = (chg15 >= 0 ? '+' : '') + chg15.toFixed(3) + '%';
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`  🕐 ${ts()}  │  BTC $${Math.round(btcPrice).toLocaleString()}  │  15m trend: ${biasColor}${arrow} ${chgStr} ${bias}${reset}  │  Bankroll: $${bankroll.toFixed(2)}  │  Open: ${openCount}/${MAX_POSITIONS}`);
  console.log(`${'═'.repeat(90)}`);
}

// ── Main loop ────────────────────────────────────────────────────
async function scan() {
  const state = loadState();

  // 1. Fetch BTC + trend
  const { price: btcPrice, chg15 } = await fetchKraken();
  if (!btcPrice) { console.log(`[${ts()}] ⚠ Could not fetch BTC price, skipping`); return; }
  const bias = getDirectionBias(chg15);

  // 2. Fetch all open KXBTCD markets via events
  const eventsRaw = await get('/events?series_ticker=KXBTCD&status=open&limit=10').catch(() => ({}));
  const events    = eventsRaw.events || [];
  if (!events.length) { console.log(`[${ts()}] No open KXBTCD events`); return; }

  const mktArrays = await Promise.all(
    events.map(ev => get(`/markets?event_ticker=${ev.event_ticker}&limit=200`).catch(() => ({})))
  );
  const allMkts = mktArrays.flatMap(r => r.markets || []);

  // Normalize field names (test uses _dollars suffix from API directly)
  const markets = allMkts.map(m => ({
    ...m,
    yes_bid: m.yes_bid_dollars ?? m.yes_bid ?? '0',
    yes_ask: m.yes_ask_dollars ?? m.yes_ask ?? '0',
    no_bid:  m.no_bid_dollars  ?? m.no_bid  ?? '0',
    no_ask:  m.no_ask_dollars  ?? m.no_ask  ?? '0',
  }));

  // 3. Resolve any expired open positions
  const now = Date.now();
  const stillOpen = [];
  for (const pos of state.open) {
    const closeAt = new Date(pos.close_time).getTime();
    if (now >= closeAt + 60000) { // 1 min grace after close
      // Fetch result from API
      const mktResp = await get('/markets/' + pos.ticker).catch(() => null);
      const mkt     = mktResp?.market;
      let won = null, pnl = 0;
      if (mkt?.status === 'determined') {
        won = mkt.result?.toLowerCase() === pos.side.toLowerCase();
        pnl = won ? pos.payout - pos.cost : -pos.cost;
        state.bankroll = Math.max(0, state.bankroll + (won ? pos.payout : 0));
        state.trades.push({ ...pos, resolved: true, won, pnl, resolved_at: new Date().toISOString() });
        const emoji = won ? '✅' : '❌';
        console.log(`\n  ${emoji} RESOLVED: ${pos.ticker} ${pos.side} — ${won ? 'WON' : 'LOST'} $${Math.abs(pnl).toFixed(2)} | Bankroll → $${state.bankroll.toFixed(2)}`);
      } else {
        // Not yet determined, keep waiting
        stillOpen.push(pos);
      }
    } else {
      stillOpen.push(pos);
    }
  }
  state.open = stillOpen;

  // 4. Print status
  printHeader(btcPrice, chg15, bias, state.bankroll, state.open.length);

  // 5. Score nearby markets
  const nearby = markets.filter(m => Math.abs(btcPrice - (m.floor_strike || 0)) <= 1000);
  const scored = nearby
    .map(m => ({ mkt: m, setup: scoreMarket(m, btcPrice, bias) }))
    .filter(x => x.setup !== null)
    .sort((a, b) => b.setup.score - a.setup.score);

  console.log(`  Markets in range: ${nearby.length}  |  Scorable (5-35 min): ${scored.length}`);

  if (scored.length) {
    console.log(`\n  ${pad('Market', 34)} ${pad('Strike', 11)} ${pad('Dist', 9)} ${pad('Left', 6)} ${pad('Side', 5)} ${pad('Px', 5)} ${pad('Score', 7)} Signal`);
    console.log(`  ${'─'.repeat(88)}`);
    for (const { mkt, setup } of scored.slice(0, 8)) {
      const distStr = (setup.distAbs >= 0 ? '+' : '') + '$' + Math.abs(setup.distAbs).toFixed(0);
      const aligned = (bias === 'BULL' && setup.side === 'YES') || (bias === 'BEAR' && setup.side === 'NO');
      const dirTag  = bias === 'NEUTRAL' ? '' : aligned ? ' ✓DIR' : ' ✗DIR';
      const signal  = setup.score >= MIN_SCORE
        ? `\x1b[32m>>> ENTER ${setup.side} @ ${(setup.contractPx*100).toFixed(0)}¢  +${setup.pot_return.toFixed(0)}%\x1b[0m`
        : `score < ${MIN_SCORE}`;
      console.log(`  ${pad(mkt.ticker, 34)} ${pad('$'+mkt.floor_strike.toLocaleString(), 11)} ${pad(distStr, 9)} ${pad(setup.minsLeft.toFixed(0)+'m', 6)} ${pad(setup.side, 5)} ${pad((setup.contractPx*100).toFixed(0)+'¢', 5)} ${pad(setup.score+dirTag, 10)} ${signal}`);
    }
  }

  // 6. Enter trade if slot open and best setup qualifies
  if (state.open.length < MAX_POSITIONS && scored.length > 0) {
    const best = scored[0];
    if (best.setup.score >= MIN_SCORE) {
      // Check not already in this market
      const alreadyIn = state.open.some(p => p.ticker === best.mkt.ticker);
      if (!alreadyIn) {
        const cost      = state.bankroll * TRADE_SIZE_PCT;
        const contracts = cost / best.setup.contractPx;
        const payout    = contracts; // $1 per contract
        const entry = {
          ticker    : best.mkt.ticker,
          side      : best.setup.side,
          cost      : parseFloat(cost.toFixed(4)),
          payout    : parseFloat(payout.toFixed(4)),
          contractPx: best.setup.contractPx,
          score     : best.setup.score,
          close_time: best.mkt.close_time,
          entered_at: new Date().toISOString(),
          bias,
        };
        state.open.push(entry);
        state.bankroll -= cost;  // commit cost
        console.log(`\n  📥 ENTERED: ${entry.ticker} ${entry.side} @ ${(entry.contractPx*100).toFixed(0)}¢`);
        console.log(`     Cost: $${cost.toFixed(2)} (${(TRADE_SIZE_PCT*100).toFixed(0)}% of bankroll)  |  Payout if right: $${payout.toFixed(2)}  |  Score: ${entry.score}  |  Bias: ${bias}`);
      }
    } else {
      console.log(`\n  ⏭  Best score ${best.setup.score} < ${MIN_SCORE} — no entry this scan`);
    }
  } else if (state.open.length >= MAX_POSITIONS) {
    const pos = state.open[0];
    const minsLeft = ((new Date(pos.close_time) - now) / 60000).toFixed(0);
    console.log(`\n  🔒 Position open: ${pos.ticker} ${pos.side} @ ${(pos.contractPx*100).toFixed(0)}¢  (${minsLeft}m to close)`);
  }

  // Show open positions
  if (state.open.length) {
    console.log(`\n  Open positions:`);
    for (const pos of state.open) {
      const minsLeft = Math.max(0, (new Date(pos.close_time) - now) / 60000).toFixed(0);
      const currentMkt = markets.find(m => m.ticker === pos.ticker);
      let currentPx = pos.contractPx;
      if (currentMkt) {
        const b = parseFloat(pos.side === 'YES' ? (currentMkt.yes_bid||'0') : (currentMkt.no_bid||'0'));
        const a = parseFloat(pos.side === 'YES' ? (currentMkt.yes_ask||'0') : (currentMkt.no_ask||'0'));
        currentPx = (b + a) / 2 || pos.contractPx;
      }
      const unrealized = (currentPx - pos.contractPx) * (pos.cost / pos.contractPx);
      const retPct     = (unrealized / pos.cost * 100).toFixed(1);
      const pnlStr     = (unrealized >= 0 ? '+' : '') + '$' + unrealized.toFixed(2) + ' (' + (unrealized >= 0 ? '+' : '') + retPct + '%)';
      console.log(`     ${pos.ticker} ${pos.side} @ ${(pos.contractPx*100).toFixed(0)}¢  →  now ${(currentPx*100).toFixed(0)}¢  |  ${pnlStr}  |  ${minsLeft}m left`);
    }
  }

  // Show recent trade history
  const recent = state.trades.slice(-5).reverse();
  if (recent.length) {
    console.log(`\n  Recent trades:`);
    for (const t of recent) {
      const emoji = t.won ? '✅' : '❌';
      console.log(`  ${emoji} ${t.ticker} ${t.side} @ ${(t.contractPx*100).toFixed(0)}¢  →  ${t.won ? 'WON' : 'LOST'} $${Math.abs(t.pnl).toFixed(2)}`);
    }
  }

  // Total stats
  const totalTrades = state.trades.length;
  const wins = state.trades.filter(t => t.won).length;
  const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
  if (totalTrades) {
    console.log(`\n  Stats: ${wins}/${totalTrades} wins (${(wins/totalTrades*100).toFixed(0)}%)  |  Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}  |  Bankroll: $${state.bankroll.toFixed(2)} (started $${PAPER_START})`);
  }

  saveState(state);
}

// ── Entry point ──────────────────────────────────────────────────
console.log(`\n🤖 Paper Bot started — scanning every ${INTERVAL_SEC}s | Min score: ${MIN_SCORE} | Size: ${TRADE_SIZE_PCT*100}% | Max positions: ${MAX_POSITIONS}`);
console.log(`   Direction bias: 15-min Kraken trend (BULL/BEAR/NEUTRAL)`);
console.log(`   Log file: ${LOG_FILE}`);
console.log(`   Press Ctrl+C to stop\n`);

scan();
setInterval(scan, INTERVAL_SEC * 1000);
