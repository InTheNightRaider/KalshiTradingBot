#!/usr/bin/env python3
"""
IBKR RSI Strategy Backtester
==============================
Tests the same RSI strategy as ibkr_bot.py against 2+ years of real
historical data across all configured instruments.

Data sources (free, no API key):
  Crypto : Binance vision API (BTCUSDT, ETHUSDT) — up to 3 years of 1h bars
  Forex  : yfinance (EURUSD=X, GBPUSD=X, USDJPY=X) — up to 2 years of 1h bars

Output:
  ibkr_backtest_report.html — equity curves, drawdown, per-instrument stats,
                               trade log, monthly P&L bar chart

Usage:
  python ibkr_backtest.py              # 2-year backtest, all instruments
  python ibkr_backtest.py --days 365   # 1-year backtest
  python ibkr_backtest.py --days 90    # quick 90-day test
  python ibkr_backtest.py --fresh      # ignore cache, re-download all data
"""

import os, sys, time, json, math, argparse, requests
import pandas as pd
from datetime import datetime
from pathlib import Path

try:
    import yfinance as yf
except ImportError:
    print("Installing yfinance...", flush=True)
    os.system(f'{sys.executable} -m pip install yfinance --quiet')
    import yfinance as yf

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent
CACHE_DIR  = BASE_DIR / 'backtest_data'
REPORT_OUT = BASE_DIR / 'ibkr_backtest_report.html'
CACHE_DIR.mkdir(exist_ok=True)

# ── Strategy Config (mirrors ibkr_config.py / ibkr_bot.py) ───────────────────
RSI_PERIOD     = 14
KELLY_FRACTION = 0.08
MIN_POS_USD    = 500.0
MAX_POS_USD    = 3_000.0
STARTING_BAL   = 10_000.0
HOLD_HOURS     = 4       # hours to hold a position (live bot uses 1h; 4h gives
                         # trades more room to play out in the backtest)
CANDLE_HOURS   = 1       # 1h candles throughout
HOLD_CANDLES   = HOLD_HOURS // CANDLE_HOURS

# Instruments: (display_name, data_source, fetch_key, rsi_oversold, rsi_overbought)
# RSI thresholds tuned per asset class:
#   Crypto: 27/77  — high volatility, extreme RSI is meaningful
#   Forex : 35/65  — lower volatility, 27/77 rarely triggers
INSTRUMENTS = [
    ('BTC_Futures', 'binance', 'BTCUSDT',  27, 77),
    ('ETH_Spot',    'binance', 'ETHUSDT',  27, 77),
    ('EUR_USD',     'yfinance', 'EURUSD=X', 35, 65),
    ('GBP_USD',     'yfinance', 'GBPUSD=X', 35, 65),
    ('USD_JPY',     'yfinance', 'USDJPY=X', 35, 65),
]


# ─────────────────────────────────────────────────────────────────────────────
# DATA FETCHING
# ─────────────────────────────────────────────────────────────────────────────

def binance_fetch_1h(symbol, days):
    """Download 1h OHLCV from Binance vision API (geo-unrestricted, no key)."""
    cache = CACHE_DIR / f'binance_{symbol}_{days}d.csv'
    end_ms   = int(time.time() * 1000)
    start_ms = end_ms - days * 86_400_000
    all_bars, current, batch = [], start_ms, 0

    print(f"  Downloading Binance {symbol} ({days}d) ...", end='', flush=True)
    while current < end_ms:
        try:
            r = requests.get(
                'https://data-api.binance.vision/api/v3/klines',
                params={'symbol': symbol, 'interval': '1h',
                        'startTime': current, 'limit': 1000},
                timeout=12)
            bars = r.json()
        except Exception as e:
            print(f'\n  Error: {e}')
            break
        if not bars or isinstance(bars, dict):
            break
        all_bars.extend(bars)
        current = bars[-1][0] + 3_600_000
        batch += 1
        if batch % 5 == 0:
            print('.', end='', flush=True)
        time.sleep(0.08)

    print(f' {len(all_bars)} bars', flush=True)
    df = pd.DataFrame(all_bars, columns=[
        'open_time','open','high','low','close','volume',
        'close_time','qv','trades','tbv','tqv','ignore'])
    if df.empty:
        return df
    df['open_time'] = pd.to_datetime(df['open_time'], unit='ms', utc=True)
    for col in ['open','high','low','close']:
        df[col] = df[col].astype(float)
    df = df[['open_time','open','high','low','close']].drop_duplicates('open_time')
    df = df.sort_values('open_time').reset_index(drop=True)
    df.to_csv(cache, index=False)
    return df


def yfinance_fetch_1h(ticker, days):
    """Download 1h OHLCV from yfinance (no key, up to 730 days)."""
    cache = CACHE_DIR / f'yf_{ticker.replace("=","_")}_{days}d.csv'
    print(f"  Downloading yfinance {ticker} ({days}d) ...", end='', flush=True)
    try:
        raw = yf.download(ticker, interval='1h', period=f'{min(days,729)}d',
                          auto_adjust=True, progress=False)
    except Exception as e:
        print(f' ERROR: {e}', flush=True)
        return pd.DataFrame()

    if raw.empty:
        print(' no data', flush=True)
        return pd.DataFrame()

    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)

    raw = raw.reset_index()
    tc = 'Datetime' if 'Datetime' in raw.columns else raw.columns[0]
    raw = raw.rename(columns={tc:'open_time','Open':'open',
                               'High':'high','Low':'low','Close':'close'})
    df = raw[['open_time','open','high','low','close']].copy()
    df['open_time'] = pd.to_datetime(df['open_time'], utc=True)
    df = df.dropna().drop_duplicates('open_time').sort_values('open_time').reset_index(drop=True)
    print(f' {len(df)} bars', flush=True)
    df.to_csv(cache, index=False)
    return df


def load_or_fetch(name, source, key, days, fresh):
    """Load from cache if fresh enough, otherwise download."""
    slug  = key.replace('=','_')
    cache = CACHE_DIR / (f'binance_{key}_{days}d.csv' if source == 'binance'
                         else f'yf_{slug}_{days}d.csv')
    if not fresh and cache.exists():
        age_h = (time.time() - cache.stat().st_mtime) / 3600
        if age_h < 12:
            df = pd.read_csv(cache, parse_dates=['open_time'])
            df['open_time'] = pd.to_datetime(df['open_time'], utc=True)
            print(f"  Loaded {name} from cache ({len(df)} bars, {age_h:.1f}h old)",
                  flush=True)
            return df
    return binance_fetch_1h(key, days) if source == 'binance' else yfinance_fetch_1h(key, days)


# ─────────────────────────────────────────────────────────────────────────────
# RSI STRATEGY  (exact same logic as ibkr_bot.py)
# ─────────────────────────────────────────────────────────────────────────────

def calc_rsi(series, period=RSI_PERIOD):
    d = series.diff()
    g = d.clip(lower=0).ewm(com=period-1, min_periods=period).mean()
    l = (-d).clip(lower=0).ewm(com=period-1, min_periods=period).mean()
    return 100 - (100 / (1 + g / l.replace(0, float('nan'))))

def calc_sma(series, period=50):
    return series.rolling(window=period, min_periods=period).mean()

def kelly_size(balance, confidence):
    return max(MIN_POS_USD, min(MAX_POS_USD, balance * KELLY_FRACTION * confidence))


# ─────────────────────────────────────────────────────────────────────────────
# BACKTEST ENGINE  (vectorised — O(n), not O(n²))
# ─────────────────────────────────────────────────────────────────────────────

def run_backtest(name, df, oversold, overbought):
    df = df.reset_index(drop=True)
    n  = len(df)

    rsi  = calc_rsi(df['close']).values
    sma  = calc_sma(df['close']).values
    cls  = df['close'].values
    opn  = df['open'].values
    ts   = df['open_time'].values

    WARMUP   = max(RSI_PERIOD + 2, 52)
    balance  = STARTING_BAL
    trades, equity = [], []
    in_pos   = False
    pos      = {}

    for i in range(n):
        if i % 24 == 0:
            equity.append({'ts': str(ts[i])[:19], 'balance': round(balance, 2)})

        # Close position
        if in_pos and i >= pos['exit_idx']:
            ep     = opn[i]
            pct    = (ep - pos['entry']) / pos['entry']
            dire   = 1 if pos['action'] == 'BUY' else -1
            pnl    = pos['size'] * pct * dire
            balance += pnl
            in_pos  = False
            trades.append({
                'entry_ts':    pos['entry_ts'],
                'exit_ts':     str(ts[i])[:19],
                'action':      pos['action'],
                'entry_price': round(pos['entry'], 6),
                'exit_price':  round(ep, 6),
                'size_usd':    round(pos['size'], 2),
                'pnl':         round(pnl, 2),
                'balance':     round(balance, 2),
                'confidence':  pos['conf'],
                'rsi_entry':   round(pos['rsi'], 2),
                'won':         pnl > 0,
            })

        # Check for signal
        if not in_pos and i >= WARMUP and i + 1 < n:
            rv, rp = rsi[i], rsi[i-1]
            sv, pr = sma[i], cls[i]
            green  = cls[i] > opn[i]

            if rv != rv:   # NaN check
                continue

            sig = None

            # Capitulation bounce (crypto only)
            if oversold <= 30 and rv < 22 and i >= 2:
                if rsi[i] > rsi[i-1] > rsi[i-2]:
                    sig = ('BUY', 0.5)

            if sig is None:
                with_trend = not (sv != sv) and pr >= sv
                if rv < oversold and rv > rp and green:
                    sig = ('BUY', 1.0 if with_trend else 0.5)
                elif rv > overbought and rv < rp and not green:
                    sig = ('SELL', 1.0 if not with_trend else 0.5)

            if sig:
                action, conf = sig
                in_pos = True
                pos = {
                    'action':   action,
                    'entry':    opn[i + 1],
                    'entry_ts': str(ts[i + 1])[:19],
                    'exit_idx': i + 1 + HOLD_CANDLES,
                    'size':     kelly_size(balance, conf),
                    'conf':     conf,
                    'rsi':      rv,
                }

    return {'trades': trades, 'equity': equity, 'final_balance': balance}


# ─────────────────────────────────────────────────────────────────────────────
# STATISTICS
# ─────────────────────────────────────────────────────────────────────────────

def compute_stats(result, name, days):
    trades = result['trades']
    equity = result['equity']
    final  = result['final_balance']

    if not trades:
        return {'name': name, 'trades': 0, 'error': 'No trades fired'}

    pnls    = [t['pnl'] for t in trades]
    wins    = [p for p in pnls if p > 0]
    losses  = [p for p in pnls if p <= 0]
    wr      = len(wins) / len(pnls) * 100
    avg_win = sum(wins)   / len(wins)   if wins   else 0.0
    avg_los = sum(losses) / len(losses) if losses else 0.0
    gl      = abs(sum(losses))
    pf      = round(min(sum(wins) / gl, 99.9), 2) if gl > 0 else 99.9

    # Max drawdown
    peak, max_dd, bal = STARTING_BAL, 0.0, STARTING_BAL
    for t in trades:
        bal += t['pnl']
        peak = max(peak, bal)
        max_dd = max(max_dd, (peak - bal) / peak * 100)

    total_ret = (final - STARTING_BAL) / STARTING_BAL * 100
    years     = days / 365
    cagr      = ((final / STARTING_BAL) ** (1 / years) - 1) * 100 if years > 0 else 0

    # Sharpe (hourly bars, annualised)
    bals  = pd.Series([e['balance'] for e in equity])
    rets  = bals.pct_change().dropna()
    sh    = round((rets.mean() / rets.std()) * math.sqrt(24 * 365), 3) \
            if len(rets) > 1 and rets.std() > 0 else 0.0

    monthly = {}
    for t in trades:
        k = t['entry_ts'][:7]
        monthly[k] = monthly.get(k, 0) + t['pnl']

    return {
        'name':             name,
        'trades':           len(trades),
        'win_rate':         round(wr, 1),
        'avg_win':          round(avg_win, 2),
        'avg_loss':         round(avg_los, 2),
        'profit_factor':    pf,
        'total_return_pct': round(total_ret, 2),
        'cagr_pct':         round(cagr, 2),
        'sharpe':           sh,
        'max_drawdown_pct': round(max_dd, 2),
        'calmar':           round(cagr / max_dd, 2) if max_dd > 0 else 0,
        'final_balance':    round(final, 2),
        'trades_per_month': round(len(trades) / max(1, days / 30), 1),
        'monthly_pnl':      monthly,
        'trade_log':        trades[-50:],
    }


def combine_equity_curves(all_results):
    dfs = []
    for r in all_results:
        eq = r.get('equity', [])
        if not eq:
            continue
        tmp = pd.DataFrame(eq)
        tmp['ts'] = pd.to_datetime(tmp['ts'])
        tmp = tmp.set_index('ts').rename(columns={'balance': r['name']})
        dfs.append(tmp)
    if not dfs:
        return []
    combined = pd.concat(dfs, axis=1).ffill().dropna()
    combined['portfolio'] = combined.mean(axis=1)
    return [{'ts': str(ts)[:19], 'balance': round(v, 2)}
            for ts, v in combined['portfolio'].items()]


# ─────────────────────────────────────────────────────────────────────────────
# HTML REPORT
# ─────────────────────────────────────────────────────────────────────────────

def generate_report(all_stats, portfolio_eq, days):
    COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4']

    # Equity curve datasets
    eq_datasets = []
    for idx, s in enumerate(all_stats):
        eq = s.get('equity_curve', [])
        color = COLORS[idx % len(COLORS)]
        eq_datasets.append({
            'label':           s['name'],
            'data':            [{'x': e['ts'], 'y': e['balance']} for e in eq],
            'borderColor':     color,
            'backgroundColor': color + '22',
            'borderWidth':     1.5,
            'pointRadius':     0,
            'tension':         0.3,
        })

    if portfolio_eq:
        eq_datasets.insert(0, {
            'label':           'PORTFOLIO',
            'data':            [{'x': e['ts'], 'y': e['balance']} for e in portfolio_eq],
            'borderColor':     '#ffffff',
            'backgroundColor': '#ffffff22',
            'borderWidth':     2.5,
            'pointRadius':     0,
            'tension':         0.3,
        })

    # Monthly P&L
    all_monthly = {}
    for s in all_stats:
        for mo, pnl in s.get('monthly_pnl', {}).items():
            all_monthly[mo] = all_monthly.get(mo, 0) + pnl
    months_sorted = sorted(all_monthly.keys())
    monthly_vals  = [round(all_monthly[m], 2) for m in months_sorted]

    # Stats table rows
    def pc(v):
        return '#10b981' if v > 0 else ('#ef4444' if v < 0 else '#6b7280')

    stat_rows = ''
    for s in all_stats:
        if 'error' in s:
            stat_rows += f'<tr><td>{s["name"]}</td><td colspan="10" style="color:#ef4444">{s["error"]}</td></tr>\n'
            continue
        stat_rows += (
            f'<tr>'
            f'<td><strong>{s["name"]}</strong></td>'
            f'<td>{s["trades"]}</td>'
            f'<td>{s["trades_per_month"]}/mo</td>'
            f'<td style="color:{pc(s["win_rate"]-50)}">{s["win_rate"]}%</td>'
            f'<td style="color:#10b981">${s["avg_win"]:.2f}</td>'
            f'<td style="color:#ef4444">${s["avg_loss"]:.2f}</td>'
            f'<td>{s["profit_factor"]}x</td>'
            f'<td style="color:{pc(s["total_return_pct"])}">{s["total_return_pct"]:+.1f}%</td>'
            f'<td>{s["sharpe"]:.2f}</td>'
            f'<td style="color:#ef4444">-{s["max_drawdown_pct"]:.1f}%</td>'
            f'<td style="color:{pc(s["final_balance"]-STARTING_BAL)}">${s["final_balance"]:,.0f}</td>'
            f'</tr>\n'
        )

    # Trade log
    all_trades = []
    for s in all_stats:
        for t in s.get('trade_log', []):
            all_trades.append({**t, 'instrument': s['name']})
    all_trades.sort(key=lambda x: x['entry_ts'], reverse=True)

    trade_rows = ''
    for t in all_trades[:100]:
        pc2 = '#10b981' if t['pnl'] > 0 else '#ef4444'
        ac  = '#3b82f6' if t['action'] == 'BUY' else '#f59e0b'
        sgn = '+$' if t['pnl'] >= 0 else '-$'
        trade_rows += (
            f'<tr>'
            f'<td>{t["entry_ts"][:16]}</td>'
            f'<td>{t["instrument"]}</td>'
            f'<td style="color:{ac}">{t["action"]}</td>'
            f'<td>{t["entry_price"]}</td>'
            f'<td>{t["exit_price"]}</td>'
            f'<td>${t["size_usd"]:,.0f}</td>'
            f'<td style="color:{pc2}">{sgn}{abs(t["pnl"]):,.2f}</td>'
            f'<td>${t["balance"]:,.0f}</td>'
            f'</tr>\n'
        )

    # Summary numbers
    valid   = [s for s in all_stats if 'error' not in s]
    tot_ret = sum(s['total_return_pct'] for s in valid) / max(1, len(valid))
    avg_wr  = sum(s['win_rate'] for s in valid) / max(1, len(valid))
    avg_sh  = sum(s['sharpe'] for s in valid) / max(1, len(valid))
    avg_dd  = sum(s['max_drawdown_pct'] for s in valid) / max(1, len(valid))
    pf_bal  = portfolio_eq[-1]['balance'] if portfolio_eq else STARTING_BAL
    now_str = datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')

    bal_cls = 'green' if pf_bal >= STARTING_BAL else 'red'
    ret_cls = 'green' if tot_ret >= 0 else 'red'
    rsi_str = '27/77 crypto | 35/65 forex'
    kelly_p = int(KELLY_FRACTION * 100)

    html = (
        '<!DOCTYPE html><html lang="en"><head>\n'
        '<meta charset="UTF-8">\n'
        '<title>IBKR RSI Backtest Report</title>\n'
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>\n'
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/chartjs-adapter-date-fns/3.0.0/chartjs-adapter-date-fns.bundle.min.js"></script>\n'
        '<style>\n'
        '* { box-sizing: border-box; margin: 0; padding: 0; }\n'
        'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\n'
        '       background: #0f172a; color: #e2e8f0; padding: 20px; }\n'
        'h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }\n'
        'h2 { font-size: 1.1rem; font-weight: 600; margin: 24px 0 10px; color: #94a3b8; }\n'
        '.meta { font-size: 0.8rem; color: #64748b; margin-bottom: 20px; }\n'
        '.banner { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }\n'
        '.card { background: #1e293b; border-radius: 10px; padding: 16px 22px; flex: 1; min-width: 140px; }\n'
        '.card .label { font-size: 0.72rem; color: #64748b; text-transform: uppercase;\n'
        '               letter-spacing: .05em; margin-bottom: 4px; }\n'
        '.card .value { font-size: 1.6rem; font-weight: 700; }\n'
        '.green { color: #10b981; } .red { color: #ef4444; }\n'
        '.yellow { color: #f59e0b; } .blue { color: #3b82f6; }\n'
        '.box { background: #1e293b; border-radius: 10px; padding: 18px; margin-bottom: 20px; }\n'
        'canvas { max-height: 320px; }\n'
        'table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }\n'
        'th { background: #0f172a; color: #64748b; padding: 8px 10px;\n'
        '     text-align: left; font-weight: 600; border-bottom: 1px solid #334155; }\n'
        'td { padding: 7px 10px; border-bottom: 1px solid #1e293b; }\n'
        'tr:hover td { background: #1e293b; }\n'
        '</style></head><body>\n'
        f'<h1>IBKR RSI Strategy - Backtest Report</h1>\n'
        f'<div class="meta">Generated {now_str} &nbsp;|&nbsp; {days}-day test &nbsp;|&nbsp; '
        f'1h candles &nbsp;|&nbsp; {HOLD_HOURS}h hold &nbsp;|&nbsp; '
        f'RSI {rsi_str} &nbsp;|&nbsp; '
        f'Kelly {kelly_p}% &nbsp;|&nbsp; Starting ${STARTING_BAL:,.0f}</div>\n'
        '<div class="banner">\n'
        f'  <div class="card"><div class="label">Portfolio Balance</div>'
        f'<div class="value {bal_cls}">${pf_bal:,.0f}</div></div>\n'
        f'  <div class="card"><div class="label">Avg Return</div>'
        f'<div class="value {ret_cls}">{tot_ret:+.1f}%</div></div>\n'
        f'  <div class="card"><div class="label">Avg Win Rate</div>'
        f'<div class="value yellow">{avg_wr:.1f}%</div></div>\n'
        f'  <div class="card"><div class="label">Avg Sharpe</div>'
        f'<div class="value blue">{avg_sh:.2f}</div></div>\n'
        f'  <div class="card"><div class="label">Avg Max Drawdown</div>'
        f'<div class="value red">-{avg_dd:.1f}%</div></div>\n'
        f'  <div class="card"><div class="label">Instruments</div>'
        f'<div class="value">{len(valid)}</div></div>\n'
        '</div>\n'
        '<h2>Equity Curves</h2><div class="box"><canvas id="eq"></canvas></div>\n'
        '<h2>Combined Monthly P&amp;L</h2><div class="box"><canvas id="mo"></canvas></div>\n'
        '<h2>Per-Instrument Statistics</h2>\n'
        '<div class="box" style="overflow-x:auto;">\n'
        '<table><tr><th>Instrument</th><th>Trades</th><th>Freq</th><th>Win%</th>'
        '<th>Avg Win</th><th>Avg Loss</th><th>PF</th>'
        '<th>Return</th><th>Sharpe</th><th>MaxDD</th><th>Balance</th></tr>\n'
        f'{stat_rows}'
        '</table></div>\n'
        '<h2>Recent Trades (last 100)</h2>\n'
        '<div class="box" style="overflow-x:auto;max-height:400px;overflow-y:auto;">\n'
        '<table><tr><th>Entry</th><th>Instrument</th><th>Dir</th>'
        '<th>Entry Price</th><th>Exit Price</th><th>Size</th><th>P&amp;L</th><th>Balance</th></tr>\n'
        f'{trade_rows}'
        '</table></div>\n'
    )

    # JavaScript — avoid f-string for the JS block to prevent brace conflicts
    eq_json = json.dumps(eq_datasets)
    mo_json = json.dumps(months_sorted)
    mv_json = json.dumps(monthly_vals)
    html += (
        '<script>\n'
        'const EQ=' + eq_json + ';\n'
        'const MO=' + mo_json + ';\n'
        'const MV=' + mv_json + ';\n'
        'const GRID={color:"#1e293b"};\n'
        'const TICK={color:"#64748b"};\n'
        'new Chart(document.getElementById("eq"),{\n'
        '  type:"line",data:{datasets:EQ},\n'
        '  options:{animation:false,responsive:true,\n'
        '    interaction:{mode:"index",intersect:false},\n'
        '    plugins:{legend:{labels:{color:"#94a3b8",font:{size:11}}},\n'
        '      tooltip:{callbacks:{label:c=>" "+c.dataset.label+": $"+c.parsed.y.toFixed(0)}}},\n'
        '    scales:{\n'
        '      x:{type:"time",time:{unit:"month"},ticks:TICK,grid:GRID},\n'
        '      y:{ticks:{...TICK,callback:v=>"$"+v.toLocaleString()},grid:GRID}\n'
        '    }\n'
        '  }\n'
        '});\n'
        'new Chart(document.getElementById("mo"),{\n'
        '  type:"bar",\n'
        '  data:{labels:MO,datasets:[{label:"Monthly P&L ($)",data:MV,\n'
        '    backgroundColor:MV.map(v=>v>=0?"#10b981":"#ef4444"),borderRadius:4}]},\n'
        '  options:{animation:false,responsive:true,\n'
        '    plugins:{legend:{display:false},\n'
        '      tooltip:{callbacks:{label:c=>" P&L: "+(c.parsed.y>=0?"+":"")+"$"+c.parsed.y.toFixed(0)}}},\n'
        '    scales:{\n'
        '      x:{ticks:TICK,grid:GRID},\n'
        '      y:{ticks:{...TICK,callback:v=>(v>=0?"+":"")+"$"+v.toLocaleString()},grid:GRID}\n'
        '    }\n'
        '  }\n'
        '});\n'
        '</script></body></html>\n'
    )

    REPORT_OUT.write_text(html, encoding='utf-8')
    print(f'  Report saved -> {REPORT_OUT}', flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='IBKR RSI Backtester')
    parser.add_argument('--days',  type=int, default=730,
                        help='Days of history (default 730 = 2 years)')
    parser.add_argument('--fresh', action='store_true',
                        help='Re-download data even if cached')
    args  = parser.parse_args()
    days  = args.days
    fresh = args.fresh

    SEP = '-' * 90
    print(f'\n{"="*60}', flush=True)
    print(f'  IBKR RSI Backtester', flush=True)
    print(f'  Period : {days} days  |  Candles: 1h  |  Hold: {HOLD_HOURS}h', flush=True)
    print(f'  RSI    : crypto 27/77  |  forex 35/65', flush=True)
    print(f'  Kelly  : {int(KELLY_FRACTION*100)}%  |  Balance: ${STARTING_BAL:,.0f}', flush=True)
    print(f'{"="*60}\n', flush=True)

    print('Step 1/3  Fetching data...', flush=True)
    data = {}
    for name, src, key, ov, ob in INSTRUMENTS:
        data[name] = load_or_fetch(name, src, key, days, fresh)

    print('\nStep 2/3  Running backtests...', flush=True)
    all_stats, all_eq = [], []

    for name, src, key, ov, ob in INSTRUMENTS:
        df = data[name]
        if df is None or df.empty:
            print(f'  SKIP {name} - no data', flush=True)
            all_stats.append({'name': name, 'error': 'No data available'})
            continue

        d0 = df['open_time'].iloc[0].date()
        d1 = df['open_time'].iloc[-1].date()
        print(f'  {name}: {len(df)} bars  ({d0} to {d1})  RSI {ov}/{ob}', flush=True)

        result = run_backtest(name, df, ov, ob)
        stats  = compute_stats(result, name, days)
        stats['equity_curve'] = result['equity']
        all_stats.append(stats)
        all_eq.append({'name': name, 'equity': result['equity']})

        if 'error' not in stats:
            print(
                f'    {stats["trades"]} trades | '
                f'win {stats["win_rate"]}% | '
                f'return {stats["total_return_pct"]:+.1f}% | '
                f'Sharpe {stats["sharpe"]:.2f} | '
                f'MaxDD -{stats["max_drawdown_pct"]:.1f}%',
                flush=True)

    portfolio_eq = combine_equity_curves(all_eq)

    print('\nStep 3/3  Generating HTML report...', flush=True)
    generate_report(all_stats, portfolio_eq, days)

    # Console summary table
    print(f'\n{SEP}', flush=True)
    print(f'{"Instrument":<16} {"Trades":>7} {"Win%":>6} {"PF":>6} '
          f'{"Return":>9} {"Sharpe":>8} {"MaxDD":>8} {"Balance":>10}', flush=True)
    print(SEP, flush=True)

    for s in all_stats:
        if 'error' in s:
            print(f'  {s["name"]:<14}  {s["error"]}', flush=True)
        else:
            pf_str = f'{s["profit_factor"]:6.2f}'
            print(
                f'  {s["name"]:<14} {s["trades"]:>7} {s["win_rate"]:>5.1f}% '
                f'{pf_str} {s["total_return_pct"]:>+8.1f}% '
                f'{s["sharpe"]:>8.3f} {s["max_drawdown_pct"]:>7.1f}% '
                f'  ${s["final_balance"]:>9,.0f}',
                flush=True)

    print(SEP, flush=True)
    if portfolio_eq:
        pr = (portfolio_eq[-1]['balance'] - STARTING_BAL) / STARTING_BAL * 100
        print(f'  {"PORTFOLIO":<14} {"":>7} {"":>6} {"":>6} '
              f'{pr:>+8.1f}%  {"":>8} {"":>8}   ${portfolio_eq[-1]["balance"]:>9,.0f}',
              flush=True)
    print(f'{SEP}\n', flush=True)
    print('  Open ibkr_backtest_report.html in your browser to see the charts.\n',
          flush=True)


if __name__ == '__main__':
    main()
