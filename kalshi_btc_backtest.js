/**
 * kalshi_btc_backtest.js — Historical Backtest for BTC 15-min Strategy
 *
 * Fetches 30 days of Binance 1-min OHLCV data for BTC/USDT.
 * Groups into 15-min windows. Simulates all three modes on each window.
 * Outputs results for both 10-day and 30-day periods.
 *
 * SIMULATION ASSUMPTIONS:
 *   - Strike = BTC open price at start of each 15-min window (± nearest $50)
 *   - Resolution = close price at window end vs strike (CF benchmark approximated
 *     as the average of the last 5 one-minute closes before expiry)
 *   - Entry odds approximated as 50¢ (50/50 at open) for Mode 1,
 *     and distance-scaled for Mode 2 (closer to strike = cheaper)
 *   - Mode 3 odds = 10¢ (the losing side of a 90%+ market)
 *
 * Usage:
 *   node kalshi_btc_backtest.js
 *   node kalshi_btc_backtest.js --days 10
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const OUT_FILE = path.join(__dirname, 'dashboard', 'btc_backtest_results.json');
const PAPER_START   = 50.00;
const KELLY_HIGH    = 0.05;
const MODE2_BET_PCT = 0.03;
const CONTRARIAN_BET = 1.00;

// ── Binance fetch ─────────────────────────────────────────────────
function binanceGet(urlPath) {
  return new Promise(resolve => {
    // Use data-api.binance.vision — public access without geo-restrictions
    const req = https.get('https://data-api.binance.vision' + urlPath, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchKlinesBatch(startTime, endTime) {
  const url = `/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  const data = await binanceGet(url);
  if (!Array.isArray(data)) return [];
  return data.map(k => ({
    openTime:  k[0],
    closeTime: k[6],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ── Fetch all candles for a given day range ───────────────────────
async function fetchDays(days) {
  const endMs   = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const allCandles = [];
  let cursor = startMs;

  process.stdout.write(`  Fetching ${days}d of Binance 1m data `);
  while (cursor < endMs) {
    const batch = await fetchKlinesBatch(cursor, Math.min(cursor + 1000 * 60 * 1000, endMs));
    if (!batch.length) break;
    allCandles.push(...batch);
    cursor = batch[batch.length - 1].closeTime + 1;
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 120)); // rate limit respect
  }
  console.log(` done — ${allCandles.length} candles`);
  return allCandles;
}

// ── RSI (Wilder) ──────────────────────────────────────────────────
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

// ── Clamp helper ──────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── Kelly bet ─────────────────────────────────────────────────────
function kellySize(bankroll, winProb, contractPx) {
  const b = (1 - contractPx) / contractPx;
  const k = (winProb * b - (1 - winProb)) / b;
  return clamp(k / 2, 0, KELLY_HIGH) * bankroll;
}

// ── Simulate Mode 1 signal ─────────────────────────────────────────
function signalMode1(candles, strike, prevSide) {
  const closes = candles.map(c => c.close);
  const rsi1m  = rsi(closes);
  // Simulate 5m RSI using every 5th close as proxy
  const closes5m = closes.filter((_, i) => i % 5 === 0);
  const rsi5m  = rsi(closes5m);

  const btcPrice = closes[closes.length - 1];
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

  const recent  = candles.slice(-4, -1);
  const greens  = recent.filter(c => c.close > c.open).length;
  const reds    = recent.filter(c => c.close < c.open).length;
  if      (greens === 3) bull += 14;
  else if (greens === 2) bull += 6;
  else if (reds   === 3) bull -= 14;
  else if (reds   === 2) bull -= 6;

  if (prevSide === 'YES') bull += 6;
  else if (prevSide === 'NO') bull -= 6;

  const avgVol = candles.slice(-11, -1).reduce((s, c) => s + c.volume, 0) / 10;
  const lastC  = candles[candles.length - 1];
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

  return confidence >= 70 ? { enter: true, side, confidence } : { enter: false };
}

// ── Simulate Mode 2 signal ────────────────────────────────────────
function signalMode2(candles, strike) {
  const closes   = candles.map(c => c.close);
  const rsi1m    = rsi(closes);
  const btcPrice = closes[closes.length - 1];
  const distance = btcPrice - strike;
  const absDist  = Math.abs(distance);
  const side     = distance >= 0 ? 'YES' : 'NO';

  if (absDist < 200) return { enter: false };

  if (rsi1m !== null) {
    if (side === 'YES' && rsi1m > 72) return { enter: false };
    if (side === 'NO'  && rsi1m < 28) return { enter: false };
  }

  const recent = candles.slice(-3);
  if (side === 'YES' && recent.filter(c => c.close < c.open).length === 3) return { enter: false };
  if (side === 'NO'  && recent.filter(c => c.close > c.open).length === 3) return { enter: false };

  let confidence = 65;
  if      (absDist >= 600) confidence = 80;
  else if (absDist >= 400) confidence = 73;
  else if (absDist >= 300) confidence = 69;

  return { enter: true, side, confidence, absDist };
}

// ── Simulate Mode 3 signal ────────────────────────────────────────
// Proxy: crowd is "90%+" if the closing direction in the FIRST 2 min
// is very decisive. We invert: if candles clearly go up, price moving UP
// but we check if final price goes DOWN (contrarian wins).
function signalMode3(openCandles) {
  // Proxy "crowd" as the direction in first 2 candles
  const firstTwo = openCandles.slice(0, 2);
  if (firstTwo.length < 2) return { enter: false };

  const firstMove = firstTwo[1].close - firstTwo[0].open;
  const pctMove   = Math.abs(firstMove) / firstTwo[0].open * 100;

  // Only trigger if first 2 candles show a strong directional move (≥ 0.08%)
  if (pctMove < 0.08) return { enter: false };

  // Crowd "expects" continuation of that move
  const crowdSide   = firstMove > 0 ? 'YES' : 'NO';
  const contraside  = crowdSide === 'YES' ? 'NO' : 'YES';
  const contractPx  = 0.10; // approximate: opposite side of a 90% market

  return { enter: true, side: contraside, confidence: 50, contractPx };
}

// ── Group 1-min candles into 15-min windows ───────────────────────
function groupIntoWindows(candles) {
  const windows = [];
  const MS15 = 15 * 60 * 1000;

  // Find the first 15-min boundary
  const firstT = candles[0].openTime;
  const offset  = firstT % MS15;
  let wStart    = firstT - offset;

  while (wStart < candles[candles.length - 1].openTime) {
    const wEnd = wStart + MS15;
    const wCandles = candles.filter(c => c.openTime >= wStart && c.openTime < wEnd);
    if (wCandles.length >= 10) {  // need at least 10 candles for meaningful signals
      windows.push({ startMs: wStart, endMs: wEnd, candles: wCandles });
    }
    wStart = wEnd;
  }
  return windows;
}

// ── Run full backtest ─────────────────────────────────────────────
function runBacktest(windows, days) {
  const label = `${days}d`;

  let m1Bank = PAPER_START, m2Bank = PAPER_START;
  let m1BankHist = [PAPER_START], m2BankHist = [PAPER_START];
  let m1Wins = 0, m1Losses = 0, m1Skipped = 0;
  let m2Wins = 0, m2Losses = 0, m2Skipped = 0;
  let m3Wins = 0, m3Losses = 0, m3Skipped = 0;
  let m3PaperPnl = 0;
  let prevSide = null;
  const m1Trades = [], m2Trades = [], m3Trades = [];

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    const { candles } = w;

    if (candles.length < 15) { m1Skipped++; m2Skipped++; continue; }

    // Strike = open price of window, rounded to nearest $50
    const openPrice  = candles[0].open;
    const strike     = Math.round(openPrice / 50) * 50;

    // Resolution: average of last 5 closes (CF benchmark proxy)
    const lastFive   = candles.slice(-5).map(c => c.close);
    const settlement = lastFive.reduce((s, v) => s + v, 0) / lastFive.length;
    const resolvedYes = settlement > strike;

    const entryDate  = new Date(w.startMs).toISOString().slice(0, 10);
    const entryTime  = new Date(w.startMs).toISOString().slice(11, 16);

    // ── MODE 1: use first 2 candles as entry signal ─────────────
    if (candles.length >= 3) {
      const entryCandlesM1 = candles.slice(0, 2);  // minutes 0-2
      // Build a history of candles before this window for RSI
      const histCandles = wi >= 1 ? windows[wi-1].candles : [];
      const allM1 = [...histCandles, ...entryCandlesM1];

      const sig = signalMode1(allM1, strike, prevSide);
      if (sig.enter && m1Bank >= 0.25) {
        // Entry odds: approximate 50¢ (near-50/50 at open)
        const contractPx = 0.50;
        const cost   = kellySize(m1Bank, sig.confidence / 100, contractPx);
        if (cost >= 0.25) {
          const won  = (sig.side === 'YES') === resolvedYes;
          const pnl  = won ? cost / contractPx - cost : -cost;
          m1Bank    = Math.max(0, m1Bank + pnl);
          m1BankHist.push(parseFloat(m1Bank.toFixed(2)));
          if (won) m1Wins++; else m1Losses++;
          m1Trades.push({ date: entryDate, time: entryTime, side: sig.side, confidence: sig.confidence, cost: parseFloat(cost.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)), won, strike, settlement: parseFloat(settlement.toFixed(2)) });
          prevSide = sig.side;
        } else { m1Skipped++; }
      } else { m1Skipped++; }
    }

    // ── MODE 2: use minutes 5-10 as entry ────────────────────────
    if (candles.length >= 10) {
      const entryCandlesM2 = candles.slice(0, 7);  // minutes ~5-7
      const histCandles = wi >= 1 ? windows[wi-1].candles : [];
      const allM2 = [...histCandles, ...entryCandlesM2];

      const sig = signalMode2(allM2, strike);
      if (sig.enter && m2Bank >= 0.25) {
        // Entry odds scale with distance: farther = cheaper on losing side
        // $200 dist → ~70¢, $400 → ~78¢, $600+ → ~85¢
        const absDist    = sig.absDist;
        const contractPx = absDist >= 600 ? 0.85 : absDist >= 400 ? 0.78 : 0.70;
        const cost       = parseFloat((m2Bank * MODE2_BET_PCT).toFixed(4));
        if (cost >= 0.10) {
          const won  = (sig.side === 'YES') === resolvedYes;
          const pnl  = won ? cost / contractPx - cost : -cost;
          m2Bank    = Math.max(0, m2Bank + pnl);
          m2BankHist.push(parseFloat(m2Bank.toFixed(2)));
          if (won) m2Wins++; else m2Losses++;
          m2Trades.push({ date: entryDate, time: entryTime, side: sig.side, confidence: sig.confidence, cost: parseFloat(cost.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)), won, strike, settlement: parseFloat(settlement.toFixed(2)), distance: parseFloat(sig.absDist.toFixed(0)) });
        } else { m2Skipped++; }
      } else { m2Skipped++; }
    }

    // ── MODE 3: Contrarian ────────────────────────────────────────
    if (candles.length >= 3) {
      const sig = signalMode3(candles.slice(0, 2));
      if (sig.enter) {
        const won  = (sig.side === 'YES') === resolvedYes;
        const cost = CONTRARIAN_BET;
        const pnl  = won ? cost / sig.contractPx - cost : -cost;
        m3PaperPnl += pnl;
        if (won) m3Wins++; else m3Losses++;
        m3Trades.push({ date: entryDate, time: entryTime, side: sig.side, cost, pnl: parseFloat(pnl.toFixed(2)), won, strike, settlement: parseFloat(settlement.toFixed(2)) });
      } else { m3Skipped++; }
    }
  }

  const m1Tot = m1Wins + m1Losses;
  const m2Tot = m2Wins + m2Losses;
  const m3Tot = m3Wins + m3Losses;

  return {
    label,
    windows: windows.length,
    mode1: {
      trades: m1Tot, wins: m1Wins, losses: m1Losses, skipped: m1Skipped,
      winRate:   m1Tot ? parseFloat((m1Wins / m1Tot * 100).toFixed(1)) : 0,
      startBank: PAPER_START,
      endBank:   parseFloat(m1Bank.toFixed(2)),
      pnl:       parseFloat((m1Bank - PAPER_START).toFixed(2)),
      roi:       parseFloat(((m1Bank - PAPER_START) / PAPER_START * 100).toFixed(1)),
      bankrollHistory: m1BankHist,
      recentTrades:    m1Trades.slice(-20),
    },
    mode2: {
      trades: m2Tot, wins: m2Wins, losses: m2Losses, skipped: m2Skipped,
      winRate:   m2Tot ? parseFloat((m2Wins / m2Tot * 100).toFixed(1)) : 0,
      startBank: PAPER_START,
      endBank:   parseFloat(m2Bank.toFixed(2)),
      pnl:       parseFloat((m2Bank - PAPER_START).toFixed(2)),
      roi:       parseFloat(((m2Bank - PAPER_START) / PAPER_START * 100).toFixed(1)),
      bankrollHistory: m2BankHist,
      recentTrades:    m2Trades.slice(-20),
    },
    mode3: {
      trades: m3Tot, wins: m3Wins, losses: m3Losses, skipped: m3Skipped,
      winRate:   m3Tot ? parseFloat((m3Wins / m3Tot * 100).toFixed(1)) : 0,
      paperPnl:  parseFloat(m3PaperPnl.toFixed(2)),
      note:      'Paper only — $1 flat bets, never real money',
      recentTrades: m3Trades.slice(-20),
    },
    bestMode: m1Wins/Math.max(m1Tot,1) >= m2Wins/Math.max(m2Tot,1)
      ? (m1Wins/Math.max(m1Tot,1) >= m3Wins/Math.max(m3Tot,1) ? 'Mode 1' : 'Mode 3')
      : (m2Wins/Math.max(m2Tot,1) >= m3Wins/Math.max(m3Tot,1) ? 'Mode 2' : 'Mode 3'),
    generatedAt: new Date().toISOString(),
  };
}

// ── Entry ─────────────────────────────────────────────────────────
(async () => {
  console.log('\n📊 Kalshi BTC Strategy Backtest\n');

  // Fetch 30 days of 1-min candles (also covers 10 day slice)
  const candles30 = await fetchDays(30);
  if (candles30.length < 100) {
    console.error('  ❌ Not enough data fetched — check network connectivity');
    process.exit(1);
  }

  // Slice for 10-day window
  const cutoff10d  = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const candles10  = candles30.filter(c => c.openTime >= cutoff10d);

  console.log(`\n  30d candles: ${candles30.length}  |  10d candles: ${candles10.length}`);

  // Group into 15-min windows
  const windows30 = groupIntoWindows(candles30);
  const windows10 = groupIntoWindows(candles10);

  console.log(`  30d windows: ${windows30.length}  |  10d windows: ${windows10.length}\n`);

  // Run backtests
  console.log('  Running 30-day backtest…');
  const bt30 = runBacktest(windows30, 30);

  console.log('  Running 10-day backtest…');
  const bt10 = runBacktest(windows10, 10);

  // Save results
  const results = { days30: bt30, days10: bt10, generatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));

  // ── Print summary ─────────────────────────────────────────────
  for (const [bt, days] of [[bt30, 30], [bt10, 10]]) {
    console.log(`\n  ── ${days}-DAY BACKTEST ──────────────────────────────────────────`);
    console.log(`  Windows: ${bt.windows}  |  Best mode: ${bt.bestMode}`);
    for (const [mk, label] of [['mode1','Mode 1'],['mode2','Mode 2'],['mode3','Mode 3']]) {
      const m = bt[mk];
      if (mk === 'mode3') {
        console.log(`  ${label}: ${m.wins}/${m.trades} (${m.winRate}% WR)  paper P&L ${m.paperPnl >= 0 ? '+' : ''}$${m.paperPnl}`);
      } else {
        const arr = m.pnl >= 0 ? '+' : '';
        console.log(`  ${label}: ${m.wins}/${m.trades} (${m.winRate}% WR)  $${PAPER_START} -> $${m.endBank} (${arr}$${m.pnl}, ${m.roi >= 0 ? '+' : ''}${m.roi}% ROI)  skipped: ${m.skipped}`);
      }
    }
  }

  console.log(`\n  ✅ Results saved to ${OUT_FILE}\n`);
})