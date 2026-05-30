#!/usr/bin/env python3
"""
backtest_chart.py
Fetches real Kraken BTC/USD 5-min data, runs the RSI strategy,
finds the last 10 trades, and writes backtest_chart.html
"""

import json, os, sys, requests, webbrowser
import pandas as pd
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import (
    RSI_PERIOD, RSI_OVERSOLD, RSI_OVERBOUGHT,
    MOMENTUM_FILTER, CANDLE_CONFIRM,
    STARTING_BALANCE, KELLY_FRACTION, MIN_BET, MAX_BET,
    TARGET_BALANCE,
)

KRAKEN_URL = "https://api.kraken.com/0/public/OHLC"
OUT_FILE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backtest_chart.html")

# ── DATA ─────────────────────────────────────────────────────

def fetch_candles(interval=5, limit=720):
    print("  Fetching Kraken BTC/USD data...")
    params = {"pair": "XBTUSD", "interval": interval}
    resp = requests.get(KRAKEN_URL, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise ValueError("Kraken error: " + str(data["error"]))
    pair_key = [k for k in data["result"] if k != "last"][0]
    raw = data["result"][pair_key][-limit:]
    df = pd.DataFrame(raw, columns=[
        "open_time","open","high","low","close","vwap","volume","count"
    ])
    for col in ["open","high","low","close"]:
        df[col] = df[col].astype(float)
    df["open_time"] = pd.to_datetime(df["open_time"], unit="s")
    df = df.reset_index(drop=True)
    print(f"  Got {len(df)} candles ({df['open_time'].iloc[0].strftime('%m/%d %H:%M')} -> {df['open_time'].iloc[-1].strftime('%m/%d %H:%M')})")
    return df

# ── INDICATORS ───────────────────────────────────────────────

def calculate_rsi(series, period=RSI_PERIOD):
    delta    = series.diff()
    gain     = delta.clip(lower=0)
    loss     = (-delta).clip(lower=0)
    avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
    rs       = avg_gain / avg_loss.replace(0, float("nan"))
    return 100 - (100 / (1 + rs))

def calculate_bet(balance):
    return round(max(MIN_BET, min(MAX_BET, balance * KELLY_FRACTION)), 2)

# ── BACKTEST ─────────────────────────────────────────────────

def run_backtest(df):
    df = df.copy()
    df["rsi"] = calculate_rsi(df["close"])

    trades   = []
    balance  = STARTING_BALANCE
    in_trade = False
    entry    = {}

    for i in range(2, len(df) - 1):
        rsi_now  = df["rsi"].iloc[i]
        rsi_prev = df["rsi"].iloc[i - 1]
        close_i  = df["close"].iloc[i]
        open_i   = df["open"].iloc[i]
        is_green = close_i > open_i

        # Resolve open trade on next candle
        if in_trade:
            exit_price = df["close"].iloc[i]
            went_up    = exit_price > entry["price"]
            correct    = (entry["signal"] == "YES" and went_up) or \
                         (entry["signal"] == "NO"  and not went_up)
            pnl        = entry["bet"] if correct else -entry["bet"]
            if correct:
                balance += entry["bet"] * 2
            trades.append({
                "entry_idx"   : entry["idx"],
                "exit_idx"    : i,
                "entry_time"  : df["open_time"].iloc[entry["idx"]].strftime("%m/%d %H:%M"),
                "exit_time"   : df["open_time"].iloc[i].strftime("%m/%d %H:%M"),
                "signal"      : entry["signal"],
                "entry_price" : round(entry["price"], 2),
                "exit_price"  : round(exit_price, 2),
                "entry_rsi"   : round(entry["rsi"], 2),
                "bet"         : round(entry["bet"], 2),
                "pnl"         : round(pnl, 2),
                "result"      : "WIN" if correct else "LOSS",
                "balance_after": round(balance, 2),
            })
            in_trade = False

        # Check for new signal
        if not in_trade and pd.notna(rsi_now) and balance >= MIN_BET:
            signal = None
            if rsi_now < RSI_OVERSOLD:
                signal = "YES"
            elif rsi_now > RSI_OVERBOUGHT:
                signal = "NO"

            if signal and MOMENTUM_FILTER:
                if signal == "YES" and rsi_now <= rsi_prev: signal = None
                if signal == "NO"  and rsi_now >= rsi_prev: signal = None

            if signal and CANDLE_CONFIRM:
                if signal == "YES" and not is_green: signal = None
                if signal == "NO"  and is_green:     signal = None

            if signal:
                bet = calculate_bet(balance)
                balance -= bet
                in_trade = True
                entry = {
                    "idx"   : i,
                    "price" : close_i,
                    "signal": signal,
                    "rsi"   : rsi_now,
                    "bet"   : bet,
                }

    return trades

# ── HTML CHART ───────────────────────────────────────────────

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Polymarket RSI Backtest</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js"
  integrity="sha384-iU8HYtnGQ8Cy4zl7gbNMOhsDTTKX02BTXptVP/vqAWIaTfM7isw76iyZCsjL2eVi"
  crossorigin="anonymous"></script>
<style>
:root{color-scheme:light}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e;font-size:13px}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:17px;font-weight:700;margin-bottom:4px}
.sub{font-size:12px;color:#888;margin-bottom:16px}
.card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:14px}
.card h2{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#888;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #f0f0f0}
.chart-wrap{position:relative;height:260px}
.rsi-wrap{position:relative;height:160px}
.stat-row{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.stat-box{flex:1;min-width:80px;background:#f8f9fa;border-radius:8px;padding:10px;text-align:center}
.stat-box .val{font-size:18px;font-weight:700}
.stat-box .val.g{color:#00c853}.stat-box .val.r{color:#e94560}
.stat-box .lbl{font-size:10px;color:#999;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#f8f9fa;padding:7px 10px;text-align:left;font-weight:600;color:#888}
td{padding:7px 10px;border-top:1px solid #f0f0f0}
tr:hover td{background:#fafafa}
.win{color:#00c853;font-weight:700}.loss{color:#e94560;font-weight:700}
.tag-yes{background:#e8f5e9;color:#2e7d32;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700}
.tag-no{background:#ffebee;color:#c62828;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700}
.legend{display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap;font-size:11px;color:#555}
.legend-item{display:flex;align-items:center;gap:5px}
.dot{width:10px;height:10px;border-radius:50%}
</style>
</head>
<body>
<div class="wrap">
  <h1>&#9889; RSI Backtest — BTC/USD 5-min</h1>
  <div class="sub" id="subline">Loading...</div>

  <div class="stat-row" id="statRow"></div>

  <div class="card">
    <h2>&#128200; BTC Price + Trade Entries &amp; Exits</h2>
    <div class="legend">
      <div class="legend-item"><div class="dot" style="background:#00c853"></div> YES Entry (oversold)</div>
      <div class="legend-item"><div class="dot" style="background:#e94560"></div> NO Entry (overbought)</div>
      <div class="legend-item"><div class="dot" style="background:#1565c0;width:10px;height:10px;border-radius:2px"></div> WIN Exit</div>
      <div class="legend-item"><div class="dot" style="background:#b71c1c;width:10px;height:10px;border-radius:2px"></div> LOSS Exit</div>
    </div>
    <div class="chart-wrap"><canvas id="priceChart"></canvas></div>
  </div>

  <div class="card">
    <h2>&#128201; RSI (14)</h2>
    <div class="rsi-wrap"><canvas id="rsiChart"></canvas></div>
  </div>

  <div class="card">
    <h2>&#128203; Last 10 Trades</h2>
    <div style="overflow-x:auto"><table id="tradeTable"></table></div>
  </div>
</div>

<script>
const D = __DATA__;

// Stats
const wins   = D.trades.filter(t => t.result === "WIN").length;
const losses = D.trades.filter(t => t.result === "LOSS").length;
const total  = D.trades.length;
const wr     = total > 0 ? (wins/total*100).toFixed(1) : 0;
const pnl    = D.trades.reduce((s,t) => s+t.pnl, 0).toFixed(2);
const lastBal = total > 0 ? D.trades[total-1].balance_after : D.start_bal;

document.getElementById('subline').textContent =
  D.candle_from + " → " + D.candle_to + "   |   " + D.total_candles + " candles   |   " + total + " trades found";

const stats = [
  {v: '$'+parseFloat(lastBal).toFixed(2), l:'Balance', c: parseFloat(pnl)>=0?'g':'r'},
  {v: wins+'W / '+losses+'L', l:'W / L', c:''},
  {v: wr+'%', l:'Win Rate', c: parseFloat(wr)>=60?'g':parseFloat(wr)<50?'r':''},
  {v: (pnl>=0?'+$':'-$')+Math.abs(pnl).toFixed(2), l:'Total P&L', c: pnl>=0?'g':'r'},
  {v: '$'+D.trades.reduce((mx,t)=>Math.max(mx,t.bet),0).toFixed(2), l:'Largest Bet', c:''},
];
document.getElementById('statRow').innerHTML = stats.map(s =>
  `<div class="stat-box"><div class="val ${s.c}">${s.v}</div><div class="lbl">${s.l}</div></div>`
).join('');

// Determine visible range: show candles around last 10 trades
const tradeIdxs = D.trades.flatMap(t => [t.entry_idx, t.exit_idx]);
const minIdx = Math.max(0, Math.min(...tradeIdxs) - 20);
const maxIdx = Math.min(D.prices.length - 1, Math.max(...tradeIdxs) + 10);
const labels  = D.labels.slice(minIdx, maxIdx+1);
const prices  = D.prices.slice(minIdx, maxIdx+1);
const rsiVals = D.rsi.slice(minIdx, maxIdx+1);

// Entry/exit scatter points (offset by minIdx)
const entryYES = D.trades.filter(t=>t.signal==="YES").map(t=>({x:t.entry_time, y:t.entry_price, trade:t}));
const entryNO  = D.trades.filter(t=>t.signal==="NO").map(t=>({x:t.entry_time, y:t.entry_price, trade:t}));
const exitWIN  = D.trades.filter(t=>t.result==="WIN").map(t=>({x:t.exit_time, y:t.exit_price, trade:t}));
const exitLOSS = D.trades.filter(t=>t.result==="LOSS").map(t=>({x:t.exit_time, y:t.exit_price, trade:t}));

// Price Chart
new Chart(document.getElementById('priceChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'BTC Close',
        data: prices,
        borderColor: '#1a1a2e',
        backgroundColor: 'rgba(26,26,46,0.04)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        fill: true,
        order: 5,
      },
      {
        label: 'YES Entry',
        data: D.trades.filter(t=>t.signal==="YES").map(t=>({x:t.entry_time, y:t.entry_price})),
        type: 'scatter',
        backgroundColor: '#00c853',
        borderColor: '#fff',
        borderWidth: 1.5,
        pointRadius: 8,
        pointStyle: 'triangle',
        order: 1,
      },
      {
        label: 'NO Entry',
        data: D.trades.filter(t=>t.signal==="NO").map(t=>({x:t.entry_time, y:t.entry_price})),
        type: 'scatter',
        backgroundColor: '#e94560',
        borderColor: '#fff',
        borderWidth: 1.5,
        pointRadius: 8,
        pointStyle: 'triangle',
        rotation: 180,
        order: 1,
      },
      {
        label: 'WIN Exit',
        data: D.trades.filter(t=>t.result==="WIN").map(t=>({x:t.exit_time, y:t.exit_price})),
        type: 'scatter',
        backgroundColor: '#1565c0',
        borderColor: '#fff',
        borderWidth: 1.5,
        pointRadius: 7,
        pointStyle: 'rectRot',
        order: 2,
      },
      {
        label: 'LOSS Exit',
        data: D.trades.filter(t=>t.result==="LOSS").map(t=>({x:t.exit_time, y:t.exit_price})),
        type: 'scatter',
        backgroundColor: '#b71c1c',
        borderColor: '#fff',
        borderWidth: 1.5,
        pointRadius: 7,
        pointStyle: 'rectRot',
        order: 2,
      },
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: ctx => {
            if (ctx.datasetIndex === 0) return ' BTC: $' + ctx.parsed.y.toLocaleString();
            const trade = D.trades.find(t =>
              (t.entry_time === ctx.label && (ctx.datasetIndex===1||ctx.datasetIndex===2)) ||
              (t.exit_time === ctx.label && (ctx.datasetIndex===3||ctx.datasetIndex===4))
            );
            if (!trade) return ctx.dataset.label + ': $' + ctx.parsed.y.toLocaleString();
            const side = ctx.datasetIndex <= 2 ? 'ENTRY' : 'EXIT';
            return ` ${side} [${trade.signal}] RSI:${trade.entry_rsi} Bet:$${trade.bet} → ${trade.result} P&L:${trade.pnl>=0?'+':''}$${trade.pnl}`;
          }
        }
      }
    },
    scales: {
      x: {
        ticks: { maxTicksLimit: 8, font: { size: 10 } },
        grid: { display: false },
      },
      y: {
        ticks: { font: { size: 10 }, callback: v => '$' + v.toLocaleString() },
        grid: { color: '#f5f5f5' },
      }
    }
  }
});

// RSI Chart
const rsiAnnotationPlugin = {
  id: 'rsiLines',
  afterDraw(chart) {
    const { ctx, chartArea: { left, right }, scales: { y } } = chart;
    [D.rsi_os, D.rsi_ob].forEach((val, i) => {
      const yPx = y.getPixelForValue(val);
      ctx.save();
      ctx.setLineDash([4,4]);
      ctx.strokeStyle = i === 0 ? '#00c853' : '#e94560';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(left, yPx); ctx.lineTo(right, yPx); ctx.stroke();
      ctx.font = '10px sans-serif';
      ctx.fillStyle = i === 0 ? '#00c853' : '#e94560';
      ctx.fillText(i===0 ? 'OS '+val : 'OB '+val, right - 50, yPx - 4);
      ctx.restore();
    });
  }
};
Chart.register(rsiAnnotationPlugin);

new Chart(document.getElementById('rsiChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: 'RSI',
      data: rsiVals,
      borderColor: '#7c4dff',
      backgroundColor: 'rgba(124,77,255,0.06)',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.2,
      fill: true,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxTicksLimit: 8, font:{size:10} }, grid:{display:false} },
      y: { min: 0, max: 100, ticks: { stepSize: 25, font:{size:10} }, grid:{color:'#f5f5f5'} }
    }
  }
});

// Trade Table
const last10 = D.trades.slice(-10).reverse();
let th = `<thead><tr>
  <th>#</th><th>Signal</th><th>Entry Time</th><th>Entry $</th>
  <th>Exit Time</th><th>Exit $</th><th>RSI</th><th>Bet</th><th>P&L</th><th>Balance</th>
</tr></thead><tbody>`;
last10.forEach((t,i) => {
  const pnlStr = (t.pnl>=0?'+$':'-$') + Math.abs(t.pnl).toFixed(2);
  th += `<tr>
    <td>${D.trades.length - i}</td>
    <td><span class="${t.signal==='YES'?'tag-yes':'tag-no'}">${t.signal}</span></td>
    <td>${t.entry_time}</td>
    <td>$${t.entry_price.toLocaleString()}</td>
    <td>${t.exit_time}</td>
    <td>$${t.exit_price.toLocaleString()}</td>
    <td>${t.entry_rsi}</td>
    <td>$${t.bet}</td>
    <td class="${t.result==='WIN'?'win':'loss'}">${pnlStr}</td>
    <td>$${t.balance_after.toFixed(2)}</td>
  </tr>`;
});
th += '</tbody>';
document.getElementById('tradeTable').innerHTML = th;
</script>
</body>
</html>
"""

def build_html(df, trades):
    df["rsi"] = calculate_rsi(df["close"])

    labels = df["open_time"].dt.strftime("%m/%d %H:%M").tolist()
    prices = df["close"].round(2).tolist()
    rsi    = [round(v, 2) if pd.notna(v) else None for v in df["rsi"].tolist()]

    data = {
        "labels"       : labels,
        "prices"       : prices,
        "rsi"          : rsi,
        "trades"       : trades,
        "rsi_os"       : RSI_OVERSOLD,
        "rsi_ob"       : RSI_OVERBOUGHT,
        "start_bal"    : STARTING_BALANCE,
        "target_bal"   : TARGET_BALANCE,
        "total_candles": len(df),
        "candle_from"  : labels[0],
        "candle_to"    : labels[-1],
    }
    html = HTML_TEMPLATE.replace("__DATA__", json.dumps(data))
    return html

# ── MAIN ─────────────────────────────────────────────────────

def main():
    print("\n" + "="*55)
    print("  POLYMARKET RSI BACKTEST CHART")
    print("="*55)

    df     = fetch_candles(interval=5, limit=720)
    trades = run_backtest(df)

    if not trades:
        print("  No trades found in this period. Try adjusting RSI thresholds.")
        return

    print(f"  Found {len(trades)} trades total | Showing last 10 in chart")
    wins = sum(1 for t in trades if t["result"] == "WIN")
    wr   = wins / len(trades) * 100
    pnl  = sum(t["pnl"] for t in trades)
    print(f"  Win Rate: {wr:.1f}%  |  Total P&L: ${pnl:+.2f}")
    print(f"  Final Balance: ${trades[-1]['balance_after']:.2f}")

    # Only keep last 10 for display
    display_trades = trades[-10:]
    html = build_html(df, display_trades)

    with open(OUT_FILE, "w") as f:
        f.write(html)

    print(f"\n  Chart saved -> {OUT_FILE}")
    print("  Opening in browser...")
    webbrowser.open("file:///" + OUT_FILE.replace("\\", "/"))
    print("="*55 + "\n")

if __name__ == "__main__":
    main()
