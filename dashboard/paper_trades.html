<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Paper Trades — Kalshi BTC Bot</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --purple: #a371f7; --orange: #f0883e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; font-size: 14px; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 18px; font-weight: 600; }
  .badge { background: #21262d; border: 1px solid var(--border); border-radius: 12px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 4px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .toolbar { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .tab-group { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .tab { padding: 6px 16px; background: var(--surface); cursor: pointer; transition: background .15s; font-size: 13px; }
  .tab:hover { background: #21262d; }
  .tab.active { background: var(--accent); color: #000; font-weight: 600; }
  .period-group { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-left: auto; }
  .period { padding: 6px 14px; background: var(--surface); cursor: pointer; transition: background .15s; font-size: 13px; }
  .period:hover { background: #21262d; }
  .period.active { background: #21262d; color: var(--accent); font-weight: 600; }
  .main { padding: 20px 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
  .card .val { font-size: 22px; font-weight: 700; }
  .card .sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .green { color: var(--green); } .red { color: var(--red); } .accent { color: var(--accent); } .purple { color: var(--purple); }
  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  @media(max-width:700px){ .chart-row { grid-template-columns: 1fr; } }
  .chart-box { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .chart-box h3 { font-size: 13px; color: var(--muted); margin-bottom: 12px; font-weight: 500; }
  .chart-wrap { position: relative; height: 200px; }
  .table-section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 20px; }
  .table-section h3 { padding: 14px 16px; font-size: 13px; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 500; display: flex; align-items: center; justify-content: space-between; }
  .tbl-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { padding: 10px 12px; text-align: left; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--border); font-weight: 500; white-space: nowrap; }
  td { padding: 9px 12px; border-bottom: 1px solid #21262d; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #21262d44; }
  .pill { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .pill.yes { background: #1e3a2a; color: var(--green); }
  .pill.no { background: #3a1e1e; color: var(--red); }
  .pill.win { background: #1e3a2a; color: var(--green); }
  .pill.loss { background: #3a1e1e; color: var(--red); }
  .pill.open { background: #1e2a3a; color: var(--accent); }
  .pill.m1 { background: #1e2a3a; color: var(--accent); }
  .pill.m2 { background: #2a1e3a; color: var(--purple); }
  .pill.m3 { background: #3a2a1e; color: var(--orange); }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  .reload-btn { padding: 5px 12px; background: #21262d; border: 1px solid var(--border); border-radius: 6px; color: var(--text); cursor: pointer; font-size: 12px; }
  .reload-btn:hover { background: #2d333b; }
  .last-update { font-size: 11px; color: var(--muted); }
  .live-section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  .live-section h3 { font-size: 13px; color: var(--muted); margin-bottom: 12px; font-weight: 500; }
  .live-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .live-card { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12px; }
  .live-card .ticker { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
  .live-card .dist { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
  .live-card .odds { color: var(--muted); }
</style>
</head>
<body>

<header>
  <div><span class="live-dot"></span><span style="font-size:12px;color:var(--muted)">LIVE</span></div>
  <h1>Kalshi BTC Paper Trades</h1>
  <span class="badge">15-min binary</span>
  <span id="lastUpdate" class="last-update">Loading...</span>
  <button class="reload-btn" onclick="loadData()">&#8635; Refresh</button>
</header>

<div class="toolbar">
  <div class="tab-group" id="modeTabs">
    <div class="tab active" data-mode="all">All</div>
    <div class="tab" data-mode="mode1" style="color:var(--accent)">Mode 1</div>
    <div class="tab" data-mode="mode2" style="color:var(--purple)">Mode 2</div>
    <div class="tab" data-mode="mode3" style="color:var(--orange)">Mode 3</div>
  </div>
  <div class="period-group" id="periodTabs">
    <div class="period active" data-period="3">Last 3 Days</div>
    <div class="period" data-period="1">Today</div>
    <div class="period" data-period="2">Yesterday</div>
  </div>
</div>

<div class="main">
  <div class="cards" id="cards"></div>
  <div class="chart-row">
    <div class="chart-box">
      <h3>Bankroll Over Time</h3>
      <div class="chart-wrap"><canvas id="bankrollChart"></canvas></div>
    </div>
    <div class="chart-box">
      <h3>Daily P&amp;L</h3>
      <div class="chart-wrap"><canvas id="pnlChart"></canvas></div>
    </div>
  </div>
  <div id="liveSection"></div>
  <div class="table-section">
    <h3 id="tableTitle"><span>Recent Trades</span><span id="tradeCount" style="color:var(--muted);font-size:12px"></span></h3>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Mode</th><th>Time</th><th>Side</th><th>Strike</th>
            <th>BTC Entry</th><th>Distance</th><th>Bet</th><th>Odds</th>
            <th>P&amp;L</th><th>Bankroll</th><th>Result</th>
          </tr>
        </thead>
        <tbody id="tradeBody"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
const DATA_URLS = [
  'https://raw.githubusercontent.com/InTheNightRaider/tradingbot/main/dashboard/btc_paper_state.json',
  './btc_paper_state.json'
];

let state = null;
let activeMode = 'all';
let activePeriod = 3;
let bankrollChart = null;
let pnlChart = null;

// ── Normalise a trade from state format to display format ──────────
// State fields: entered_at, cost, contractPx, won, pnl, resolved, btcPrice, strike, distance, side, ticker
// Open fields:  entered_at, cost, contractPx, side, btcPrice, strike, distance, ticker
function normaliseTrade(t, modeKey, startBank, runningBank) {
  const isOpen   = !t.resolved;
  const ts       = t.entered_at || t.ts || '';
  const bet      = t.cost   !== undefined ? t.cost   : (t.bet   !== undefined ? t.bet   : null);
  const odds     = t.contractPx !== undefined ? t.contractPx : (t.odds !== undefined ? t.odds : null);
  const btcEntry = t.btcPrice  !== undefined ? t.btcPrice  : (t.btcAtEntry !== undefined ? t.btcAtEntry : null);
  const pnl      = isOpen ? null : (t.pnl !== undefined ? t.pnl : null);
  const bankAfter = isOpen ? null : (t.bankrollAfter !== undefined ? t.bankrollAfter : runningBank);

  return {
    _mode: modeKey,
    ts, bet, odds, btcEntry,
    side:       t.side,
    ticker:     t.ticker,
    strike:     t.strike,
    distance:   t.distance !== undefined ? Number(t.distance) : null,
    pnl,
    bankrollAfter: bankAfter,
    won:        isOpen ? null : (t.won !== undefined ? t.won : null),
    status:     isOpen ? 'open' : 'closed',
  };
}

async function loadData() {
  let data = null;
  for (const url of DATA_URLS) {
    try {
      const res = await fetch(url + '?t=' + Date.now());
      if (res.ok) { data = await res.json(); break; }
    } catch(e) {}
  }
  if (!data) { document.getElementById('lastUpdate').textContent = 'Could not load data'; return; }

  state = data;
  const upd = state.lastUpdate || state._lastUpdated || null;
  document.getElementById('lastUpdate').textContent = upd
    ? 'Updated ' + new Date(upd).toLocaleTimeString()
    : 'Live';
  render();
}

function getDisplayTrades() {
  if (!state) return [];
  const modes = activeMode === 'all' ? ['mode1','mode2','mode3'] : [activeMode];
  const now   = Date.now();
  const cutoff = now - activePeriod * 86400000;
  let all = [];

  for (const mk of modes) {
    const ms = state[mk];
    if (!ms) continue;
    const startBank = mk === 'mode3' ? 0 : 50;

    // Build running bankroll from trades
    let runBank = startBank;
    const closed = (ms.trades || [])
      .slice()
      .sort((a,b) => new Date(a.entered_at||a.ts) - new Date(b.entered_at||b.ts))
      .map(t => {
        runBank += (t.pnl || 0);
        return normaliseTrade(t, mk, startBank, runBank);
      });

    const open = (ms.open || []).map(t => normaliseTrade(t, mk, startBank, null));

    for (const t of [...closed, ...open]) {
      const ts = new Date(t.ts).getTime();
      if (ts >= cutoff) all.push(t);
    }
  }
  return all.sort((a,b) => new Date(b.ts) - new Date(a.ts));
}

function render() {
  if (!state) return;
  renderCards();
  renderCharts();
  renderLive();
  renderTable();
}

function renderCards() {
  const trades = getDisplayTrades();
  const closed = trades.filter(t => t.status === 'closed');
  const wins   = closed.filter(t => t.won).length;
  const wr     = closed.length ? (wins / closed.length * 100).toFixed(1) : '—';
  const pnl    = closed.reduce((s,t) => s + (t.pnl || 0), 0);
  const openCt = trades.filter(t => t.status === 'open').length;

  const m1 = state.mode1?.bankroll ?? 50;
  const m2 = state.mode2?.bankroll ?? 50;

  const cardDefs = [
    { label:'Trades', val: closed.length, sub: openCt ? openCt + ' open' : 'all closed', cls:'' },
    { label:'Win Rate', val: wr + '%', sub: wins + 'W / ' + (closed.length - wins) + 'L', cls: parseFloat(wr) >= 60 ? 'green' : 'red' },
    { label:'Net P&L', val: (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2), sub: 'period total', cls: pnl >= 0 ? 'green' : 'red' },
    activeMode === 'all'
      ? { label:'Bankrolls', val: '$' + (m1+m2).toFixed(2), sub: 'M1 $' + m1.toFixed(2) + ' / M2 $' + m2.toFixed(2), cls: 'accent' }
      : { label:'Bankroll', val: '$' + (state[activeMode]?.bankroll ?? 0).toFixed(2), sub: 'current', cls: 'accent' }
  ];

  document.getElementById('cards').innerHTML = cardDefs.map(c => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="val ${c.cls}">${c.val}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
}

function renderCharts() {
  const modes = activeMode === 'all' ? ['mode1','mode2','mode3'] : [activeMode];
  const modeColors = { mode1:'#58a6ff', mode2:'#a371f7', mode3:'#f0883e' };
  const modeLabels = { mode1:'Mode 1', mode2:'Mode 2', mode3:'Mode 3' };
  const cutoff = Date.now() - activePeriod * 86400000;

  // Bankroll chart
  const datasets = [];
  for (const mk of modes) {
    const ms = state[mk]; if (!ms) continue;
    const startBank = mk === 'mode3' ? 0 : 50;
    let rb = startBank;
    const pts = (ms.trades||[])
      .slice().sort((a,b)=>new Date(a.entered_at||a.ts)-new Date(b.entered_at||b.ts))
      .filter(t => new Date(t.entered_at||t.ts).getTime() >= cutoff)
      .map(t => { rb += (t.pnl||0); return { x: new Date(t.entered_at||t.ts).toLocaleString(), y: +rb.toFixed(2) }; });
    if (!pts.length) continue;
    datasets.push({ label: modeLabels[mk], data: pts, borderColor: modeColors[mk],
      backgroundColor: modeColors[mk]+'22', fill: true, tension:0.3,
      pointRadius:3, pointHoverRadius:5, borderWidth:2 });
  }
  if (bankrollChart) bankrollChart.destroy();
  bankrollChart = new Chart(document.getElementById('bankrollChart').getContext('2d'), {
    type:'line', data:{ datasets },
    options:{ responsive:true, maintainAspectRatio:false, parsing:false,
      scales:{
        x:{ type:'category', ticks:{color:'#8b949e',maxTicksLimit:6,maxRotation:0}, grid:{color:'#30363d'} },
        y:{ ticks:{color:'#8b949e',callback:v=>'$'+v.toFixed(0)}, grid:{color:'#30363d'} }
      },
      plugins:{ legend:{labels:{color:'#e6edf3',boxWidth:12}} }
    }
  });

  // Daily P&L bar
  const dayMap = {};
  for (const mk of modes) {
    const ms = state[mk]; if (!ms) continue;
    for (const t of ms.trades||[]) {
      const tms = new Date(t.entered_at||t.ts).getTime();
      if (tms < cutoff) continue;
      const day = new Date(t.entered_at||t.ts).toLocaleDateString('en-US',{month:'short',day:'numeric'});
      const key = mk + '|' + day;
      dayMap[key] = (dayMap[key]||0) + (t.pnl||0);
    }
  }
  const days = [...new Set(Object.keys(dayMap).map(k=>k.split('|')[1]))]
    .sort((a,b)=>new Date(a)-new Date(b));
  const pnlDatasets = modes.map(mk => ({
    label: modeLabels[mk],
    data: days.map(d => +(dayMap[mk+'|'+d]||0).toFixed(2)),
    backgroundColor: days.map(d => (dayMap[mk+'|'+d]||0) >= 0 ? modeColors[mk]+'bb' : modeColors[mk]+'44'),
    borderColor: modeColors[mk], borderWidth:1, borderRadius:4
  }));
  if (pnlChart) pnlChart.destroy();
  pnlChart = new Chart(document.getElementById('pnlChart').getContext('2d'), {
    type:'bar', data:{ labels:days, datasets:pnlDatasets },
    options:{ responsive:true, maintainAspectRatio:false,
      scales:{
        x:{ ticks:{color:'#8b949e'}, grid:{color:'#30363d'} },
        y:{ ticks:{color:'#8b949e',callback:v=>'$'+v.toFixed(0)}, grid:{color:'#30363d'} }
      },
      plugins:{ legend:{labels:{color:'#e6edf3',boxWidth:12}} }
    }
  });
}

function renderLive() {
  const live = state?.liveMarket;
  const el   = document.getElementById('liveSection');
  if (!live || !live.markets?.length) { el.innerHTML=''; return; }

  const cards = live.markets.slice(0,6).map(m => {
    const dist  = Number(m.distance);
    const distStr = (dist>=0?'+':'')+dist.toFixed(0);
    const yesPct  = Math.round(Number(m.yesMid)*100);
    const noPct   = Math.round(Number(m.noMid)*100);
    const minIn   = Number(m.minutesIn).toFixed(1);
    const minLeft = Number(m.minutesLeft).toFixed(0);
    const cls     = dist >= 0 ? 'green' : 'red';
    return `<div class="live-card">
      <div class="ticker">${m.ticker.split('-').slice(-2).join('-')}</div>
      <div class="dist ${cls}">${distStr} from strike</div>
      <div class="odds">YES ${yesPct}¢ / NO ${noPct}¢ &nbsp;·&nbsp; ${minIn}m in / ${minLeft}m left</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="live-section">
    <h3>Live Markets &nbsp;·&nbsp; BTC $${Number(live.btcPrice).toLocaleString()} &nbsp;·&nbsp; RSI 1m ${Number(live.rsi1m).toFixed(1)} / 5m ${Number(live.rsi5m).toFixed(1)}</h3>
    <div class="live-grid">${cards}</div>
  </div>`;
}

function renderTable() {
  const trades = getDisplayTrades();
  const modeLabels = { mode1:'M1', mode2:'M2', mode3:'M3' };
  document.getElementById('tradeCount').textContent = trades.length + ' trades';

  if (!trades.length) {
    document.getElementById('tradeBody').innerHTML =
      `<tr><td colspan="11" class="empty">No trades yet in this window. Start the bot to see live data.</td></tr>`;
    return;
  }

  const rows = trades.map(t => {
    const m   = t._mode || 'mode1';
    const mCls = m === 'mode1' ? 'm1' : m === 'mode2' ? 'm2' : 'm3';
    const time = t.ts ? new Date(t.ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '—';
    const side = t.side || '—';
    const strike   = t.strike  != null ? '$' + Number(t.strike).toLocaleString()  : '—';
    const btcEntry = t.btcEntry!= null ? '$' + Number(t.btcEntry).toLocaleString() : '—';
    const dist     = t.distance!= null ? (t.distance>=0?'+':'')+t.distance.toFixed(0) : '—';
    const bet      = t.bet     != null ? '$' + Number(t.bet).toFixed(2) : '—';
    const odds     = t.odds    != null ? Math.round(t.odds*100)+'¢' : '—';
    const pnl      = t.pnl     != null
      ? `<span class="${t.pnl>=0?'green':'red'}">${t.pnl>=0?'+':'-'}$${Math.abs(t.pnl).toFixed(2)}</span>`
      : '<span style="color:var(--muted)">pending</span>';
    const bank   = t.bankrollAfter != null ? '$'+Number(t.bankrollAfter).toFixed(2) : '—';
    const result = t.status === 'open'
      ? `<span class="pill open">OPEN</span>`
      : t.won
        ? `<span class="pill win">WIN</span>`
        : `<span class="pill loss">LOSS</span>`;
    return `<tr>
      <td><span class="pill ${mCls}">${modeLabels[m]}</span></td>
      <td>${time}</td>
      <td><span class="pill ${side==='YES'?'yes':'no'}">${side}</span></td>
      <td>${strike}</td><td>${btcEntry}</td><td>${dist}</td>
      <td>${bet}</td><td>${odds}</td><td>${pnl}</td><td>${bank}</td>
      <td>${result}</td>
    </tr>`;
  });
  document.getElementById('tradeBody').innerHTML = rows.join('');
}

document.querySelectorAll('#modeTabs .tab').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#modeTabs .tab').forEach(t=>t.classList.remove('active'));
    el.classList.add('active');
    activeMode = el.dataset.mode;
    render();
  });
});
document.querySelectorAll('#periodTabs .period').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#periodTabs .period').forEach(t=>t.classList.remove('active'));
    el.classList.add('active');
    activePeriod = parseInt(el.dataset.period);
    render();
  });
});

loadData();
setInterval(loadData, 60000);
</script>
</body>
</html>