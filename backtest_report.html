<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kalshi Bot — 90-Day Backtest Report</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d0f14;
    --card: #161b25;
    --border: #232a38;
    --text: #e2e8f0;
    --sub: #8892a4;
    --green: #00d4aa;
    --red: #ff4d6d;
    --yellow: #f7931a;
    --blue: #4f8ef7;
    --purple: #e040fb;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px 24px; }
  h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: var(--sub); font-size: 0.9rem; margin-bottom: 32px; }
  
  /* STAT CARDS */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; }
  .stat-card .label { font-size: 0.72rem; color: var(--sub); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  .stat-card .value { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat-card .value.pos { color: var(--green); }
  .stat-card .value.neg { color: var(--red); }
  .stat-card .value.neutral { color: var(--text); }
  
  /* CHARTS */
  .chart-section { margin-bottom: 32px; }
  .section-title { font-size: 1rem; font-weight: 600; margin-bottom: 16px; color: var(--sub); text-transform: uppercase; letter-spacing: .08em; }
  .chart-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 16px; }
  .chart-card h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 4px; }
  .chart-card .chart-meta { font-size: 0.78rem; color: var(--sub); margin-bottom: 16px; }
  .chart-container { position: relative; height: 220px; }
  
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 700px) { .grid-2 { grid-template-columns: 1fr; } }
  
  /* TABLE */
  .table-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #1e2535; }
  th { padding: 12px 16px; text-align: left; font-size: 0.75rem; color: var(--sub); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  td { padding: 14px 16px; font-size: 0.88rem; border-top: 1px solid var(--border); }
  tr:last-child { background: #1a2030; font-weight: 700; }
  td.pos { color: var(--green); }
  td.neg { color: var(--red); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  
  /* DISCLAIMER */
  .disclaimer { font-size: 0.75rem; color: var(--sub); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; line-height: 1.5; }
  .disclaimer strong { color: var(--text); }
</style>
</head>
<body>

<h1>90-Day Backtest Report</h1>
<p class="subtitle">Feb 15 – May 16, 2026 &nbsp;·&nbsp; Kalshi Multi-Strategy Bot &nbsp;·&nbsp; $50.00 starting bankroll ($12.50 per strategy)</p>

<!-- TOP STATS -->
<div class="stat-grid">
  <div class="stat-card">
    <div class="label">Total P&amp;L</div>
    <div class="value pos">$+10.12</div>
  </div>
  <div class="stat-card">
    <div class="label">Portfolio ROI</div>
    <div class="value pos">+20.2%</div>
  </div>
  <div class="stat-card">
    <div class="label">Final Balance</div>
    <div class="value neutral">$60.12</div>
  </div>
  <div class="stat-card">
    <div class="label">Total Trades</div>
    <div class="value neutral">522</div>
  </div>
  <div class="stat-card">
    <div class="label">Overall Win Rate</div>
    <div class="value pos">60.2%</div>
  </div>
  <div class="stat-card">
    <div class="label">Best Strategy</div>
    <div class="value pos">News RSS</div>
  </div>
</div>

<!-- COMBINED CURVE -->
<div class="chart-section">
  <div class="section-title">Portfolio Performance</div>
  <div class="chart-card">
    <h3>Combined Balance — All 4 Strategies</h3>
    <div class="chart-meta">Starting $50.00 &nbsp;→&nbsp; Final $60.12 &nbsp;(+10.12 / +20.2%)</div>
    <div class="chart-container">
      <canvas id="combinedChart"></canvas>
    </div>
  </div>
</div>

<!-- INDIVIDUAL CURVES -->
<div class="chart-section">
  <div class="section-title">Individual Strategy Curves</div>
  <div class="grid-2">
    <div class="chart-card">
      <h3 style="color:#f7931a">⬡ BTC / RSI Momentum</h3>
      <div class="chart-meta">9 trades · 100% WR · <span style="color:#00d4aa">+9.35 (+74.8%)</span></div>
      <div class="chart-container"><canvas id="btcChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3 style="color:#00d4aa">⚽ Sports Momentum</h3>
      <div class="chart-meta">185 trades · 61% WR · <span style="color:#ff4d6d">-9.49 (-75.9%)</span></div>
      <div class="chart-container"><canvas id="sportsChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3 style="color:#4f8ef7">📊 Economics / Macro</h3>
      <div class="chart-meta">118 trades · 58% WR · <span style="color:#ff4d6d">-0.84 (-6.7%)</span></div>
      <div class="chart-container"><canvas id="econChart"></canvas></div>
    </div>
    <div class="chart-card">
      <h3 style="color:#e040fb">📰 News RSS</h3>
      <div class="chart-meta">210 trades · 59% WR · <span style="color:#00d4aa">+11.11 (+88.9%)</span></div>
      <div class="chart-container"><canvas id="newsChart"></canvas></div>
    </div>
  </div>
</div>

<!-- SUMMARY TABLE -->
<div class="chart-section">
  <div class="section-title">Summary Table</div>
  <div class="table-card">
    <table>
      <thead>
        <tr>
          <th>Strategy</th>
          <th>Trades</th>
          <th>Win Rate</th>
          <th>Start</th>
          <th>Final Balance</th>
          <th>Total P&amp;L</th>
          <th>ROI</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><span class="dot" style="background:#f7931a"></span>BTC / RSI Momentum</td>
          <td>9</td>
          <td>100.0%</td>
          <td>$12.50</td>
          <td>$21.85</td>
          <td class="pos">$+9.35</td>
          <td class="pos">+74.8%</td>
        </tr>
        <tr>
          <td><span class="dot" style="background:#00d4aa"></span>Sports Momentum</td>
          <td>185</td>
          <td>61.1%</td>
          <td>$12.50</td>
          <td>$3.01</td>
          <td class="neg">$-9.49</td>
          <td class="neg">-75.9%</td>
        </tr>
        <tr>
          <td><span class="dot" style="background:#4f8ef7"></span>Economics / Macro</td>
          <td>118</td>
          <td>57.6%</td>
          <td>$12.50</td>
          <td>$11.66</td>
          <td class="neg">$-0.84</td>
          <td class="neg">-6.7%</td>
        </tr>
        <tr>
          <td><span class="dot" style="background:#e040fb"></span>News RSS</td>
          <td>210</td>
          <td>59.0%</td>
          <td>$12.50</td>
          <td>$23.61</td>
          <td class="pos">$+11.11</td>
          <td class="pos">+88.9%</td>
        </tr>
        <tr>
          <td><span class="dot" style="background:#ffffff"></span>COMBINED PORTFOLIO</td>
          <td>522</td>
          <td>60.2%</td>
          <td>$50.00</td>
          <td>$60.12</td>
          <td class="pos">$+10.12</td>
          <td class="pos">+20.2%</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

<div class="disclaimer">
  <strong>Simulation notes:</strong> BTC/RSI uses real Kraken OHLC price data (Feb–May 2026). Sports, Economics, and News RSS use deterministic Monte Carlo simulation calibrated to each strategy's expected win rate and trade frequency. Kelly fraction = 0.25 (fractional Kelly). Fees modeled at 7% per contract. Sports bot shows high drawdown due to dense trade frequency (~2/day) and Kelly variance on a small bankroll — live bot caps at 4 concurrent positions which limits this effect. Past simulation results do not guarantee future performance.
</div>

<script>
const labels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90];
const btcData = [12.5, 12.5, 12.5, 12.5, 12.5, 13.3, 13.3, 13.3, 13.3, 13.3, 13.3, 13.3, 13.3, 13.3, 13.3, 13.3, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 14.15, 15.06, 15.06, 15.06, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 16.02, 17.05, 17.05, 17.05, 17.05, 17.05, 18.14, 18.14, 19.3, 19.3, 19.3, 19.3, 19.3, 19.3, 19.3, 19.3, 19.3, 20.54, 20.54, 20.54, 20.54, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85, 21.85];
const sportsData = [12.5, 12.83, 13.54, 14.05, 13.54, 13.05, 13.63, 12.1, 11.36, 12.29, 11.81, 11.8, 12.77, 12.77, 12.3, 11.87, 11.39, 11.62, 12.69, 12.56, 13.06, 13.48, 12.58, 13.86, 10.97, 10.5, 10.22, 11.93, 11.69, 11.71, 12.53, 13.32, 13.23, 13.93, 11.7, 11.22, 9.75, 9.7, 9.58, 9.07, 8.08, 8.14, 7.7, 7.4, 7.39, 6.4, 6.74, 7.9, 8.63, 7.95, 7.72, 7.42, 7.01, 7.69, 7.42, 7.44, 7.15, 7.55, 8.37, 8.59, 9.14, 7.99, 7.73, 8.1, 8.64, 7.95, 8.39, 8.2, 7.9, 8.52, 8.28, 9.12, 8.61, 8.61, 9.48, 9.44, 10.35, 9.76, 10.08, 10.02, 9.35, 9.46, 8.23, 9.01, 9.34, 7.72, 5.78, 5.59, 5.07, 4.04, 3.01];
const econData = [12.5, 12.5, 13.86, 13.84, 12.99, 14.0, 14.39, 15.15, 14.36, 14.03, 14.51, 14.51, 15.22, 14.71, 15.15, 13.64, 13.64, 13.64, 13.13, 14.69, 13.77, 13.25, 13.75, 13.56, 13.42, 12.71, 12.01, 12.75, 13.0, 13.4, 14.58, 13.8, 13.37, 12.97, 12.29, 12.8, 13.83, 14.14, 14.8, 14.13, 13.82, 14.68, 14.12, 15.46, 16.37, 15.85, 14.82, 15.42, 16.82, 15.97, 17.43, 16.68, 16.16, 15.22, 15.28, 16.08, 15.52, 16.11, 14.97, 14.21, 14.7, 14.33, 14.17, 14.55, 14.03, 14.31, 14.77, 15.52, 16.15, 16.15, 16.15, 15.74, 15.08, 14.56, 13.23, 13.87, 12.16, 11.27, 11.8, 11.07, 11.96, 12.95, 12.25, 12.21, 11.4, 11.81, 11.43, 11.71, 11.19, 11.85, 11.66];
const newsData = [12.5, 12.53, 12.87, 13.34, 14.33, 13.81, 13.55, 12.49, 13.49, 11.63, 12.63, 10.95, 11.44, 12.39, 12.99, 14.31, 14.27, 14.64, 15.24, 16.57, 19.15, 21.26, 19.95, 21.41, 20.33, 22.02, 22.19, 23.62, 22.1, 24.89, 27.08, 27.03, 25.52, 27.89, 28.78, 27.83, 28.17, 29.92, 32.17, 33.28, 32.09, 29.94, 30.85, 30.39, 33.07, 27.9, 28.15, 27.48, 27.48, 27.12, 27.02, 28.11, 28.11, 32.62, 30.45, 32.86, 36.97, 35.7, 38.48, 36.09, 35.76, 36.8, 32.16, 31.87, 30.23, 30.92, 28.01, 28.06, 26.24, 26.24, 23.79, 27.96, 27.84, 29.1, 27.7, 28.27, 28.19, 27.19, 28.78, 29.92, 30.62, 28.11, 30.75, 28.57, 27.82, 27.19, 26.45, 23.75, 24.46, 25.31, 23.61];
const combinedData = [50.0, 50.36, 52.769999999999996, 53.730000000000004, 53.36, 54.160000000000004, 54.870000000000005, 53.04, 52.51, 51.25, 52.25, 50.56, 52.73, 53.17, 53.74, 53.120000000000005, 53.45, 54.05, 55.21, 57.97, 60.13, 62.14, 60.43000000000001, 62.980000000000004, 58.87, 59.379999999999995, 58.57000000000001, 62.45, 60.940000000000005, 65.06, 69.25, 69.21000000000001, 68.14, 70.81, 68.78999999999999, 67.87, 67.77000000000001, 69.78, 72.57000000000001, 72.5, 70.01, 68.78, 68.69, 69.27000000000001, 72.85, 67.2, 66.75999999999999, 67.85000000000001, 69.98, 68.09, 70.31, 70.35, 70.58, 74.83, 72.45, 75.68, 78.94, 78.66, 81.12, 78.19, 78.9, 79.66, 74.6, 75.06, 73.44, 75.03, 73.02000000000001, 73.63, 72.14, 72.75999999999999, 70.07, 74.67, 73.38, 74.12, 72.26, 73.42999999999999, 72.55, 70.07, 72.51, 72.86, 73.78, 72.37, 73.08, 71.64, 70.41, 68.57000000000001, 65.51, 62.900000000000006, 62.57, 63.05, 60.129999999999995];

const gridColor = 'rgba(255,255,255,0.05)';
const tickColor = '#8892a4';

function makeChart(id, label, data, color, showFill=false) {
  const ctx = document.getElementById(id).getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, color + '33');
  gradient.addColorStop(1, color + '00');
  
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label,
        data,
        borderColor: color,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: showFill,
        backgroundColor: showFill ? gradient : 'transparent',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e2535',
          borderColor: color,
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: '#8892a4',
          callbacks: {
            label: ctx => ` $` + ctx.parsed.y.toFixed(2)
          }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: tickColor, maxTicksLimit: 10, font: { size: 11 } },
          title: { display: true, text: 'Day', color: tickColor, font: { size: 11 } }
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { size: 11 }, callback: v => '$' + v.toFixed(0) },
        }
      }
    }
  });
}

makeChart('combinedChart', 'Portfolio', combinedData, '#ffffff', true);
makeChart('btcChart', 'BTC/RSI', btcData, '#f7931a', true);
makeChart('sportsChart', 'Sports', sportsData, '#00d4aa', true);
makeChart('econChart', 'Economics', econData, '#4f8ef7', true);
makeChart('newsChart', 'News RSS', newsData, '#e040fb', true);
</script>
</body>
</html>