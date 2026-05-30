/**
 * mode4_backtest.js — Quick backtest for Mode 4 (7-TF Confluence Late-Window)
 *
 * Fetches last N days of Binance 1m candles, simulates 15-min Kalshi-style
 * contract windows, and applies the Mode 4 strategy at each window.
 */

const https = require('https');

const DAYS = 5;
const BET  = 5.00;
const MID_LO = 0.70;
const MID_HI = 0.96;
const MIN_IN = 9;
const MAX_IN = 14.5;
const MIN_LEFT = 0.5;
const MAX_LEFT = 6;
const MIN_CONFLUENCE = 3;

function binanceGet(urlPath) {
  return new Promise(resolve => {
    const req = https.get('https://data-api.binance.vision' + urlPath, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchKlines(interval, startMs, endMs) {
  const all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const data = await binanceGet(url);
    if (!Array.isArray(data) || !data.length) break;
    for (const k of data) {
      all.push({ openTime: k[0], closeTime: k[6], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
    cursor = data[data.length - 1][6] + 1;
    await new Promise(r => setTimeout(r, 100));
  }
  return all;
}

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

function tfTrend(candles) {
  if (!Array.isArray(candles) || candles.length < 5) return null;
  const closes = candles.map(c => c.close);
  const r = rsi(closes);
  const n = closes.length;
  const slopeUp = closes[n-1] > closes[n-2] && closes[n-2] > closes[n-3];
  const slopeDn = closes[n-1] < closes[n-2] && closes[n-2] < closes[n-3];
  const bull = (r && r > 55 ? 1 : 0) + (slopeUp ? 1 : 0);
  const bear = (r && r < 45 ? 1 : 0) + (slopeDn ? 1 : 0);
  if (bull >= 2 || (bull === 1 && bear === 0)) return 'UP';
  if (bear >= 2 || (bear === 1 && bull === 0)) return 'DOWN';
  return null;
}

function calcConfluence(candlesByTf) {
  const TFS = ['1m','3m','5m','15m','30m','1h','4h'];
  const signals = TFS.map(tf => tfTrend(candlesByTf[tf]));
  const up = signals.filter(s => s === 'UP').length;
  const dn = signals.filter(s => s === 'DOWN').length;
  const breakdown = {};
  TFS.forEach((tf, i) => { breakdown[tf] = signals[i]; });
  if (up > dn && up >= MIN_CONFLUENCE) return { dir: 'UP', score: up, breakdown };
  if (dn > up && dn >= MIN_CONFLUENCE) return { dir: 'DOWN', score: dn, breakdown };
  return { dir: null, score: Math.max(up, dn), breakdown };
}

function resampleCandles(candles1m, intervalMin) {
  const result = [];
  for (let i = 0; i + intervalMin <= candles1m.length; i += intervalMin) {
    const chunk = candles1m.slice(i, i + intervalMin);
    result.push({
      openTime: chunk[0].openTime,
      closeTime: chunk[chunk.length - 1].closeTime,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

function getCandlesUpTo(allCandles, beforeTime, count) {
  const filtered = allCandles.filter(c => c.closeTime <= beforeTime);
  return filtered.slice(-count);
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;
  const lookbackMs = 30 * 24 * 60 * 60 * 1000; // extra lookback for higher TF RSI

  console.log(`Fetching ${DAYS} days of Binance 1m data (+ lookback for RSI)...`);
  const candles1m = await fetchKlines('1m', startMs - lookbackMs, endMs);
  console.log(`  Got ${candles1m.length} 1m candles`);

  if (candles1m.length < 1000) {
    console.log('Not enough data'); return;
  }

  // Pre-compute higher TF candles from 1m
  const candles3m  = resampleCandles(candles1m, 3);
  const candles5m  = resampleCandles(candles1m, 5);
  const candles15m = resampleCandles(candles1m, 15);
  const candles30m = resampleCandles(candles1m, 30);
  const candles1h  = resampleCandles(candles1m, 60);
  const candles4h  = resampleCandles(candles1m, 240);

  // Simulate 15-min contract windows over the test period
  // Kalshi BTC contracts close every 15 min on the quarter-hour
  const windowMs = 15 * 60 * 1000;
  const firstWindow = Math.ceil(startMs / windowMs) * windowMs;

  const trades = [];
  let bankroll = 50;
  let lossStreak = 0;

  for (let closeTime = firstWindow; closeTime < endMs; closeTime += windowMs) {
    const openTime = closeTime - windowMs;

    // Get the 1m candles within this window
    const windowCandles = candles1m.filter(c => c.openTime >= openTime && c.openTime < closeTime);
    if (windowCandles.length < 14) continue;

    // Strike = rounded BTC price at window open (nearest $100)
    const btcAtOpen = windowCandles[0].open;
    const strike = Math.round(btcAtOpen / 100) * 100;

    // Check at each minute from MIN_IN to MAX_IN
    for (let checkMin = Math.ceil(MIN_IN); checkMin <= Math.floor(MAX_IN); checkMin++) {
      const minutesIn = checkMin;
      const minutesLeft = 15 - minutesIn;
      if (minutesLeft < MIN_LEFT || minutesLeft > MAX_LEFT) continue;

      // Get candle data available at this point in time
      const checkTime = openTime + checkMin * 60 * 1000;

      const tf1m  = getCandlesUpTo(candles1m,  checkTime, 60);
      const tf3m  = getCandlesUpTo(candles3m,  checkTime, 30);
      const tf5m  = getCandlesUpTo(candles5m,  checkTime, 35);
      const tf15m = getCandlesUpTo(candles15m, checkTime, 25);
      const tf30m = getCandlesUpTo(candles30m, checkTime, 25);
      const tf1h  = getCandlesUpTo(candles1h,  checkTime, 25);
      const tf4h  = getCandlesUpTo(candles4h,  checkTime, 20);

      const candlesByTf = { '1m': tf1m, '3m': tf3m, '5m': tf5m, '15m': tf15m, '30m': tf30m, '1h': tf1h, '4h': tf4h };
      const { dir, score } = calcConfluence(candlesByTf);
      if (!dir || score < MIN_CONFLUENCE) continue;

      // Simulate entry price based on distance from strike
      const btcNow = tf1m.length ? tf1m[tf1m.length - 1].close : null;
      if (!btcNow) continue;
      const dist = btcNow - strike;

      // Approximate mid price: closer to strike = ~50c, further away = higher/lower
      const absDist = Math.abs(dist);
      let yesMid, noMid;
      if (dist > 0) {
        yesMid = Math.min(0.97, 0.50 + absDist / 800);
        noMid = 1 - yesMid;
      } else {
        noMid = Math.min(0.97, 0.50 + absDist / 800);
        yesMid = 1 - noMid;
      }

      const yesOk = yesMid >= MID_LO && yesMid <= MID_HI;
      const noOk  = noMid  >= MID_LO && noMid  <= MID_HI;

      let side, contractPx;
      if      (dir === 'UP'   && yesOk) { side = 'YES'; contractPx = yesMid; }
      else if (dir === 'DOWN' && noOk)  { side = 'NO';  contractPx = noMid;  }
      else continue;

      // Resolution: average of last 5 1m closes before window end
      const resolveCandles = candles1m.filter(c => c.openTime >= closeTime - 5 * 60 * 1000 && c.openTime < closeTime);
      if (resolveCandles.length < 3) continue;
      const resolvePrice = resolveCandles.reduce((s, c) => s + c.close, 0) / resolveCandles.length;
      const won = side === 'YES' ? resolvePrice > strike : resolvePrice < strike;

      const payout = BET / contractPx;
      const pnl = won ? (payout - BET) : -BET;
      bankroll += pnl;

      if (won) { lossStreak = 0; } else { lossStreak++; }

      trades.push({
        time: new Date(checkTime).toISOString(),
        strike, btcNow: Math.round(btcNow), resolvePrice: Math.round(resolvePrice),
        side, contractPx: +(contractPx.toFixed(3)), dir, score,
        won, pnl: +pnl.toFixed(2), bankroll: +bankroll.toFixed(2),
      });

      break; // one entry per window
    }
  }

  // Results
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  MODE 4 BACKTEST — Last ${DAYS} days  |  $${BET} flat bet`);
  console.log(`  Window: ${MIN_IN}-${MAX_IN}min in  |  Mid: ${MID_LO*100}-${MID_HI*100}c  |  Confluence: ${MIN_CONFLUENCE}/7 TFs`);
  console.log(`${'═'.repeat(70)}\n`);

  const wins = trades.filter(t => t.won).length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wr = trades.length ? (wins / trades.length * 100) : 0;
  const maxDD = trades.reduce((dd, t) => { dd.cur += t.pnl; dd.max = Math.min(dd.max, dd.cur); return dd; }, { cur: 0, max: 0 }).max;

  console.log(`  Trades:    ${trades.length}`);
  console.log(`  Wins:      ${wins}  |  Losses: ${losses}  |  Win Rate: ${wr.toFixed(1)}%`);
  console.log(`  Total PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(`  Max DD:    $${maxDD.toFixed(2)}`);
  console.log(`  Final bank: $${bankroll.toFixed(2)} (started $50)`);
  console.log('');

  // Per-day breakdown
  const byDay = {};
  for (const t of trades) {
    const day = t.time.slice(0, 10);
    if (!byDay[day]) byDay[day] = { trades: 0, wins: 0, pnl: 0 };
    byDay[day].trades++;
    if (t.won) byDay[day].wins++;
    byDay[day].pnl += t.pnl;
  }
  console.log('  Day          Trades  W/L     WR      PnL');
  console.log('  ' + '─'.repeat(50));
  for (const [day, d] of Object.entries(byDay).sort()) {
    const dayWr = (d.wins / d.trades * 100).toFixed(0);
    const pnlStr = (d.pnl >= 0 ? '+' : '') + '$' + d.pnl.toFixed(2);
    console.log(`  ${day}    ${String(d.trades).padStart(3)}     ${d.wins}/${d.trades - d.wins}     ${dayWr.padStart(3)}%    ${pnlStr}`);
  }

  // Show last 10 trades
  console.log(`\n  Last 10 trades:`);
  console.log('  Time                Side  Px     Dir   Score  Strike    BTC      Result   PnL      Bank');
  console.log('  ' + '─'.repeat(90));
  for (const t of trades.slice(-10)) {
    const timeStr = t.time.slice(5, 16).replace('T', ' ');
    const result = t.won ? 'WIN ' : 'LOSS';
    const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
    console.log(`  ${timeStr}  ${t.side.padEnd(4)}  ${(t.contractPx*100).toFixed(0)}c    ${t.dir.padEnd(5)} ${t.score}/7    $${t.strike}   $${t.btcNow}   ${result}    ${pnlStr.padStart(7)}   $${t.bankroll.toFixed(2)}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
