/**
 * test_paper.js — paper trading engine dry-run
 * Fetches live Kalshi BTC markets + Kraken BTC price,
 * runs the scoring algorithm, and shows exactly what
 * the dashboard would do this hour.
 *
 * Usage:
 *   node test_paper.js YOUR-API-KEY-ID
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const BASE     = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH = '/trade-api/v2';

const keyId = process.argv[2];
if (!keyId) { console.error('Usage: node test_paper.js YOUR-API-KEY-ID'); process.exit(1); }

const pem = fs.readFileSync(path.join(__dirname, 'kalshi_private_key.pem'), 'utf8');

// ── signing ──────────────────────────────────────────────────
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

function fetchBtc() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const key = Object.keys(j.result)[0];
          resolve(parseFloat(j.result[key].c[0]));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

// ── scoring (identical to dashboard JS) ──────────────────────
const MIN_SCORE      = 55;
const PAPER_START    = 50.00;
const PAPER_SIZE_PCT = 0.50;

function scoreMarket(mkt, btcPrice) {
  const strike    = mkt.floor_strike;
  if (!strike || !btcPrice) return null;
  const closeTime = new Date(mkt.close_time);
  const minsLeft  = (closeTime - Date.now()) / 60000;
  if (minsLeft < 5 || minsLeft > 58) return null;

  const distAbs = btcPrice - strike;
  const distPct = Math.abs(distAbs) / btcPrice * 100;
  const side    = distAbs >= 0 ? 'YES' : 'NO';

  const yesBid = parseFloat(mkt.yes_bid_dollars || '0');
  const yesAsk = parseFloat(mkt.yes_ask_dollars || '0');
  const noBid  = parseFloat(mkt.no_bid_dollars  || '0');
  const noAsk  = parseFloat(mkt.no_ask_dollars  || '0');
  const contractPx = side === 'YES' ? (yesBid + yesAsk) / 2 : (noBid + noAsk) / 2;

  if (contractPx < 0.65 || contractPx > 0.97) return null;

  let score = 0;
  if (distPct >= 0.05) score += 15;
  if (distPct >= 0.15) score += 15;
  if (distPct >= 0.35) score += 15;
  if (distPct >= 0.70) score += 10;
  if (minsLeft >= 10 && minsLeft <= 35)       score += 30;
  else if (minsLeft > 35 && minsLeft <= 50)   score += 15;
  else if (minsLeft >= 5  && minsLeft < 10)   score += 10;
  if (contractPx >= 0.78 && contractPx <= 0.94) score += 15;

  const pot_return = (1 - contractPx) / contractPx * 100;
  return { side, contractPx, minsLeft, distAbs, distPct, score, pot_return, strike };
}

// ── main ─────────────────────────────────────────────────────
(async () => {
  console.log('\n=== PAPER TRADING ENGINE DRY-RUN ===\n');

  const btcPrice = await fetchBtc().catch(() => null);
  if (!btcPrice) { console.error('Could not fetch BTC price'); process.exit(1); }
  console.log('BTC Price (Kraken):', '$' + Math.round(btcPrice).toLocaleString());

  // ── Discover BTC 15-min series ticker ────────────────────────
  console.log('\n--- Probing for BTC 15-min series ---');
  const candidateSeries = ['KXBTC', 'KXBTCT', 'KXBTCM', 'KXBTC15', 'BTCT', 'BTCM', 'BTCU', 'KXBTCU'];
  for (const s of candidateSeries) {
    const r = await get(`/events?series_ticker=${s}&status=open&limit=5`).catch(() => ({}));
    const evs = r.events || [];
    if (evs.length) {
      console.log(`  ✅ FOUND series=${s} — ${evs.length} events`);
      evs.slice(0,2).forEach(e => console.log('     event_ticker:', e.event_ticker, '| title:', (e.title||'').slice(0,60)));
    } else {
      console.log(`  ✗  ${s} — no events`);
    }
  }

  // ── Fetch open KXBTCD events, then markets per event ─────────
  console.log('\n--- Fetching open KXBTCD events ---');
  const eventsRaw = await get('/events?series_ticker=KXBTCD&status=open&limit=10');
  const events = eventsRaw.events || [];
  console.log('Events found:', events.length);
  events.forEach(e => console.log(' ', e.event_ticker));

  let allMkts = [];
  if (events.length) {
    const mktArrays = await Promise.all(
      events.map(ev => get(`/markets?event_ticker=${ev.event_ticker}&limit=200`).catch(() => ({})))
    );
    allMkts = mktArrays.flatMap(r => r.markets || []);
    console.log('\nTotal markets across all events:', allMkts.length);
    if (allMkts.length) allMkts.slice(0,5).forEach(m =>
      console.log(' ', m.ticker, '| YES', m.yes_bid_dollars, '/', m.yes_ask_dollars, '| strike $' + m.floor_strike));
  }

  let markets = allMkts.filter(m => Math.abs(btcPrice - (m.floor_strike||0)) <= 1000);
  console.log('\nAfter $1k range filter:', markets.length, 'markets');
  console.log('Active KXBTCD markets:', markets.length);

  if (!markets.length) {
    console.log('\n  No active BTC hourly markets right now.');
    console.log('  Kalshi creates them in the morning — check again between ~9am and 5pm EDT.\n');
    return;
  }

  console.log('\n── SCANNER RESULTS ───────────────────────────────────────');
  console.log('Market                           Strike      Dist     Left  YES    NO   Score  Action');
  console.log('─'.repeat(95));

  let bestMkt = null, bestSetup = null;

  for (const mkt of markets) {
    const setup    = scoreMarket(mkt, btcPrice);
    const closeT   = new Date(mkt.close_time);
    const minsLeft = ((closeT - Date.now()) / 60000).toFixed(0);
    const distAbs  = btcPrice - mkt.floor_strike;
    const distStr  = (distAbs >= 0 ? '+' : '') + '$' + Math.abs(distAbs).toFixed(0);
    const yesMid   = ((parseFloat(mkt.yes_bid_dollars||'0') + parseFloat(mkt.yes_ask_dollars||'0')) / 2 * 100).toFixed(0);
    const noMid    = ((parseFloat(mkt.no_bid_dollars||'0')  + parseFloat(mkt.no_ask_dollars||'0'))  / 2 * 100).toFixed(0);

    const ticker   = (mkt.ticker || '').padEnd(32);
    const strike   = ('$' + (mkt.floor_strike||0).toLocaleString()).padEnd(11);
    const dist     = distStr.padEnd(8);
    const left     = (minsLeft + 'm').padEnd(5);
    const yes      = (yesMid + '¢').padEnd(6);
    const no       = (noMid  + '¢').padEnd(5);

    if (!setup) {
      console.log(`${ticker} ${strike} ${dist} ${left} ${yes}  ${no}  —      SKIP (out of range)`);
    } else {
      const action = setup.score >= MIN_SCORE
        ? `>>> ENTER ${setup.side} @ ${(setup.contractPx*100).toFixed(0)}¢ (+${setup.pot_return.toFixed(0)}% if right)`
        : `skip (score too low)`;
      console.log(`${ticker} ${strike} ${dist} ${left} ${yes}  ${no}  ${String(setup.score).padEnd(5)}  ${action}`);
      if (setup.score >= MIN_SCORE && (!bestSetup || setup.score > bestSetup.score)) {
        bestMkt = mkt; bestSetup = setup;
      }
    }
  }

  console.log('\n── TRADE DECISION ────────────────────────────────────────');
  const bankroll = PAPER_START; // fresh bankroll for dry-run
  if (bestMkt && bestSetup) {
    const cost      = bankroll * PAPER_SIZE_PCT;
    const contracts = cost / bestSetup.contractPx;
    const payout    = contracts; // $1 per contract
    console.log(`  ✅ WOULD ENTER TRADE:`);
    console.log(`     Market   : ${bestMkt.ticker}`);
    console.log(`     Side     : ${bestSetup.side}`);
    console.log(`     Entry px : ${(bestSetup.contractPx*100).toFixed(0)}¢`);
    console.log(`     Contracts: ${contracts.toFixed(4)}`);
    console.log(`     Cost     : $${cost.toFixed(2)} (50% of $${bankroll.toFixed(2)} bankroll)`);
    console.log(`     Payout   : $${payout.toFixed(2)} if right`);
    console.log(`     Score    : ${bestSetup.score}/100`);
    console.log(`     Time left: ${bestSetup.minsLeft.toFixed(0)} minutes`);
    console.log(`     BTC dist : ${bestSetup.distAbs >= 0 ? '+' : ''}$${bestSetup.distAbs.toFixed(0)} from strike`);
  } else {
    console.log('  ⏭  SKIP this hour — no market meets the minimum score of', MIN_SCORE);
    console.log('     (Either no markets in window, contract price out of range, or score too low)');
  }
  console.log('');
})();
