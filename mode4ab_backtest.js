/**
 * mode4ab_backtest.js — Backtest for Mode 4a + 4b on 15-min windows
 *
 * Simulates KXBTC15M-style contracts: strike = BTC price at window open,
 * YES = BTC above strike at close.  Tests multiple confluence thresholds.
 */

const https = require('https');

const DAYS = 7;
const BET  = 5.00;

// Set DUMP_DAY to a YYYY-MM-DD string to print EVERY trade for that day.
// Leave null to just print summaries. Pass as arg: node mode4ab_backtest.js 2026-05-27
const DUMP_DAY = process.argv[2] || null;

const CONFIGS = [
  { name: 'M4a (2/7, 50-85c)', midLo: 0.50, midHi: 0.85, minIn: 1,  maxIn: 14, confluence: 2 },
  { name: 'M4a (3/7, 50-85c)', midLo: 0.50, midHi: 0.85, minIn: 1,  maxIn: 14, confluence: 3 },
  { name: 'M4a (2/7, 55-80c)', midLo: 0.55, midHi: 0.80, minIn: 1,  maxIn: 14, confluence: 2 },
  { name: 'M4b (3/7, 86-96c)', midLo: 0.86, midHi: 0.96, minIn: 9,  maxIn: 14, confluence: 3 },
];

// Which config to dump a full day for (index into CONFIGS) — the winner.
const DUMP_CONFIG_IDX = 2;

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

function calcConfluence(candlesByTf, minScore) {
  const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
  const signals = TFS.map(tf => tfTrend(candlesByTf[tf]));
  const up = signals.filter(s => s === 'UP').length;
  const dn = signals.filter(s => s === 'DOWN').length;
  if (up > dn && up >= minScore) return { dir: 'UP', score: up };
  if (dn > up && dn >= minScore) return { dir: 'DOWN', score: dn };
  return { dir: null, score: Math.max(up, dn) };
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
  const lookbackMs = 30 * 24 * 60 * 60 * 1000;

  console.log(`Fetching ${DAYS} days of Binance 1m data (+ lookback for RSI)...`);
  const candles1m = await fetchKlines('1m', startMs - lookbackMs, endMs);
  console.log(`  Got ${candles1m.length} 1m candles\n`);

  if (candles1m.length < 1000) { console.log('Not enough data'); return; }

  const candles3m  = resampleCandles(candles1m, 3);
  const candles5m  = resampleCandles(candles1m, 5);
  const candles15m = resampleCandles(candles1m, 15);
  const candles30m = resampleCandles(candles1m, 30);
  const candles1h  = resampleCandles(candles1m, 60);
  const candles4h  = resampleCandles(candles1m, 240);

  // Simulate 15-min windows (KXBTC15M style)
  const windowMs = 15 * 60 * 1000;
  const firstWindow = Math.ceil(startMs / windowMs) * windowMs;

  for (let cfgIdx = 0; cfgIdx < CONFIGS.length; cfgIdx++) {
    const cfg = CONFIGS[cfgIdx];
    const trades = [];
    let bankroll = 70;
    let skipSignals = 0;
    let recoveryMulti = 1;

    for (let closeTime = firstWindow; closeTime < endMs; closeTime += windowMs) {
      const openTime = closeTime - windowMs;
      const windowCandles = candles1m.filter(c => c.openTime >= openTime && c.openTime < closeTime);
      if (windowCandles.length < 14) continue;

      // KXBTC15M: strike = exact BTC price at window open (not rounded)
      const strike = windowCandles[0].open;

      for (let checkMin = Math.ceil(cfg.minIn); checkMin <= Math.floor(cfg.maxIn); checkMin++) {
        const minutesIn = checkMin;
        const minutesLeft = 15 - minutesIn;

        const checkTime = openTime + checkMin * 60 * 1000;

        const tf1m  = getCandlesUpTo(candles1m,  checkTime, 60);
        const tf3m  = getCandlesUpTo(candles3m,  checkTime, 30);
        const tf5m  = getCandlesUpTo(candles5m,  checkTime, 35);
        const tf15m = getCandlesUpTo(candles15m, checkTime, 25);
        const tf30m = getCandlesUpTo(candles30m, checkTime, 25);
        const tf1h  = getCandlesUpTo(candles1h,  checkTime, 25);
        const tf4h  = getCandlesUpTo(candles4h,  checkTime, 20);

        const candlesByTf = { '1m': tf1m, '3m': tf3m, '5m': tf5m, '15m': tf15m, '30m': tf30m, '1h': tf1h, '4h': tf4h };
        const { dir, score } = calcConfluence(candlesByTf, cfg.confluence);
        if (!dir) continue;

        const btcNow = tf1m.length ? tf1m[tf1m.length - 1].close : null;
        if (!btcNow) continue;
        const dist = btcNow - strike;

        // Approximate mid price from distance
        // 15-min contracts: tighter range since less time for big moves
        const absDist = Math.abs(dist);
        let yesMid, noMid;
        if (dist > 0) {
          yesMid = Math.min(0.97, 0.50 + absDist / 400);
          noMid = 1 - yesMid;
        } else {
          noMid = Math.min(0.97, 0.50 + absDist / 400);
          yesMid = 1 - noMid;
        }

        // Time decay: prices get more extreme as window closes
        const timeFactor = 1 + (minutesIn / 15) * 0.5;
        if (dist > 0) {
          yesMid = Math.min(0.97, 0.50 + (yesMid - 0.50) * timeFactor);
          noMid = 1 - yesMid;
        } else {
          noMid = Math.min(0.97, 0.50 + (noMid - 0.50) * timeFactor);
          yesMid = 1 - noMid;
        }

        const yesOk = yesMid >= cfg.midLo && yesMid <= cfg.midHi;
        const noOk  = noMid  >= cfg.midLo && noMid  <= cfg.midHi;

        let side, contractPx;
        if      (dir === 'UP'   && yesOk) { side = 'YES'; contractPx = yesMid; }
        else if (dir === 'DOWN' && noOk)  { side = 'NO';  contractPx = noMid;  }
        else continue;

        // Skip signals (recovery logic)
        if (skipSignals > 0) { skipSignals--; continue; }

        const cost = BET * recoveryMulti;
        if (bankroll < cost) continue;

        // Resolution: average of last minute of 1m closes (mimics CFB RTI avg)
        const resolveCandles = candles1m.filter(c => c.openTime >= closeTime - 1 * 60 * 1000 && c.openTime < closeTime);
        if (resolveCandles.length < 1) continue;
        const resolvePrice = resolveCandles.reduce((s, c) => s + c.close, 0) / resolveCandles.length;
        const won = side === 'YES' ? resolvePrice > strike : resolvePrice < strike;

        const payout = cost / contractPx;
        const pnl = won ? (payout - cost) : -cost;
        bankroll += pnl;

        if (won) { recoveryMulti = 1; }
        else { skipSignals = 2; recoveryMulti = 3; }

        trades.push({
          time: new Date(checkTime).toISOString(),
          strike: Math.round(strike), btcNow: Math.round(btcNow),
          resolvePrice: Math.round(resolvePrice),
          side, contractPx: +(contractPx.toFixed(3)), dir, score,
          won, pnl: +pnl.toFixed(2), bankroll: +bankroll.toFixed(2),
          minutesIn, multi: recoveryMulti === 1 && !won ? 3 : (won ? 1 : recoveryMulti),
        });

        break;
      }
    }

    // Results
    const wins = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wr = trades.length ? (wins / trades.length * 100) : 0;
    const maxDD = trades.reduce((dd, t) => { dd.cur += t.pnl; dd.max = Math.min(dd.max, dd.cur); return dd; }, { cur: 0, max: 0 }).max;
    const avgWin = wins > 0 ? trades.filter(t => t.won).reduce((s, t) => s + t.pnl, 0) / wins : 0;
    const avgLoss = losses > 0 ? trades.filter(t => !t.won).reduce((s, t) => s + t.pnl, 0) / losses : 0;

    console.log(`${'═'.repeat(70)}`);
    console.log(`  ${cfg.name}  |  $${BET} base bet  |  ${DAYS} days  |  skip-2 then 3x`);
    console.log(`${'═'.repeat(70)}`);
    console.log(`  Trades:     ${trades.length}`);
    console.log(`  Wins:       ${wins}  |  Losses: ${losses}  |  Win Rate: ${wr.toFixed(1)}%`);
    console.log(`  Avg Win:    +$${avgWin.toFixed(2)}  |  Avg Loss: $${avgLoss.toFixed(2)}`);
    console.log(`  Total PnL:  ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`  Max DD:     $${maxDD.toFixed(2)}`);
    console.log(`  Final bank: $${bankroll.toFixed(2)} (started $70)`);

    // Per-day breakdown
    const byDay = {};
    for (const t of trades) {
      const day = t.time.slice(0, 10);
      if (!byDay[day]) byDay[day] = { trades: 0, wins: 0, pnl: 0 };
      byDay[day].trades++;
      if (t.won) byDay[day].wins++;
      byDay[day].pnl += t.pnl;
    }
    console.log('\n  Day          Trades  W/L      WR      PnL');
    console.log('  ' + '─'.repeat(50));
    for (const [day, d] of Object.entries(byDay).sort()) {
      const dayWr = (d.wins / d.trades * 100).toFixed(0);
      const pnlStr = (d.pnl >= 0 ? '+' : '') + '$' + d.pnl.toFixed(2);
      console.log(`  ${day}    ${String(d.trades).padStart(3)}     ${d.wins}/${d.trades - d.wins}     ${dayWr.padStart(3)}%    ${pnlStr}`);
    }

    // Show last 10 trades
    console.log(`\n  Last 10 trades:`);
    console.log('  Time             Side  Px    Dir  Score  MinIn  Strike    BTC      Result  PnL       Bank');
    console.log('  ' + '─'.repeat(95));
    for (const t of trades.slice(-10)) {
      const timeStr = t.time.slice(5, 16).replace('T', ' ');
      const result = t.won ? 'WIN ' : 'LOSS';
      const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
      console.log(`  ${timeStr}  ${t.side.padEnd(4)}  ${(t.contractPx*100).toFixed(0)}c   ${t.dir.padEnd(4)} ${t.score}/7    ${String(t.minutesIn).padStart(2)}     $${t.strike}   $${t.btcNow}   ${result}   ${pnlStr.padStart(8)}   $${t.bankroll.toFixed(2)}`);
    }
    console.log('');

    // FULL DAY DUMP — every trade for the chosen day, winning config only
    if (cfgIdx === DUMP_CONFIG_IDX) {
      // Default to the last full day in the data if none specified
      const allDays = [...new Set(trades.map(t => t.time.slice(0, 10)))].sort();
      const targetDay = DUMP_DAY || allDays[allDays.length - 2] || allDays[allDays.length - 1];
      const dayTrades = trades.filter(t => t.time.slice(0, 10) === targetDay);

      console.log(`\n${'█'.repeat(95)}`);
      console.log(`  EVERY TRADE on ${targetDay}  —  ${cfg.name}`);
      console.log(`${'█'.repeat(95)}`);
      console.log('  #   Time(UTC)  Side  Entry  Dir  Conf  MinLeft  Bet     Strike    Resolve   Result  PnL       RunPnL');
      console.log('  ' + '─'.repeat(105));
      let runPnl = 0;
      for (let i = 0; i < dayTrades.length; i++) {
        const t = dayTrades[i];
        runPnl += t.pnl;
        const timeStr = t.time.slice(11, 16);
        const result = t.won ? 'WIN ' : 'LOSS';
        const bet = Math.abs(t.won ? (t.pnl / (1 / t.contractPx - 1)) : t.pnl);
        const betStr = '$' + bet.toFixed(2);
        const pnlStr = (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(2);
        const runStr = (runPnl >= 0 ? '+' : '') + '$' + runPnl.toFixed(2);
        const minLeft = 15 - t.minutesIn;
        console.log(`  ${String(i+1).padStart(2)}  ${timeStr}     ${t.side.padEnd(4)}  ${(t.contractPx*100).toFixed(0)}c    ${t.dir.padEnd(4)} ${t.score}/7   ${String(minLeft).padStart(2)}min   ${betStr.padStart(6)}  $${t.strike}   $${t.resolvePrice}   ${result}   ${pnlStr.padStart(8)}   ${runStr.padStart(8)}`);
      }
      const dayWins = dayTrades.filter(t => t.won).length;
      const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      const bets = dayTrades.map(t => Math.abs(t.won ? (t.pnl / (1 / t.contractPx - 1)) : t.pnl));
      const totalWagered = bets.reduce((s, b) => s + b, 0);
      console.log('  ' + '─'.repeat(105));
      console.log(`  TOTAL: ${dayTrades.length} trades  |  ${dayWins}W/${dayTrades.length - dayWins}L (${(dayWins/dayTrades.length*100).toFixed(0)}% WR)  |  Wagered: $${totalWagered.toFixed(2)}  |  Day PnL: ${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)}`);
      console.log(`  Avg bet: $${(totalWagered/dayTrades.length).toFixed(2)}  |  3x recovery bets: ${dayTrades.filter(t => Math.abs(t.won ? (t.pnl/(1/t.contractPx-1)) : t.pnl) > 10).length}`);
      console.log('');
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
