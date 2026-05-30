/**
 * test_kalshi.js — local diagnostic for Kalshi API
 * Reads keys from local files (not env vars) and prints raw API responses.
 *
 * Usage:
 *   node test_kalshi.js YOUR-API-KEY-ID-HERE
 *
 * Example:
 *   node test_kalshi.js xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const BASE     = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH = '/trade-api/v2';

// ---------- args ----------
const keyId = process.argv[2];
if (!keyId) {
  console.error('Usage: node test_kalshi.js YOUR-API-KEY-ID');
  process.exit(1);
}

// ---------- load PEM ----------
const pemPath = path.join(__dirname, 'kalshi_private_key.pem');
const pem     = fs.readFileSync(pemPath, 'utf8');
console.log('\n--- PEM first 60 chars (sanity check) ---');
console.log(pem.slice(0, 60));
console.log('--- PEM last 30 chars ---');
console.log(pem.slice(-30));

// ---------- signing ----------
function signHeaders(method, urlPath) {
  const ts  = Date.now().toString();
  const msg = ts + method.toUpperCase() + API_PATH + urlPath;
  const sign = crypto.createSign('SHA256');
  sign.update(msg);
  const sig = sign.sign(
    { key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_MAX_SIGN },
    'base64'
  );
  return {
    'KALSHI-ACCESS-KEY'       : keyId,
    'KALSHI-ACCESS-TIMESTAMP' : ts,
    'KALSHI-ACCESS-SIGNATURE' : sig,
    'Content-Type'            : 'application/json',
    'Accept'                  : 'application/json',
  };
}

function get(urlPath) {
  const headers = signHeaders('GET', urlPath);
  const url     = BASE + urlPath;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: {}, raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---------- same mapping logic as live.js ----------
async function mapPositions(rawPos) {
  const active = rawPos.filter(p => parseFloat(p.position_fp ?? p.position ?? '0') !== 0);

  // Fetch current market price for each position in parallel
  const markets = await Promise.all(
    active.map(p => get('/markets/' + p.ticker).catch(() => null))
  );

  return active.map((p, i) => {
    const qty      = parseFloat(p.position_fp ?? p.position ?? '0');
    const absQty   = Math.abs(qty);
    const side     = qty >= 0 ? 'YES' : 'NO';
    const cost     = parseFloat(p.total_traded_dollars ?? p.market_exposure_dollars ?? '0');
    const entryPx  = absQty > 0 ? cost / absQty : 0;

    // Log raw market response so we can see actual field names
    const mktBody = markets[i]?.body;
    console.log('\n  [DEBUG] raw market response for', p.ticker, ':');
    console.log(JSON.stringify(mktBody, null, 2));

    const mkt = mktBody?.market ?? mktBody;

    // Price fields use _dollars suffix and are already in USD (not cents)
    let currentPx = entryPx;
    let resolved  = false;
    if (mkt && mkt.status === 'determined' && mkt.result) {
      // Market resolved — use actual payout: $1 if you won, $0 if you lost
      const won = mkt.result.toLowerCase() === side.toLowerCase();
      currentPx = won ? 1.00 : 0.00;
      resolved  = true;
    } else if (mkt) {
      if (side === 'YES') {
        const bid = parseFloat(mkt.yes_bid_dollars ?? '0');
        const ask = parseFloat(mkt.yes_ask_dollars ?? mkt.yes_bid_dollars ?? '0');
        currentPx = (bid + ask) / 2;
      } else {
        const bid = parseFloat(mkt.no_bid_dollars ?? '0');
        const ask = parseFloat(mkt.no_ask_dollars ?? mkt.no_bid_dollars ?? '0');
        currentPx = (bid + ask) / 2;
      }
    }

    const subTitle = side === 'NO'
      ? (mkt?.no_sub_title ?? mkt?.subtitle ?? '')
      : (mkt?.yes_sub_title ?? mkt?.subtitle ?? '');
    const title = mkt?.title
      ? `${mkt.title} · ${side} · ${subTitle}`
      : p.ticker;

    const payout_if_right  = absQty * 1.00;   // each contract pays $1 if correct
    const market_value     = currentPx * absQty;
    const unrealized_pnl   = market_value - cost;
    const total_return_pct = cost > 0 ? (unrealized_pnl / cost * 100) : 0;

    return {
      ticker: p.ticker, side, title,
      quantity       : absQty,
      cost,
      market_exposure: parseFloat(p.market_exposure_dollars ?? '0'),
      realized_pnl   : parseFloat(p.realized_pnl_dollars ?? '0'),
      payout_if_right,
      market_value,
      unrealized_pnl,
      total_return_pct,
      _entry_px      : entryPx,
      _current_px    : currentPx,
    };
  });
}

// ---------- main ----------
(async () => {
  console.log('\n=== BALANCE ===');
  try {
    const bal = await get('/portfolio/balance');
    const cents = bal.body.balance ?? 0;
    console.log('Raw cents:', cents);
    console.log('Dashboard will show: $' + (cents / 100).toFixed(2));
  } catch(e) { console.error('ERROR:', e.message); }

  console.log('\n=== ACTIVE BTC HOURLY MARKETS ===');
  try {
    const mkts = await get('/markets?status=active&limit=100');
    const markets = (mkts.body.markets || []).filter(m => (m.ticker||'').startsWith('KXBTCD'));
    console.log('Count:', markets.length);
    markets.forEach(m => {
      const yesMid  = ((parseFloat(m.yes_bid_dollars||'0') + parseFloat(m.yes_ask_dollars||'0')) / 2 * 100).toFixed(0);
      const noMid   = ((parseFloat(m.no_bid_dollars||'0')  + parseFloat(m.no_ask_dollars||'0'))  / 2 * 100).toFixed(0);
      const minsLeft = ((new Date(m.close_time) - Date.now()) / 60000).toFixed(0);
      console.log(`  ${m.ticker} | $${m.floor_strike} | YES ${yesMid}¢  NO ${noMid}¢ | ${minsLeft}m left`);
    });
  } catch(e) { console.error('Markets ERROR:', e.message); }

  console.log('\n=== POSITIONS (raw) ===');
  try {
    const pos = await get('/portfolio/positions');
    const rawPos = pos.body.market_positions || pos.body.positions || [];
    console.log('Raw market_positions count:', rawPos.length);

    console.log('\n=== POSITIONS (mapped — what dashboard will show) ===');
    const mapped = await mapPositions(rawPos);
    if (!mapped.length) {
      console.log('No open positions after mapping.');
    } else {
      mapped.forEach((p, i) => {
        console.log(`\nPosition ${i + 1}:`);
        console.log('  Title:         ', p.title);
        console.log('  Ticker:        ', p.ticker);
        console.log('  Side:          ', p.side);
        console.log('  Qty:           ', p.quantity);
        console.log('  Cost:          $' + p.cost.toFixed(4));
        console.log('  Payout if right:$' + p.payout_if_right.toFixed(2));
        console.log('  Market value:  $' + p.market_value.toFixed(4));
        console.log('  Unrealized P&L:$' + p.unrealized_pnl.toFixed(4));
        console.log('  Total return:  ' + p.total_return_pct.toFixed(1) + '%');
        console.log('  Entry px:      $' + p._entry_px.toFixed(4), '/ contract');
        console.log('  Current px:    $' + p._current_px.toFixed(4), '/ contract');
      });
    }
  } catch(e) { console.error('ERROR:', e.message); }
})();
