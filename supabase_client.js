'use strict';
/**
 * supabase_client.js — OPTIONAL analytics sink.
 *
 * If SUPABASE_URL and SUPABASE_KEY env vars are not set, every export
 * is a no-op (resolves to null). This lets the bot run for users who
 * haven't set up their own Supabase project.
 *
 * Credentials (when present) MUST come from env vars — never from a
 * committed config file. This is required for safe operation in
 * forked repos / GitHub Actions.
 *
 *   SUPABASE_URL  = https://<project>.supabase.co
 *   SUPABASE_KEY  = service-role (write) key, set as a GitHub Action secret
 */

const https = require('https');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const ENABLED = !!(SB_URL && SB_KEY);

if (!ENABLED) {
  console.log('[supabase] disabled (SUPABASE_URL / SUPABASE_KEY not set) — analytics writes will be skipped');
}

const API = ENABLED ? SB_URL + '/rest/v1' : null;

function modeInt(modeKey) {
  if (modeKey === 'mode4a') return 41;
  if (modeKey === 'mode4b') return 42;
  return modeInt(modeKey);
}

function sbReq(method, tablePath, body, extraHeaders) {
  return new Promise(function(resolve, reject) {
    if (!ENABLED) return resolve(null);
    var bodyStr = body != null ? JSON.stringify(body) : null;
    var url     = new URL(API + tablePath);
    var headers = Object.assign({
      'apikey':        SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type':  'application/json',
    }, extraHeaders || {});
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    var req = https.request({
      hostname: url.hostname,
      path:     url.pathname + (url.search || ''),
      method:   method,
      headers:  headers,
    }, function(res) {
      var raw = '';
      res.on('data', function(c) { raw += c; });
      res.on('end', function() {
        var code = res.statusCode;
        if (code >= 400) return reject(new Error('sb ' + method + ' ' + tablePath + ' → ' + code + ': ' + raw.slice(0, 200)));
        try { resolve(raw ? JSON.parse(raw) : null); } catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, function() { req.destroy(); reject(new Error('sb timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sbPost(table, data, returning, ignoreConflict) {
  if (!ENABLED) return Promise.resolve(null);
  var rows = Array.isArray(data) ? data : [data];
  var parts = [];
  if (returning)      parts.push('return=representation');
  if (ignoreConflict) parts.push('resolution=ignore-duplicates');
  var prefer = parts.join(',');
  return sbReq('POST', '/' + table, rows, prefer ? { Prefer: prefer } : {});
}

function sbPatch(table, id, data) {
  if (!ENABLED) return Promise.resolve(null);
  return sbReq('PATCH', '/' + table + '?id=eq.' + id, data, {});
}

// ────────────────────────────────────────────────────────────────
// Exported writers — each returns Promise<value|null>. Disabled mode
// resolves to null so callers can fire-and-forget without branching.
// ────────────────────────────────────────────────────────────────
async function insertScan(scanData, contracts) {
  if (!ENABLED) return null;
  var rows = await sbPost('market_scans', {
    ts:     scanData.ts,
    btc:    Math.round(scanData.btcPrice),
    r1:     scanData.rsi1m  != null ? Math.round(scanData.rsi1m  * 10) : null,
    r5:     scanData.rsi5m  != null ? Math.round(scanData.rsi5m  * 10) : null,
    n_mkts: scanData.totalMarketsAvailable || null,
  }, true, false);
  var scan = Array.isArray(rows) ? rows[0] : rows;
  if (!scan || !scan.id) return null;
  var top = (contracts || []).slice(0, 20);
  if (top.length > 0) {
    var tickRows = top.map(function(c) {
      return {
        sid:    scan.id,
        ticker: c.ticker,
        strike: Math.round(c.strike),
        dist:   Math.round(c.dist),
        ym:     c.yesMid     != null ? Math.round(c.yesMid     * 10000) : null,
        nm:     c.noMid      != null ? Math.round(c.noMid      * 10000) : null,
        vol:    Math.round(c.volume  || 0),
        ml:     c.minutesLeft != null ? Math.round(c.minutesLeft * 100) : null,
        mi:     c.minutesIn   != null ? Math.round(c.minutesIn   * 100) : null,
      };
    });
    await sbPost('contract_ticks', tickRows, false, false);
  }
  return scan.id;
}

async function upsertCapture(ticker, phase, data) {
  if (!ENABLED) return null;
  await sbPost('contract_captures', {
    ticker:   ticker, phase: phase, ts: new Date().toISOString(),
    btc:      data.btcPrice  != null ? Math.round(data.btcPrice)        : null,
    dist:     data.distance  != null ? Math.round(data.distance)        : null,
    yes_odds: data.yesOdds   != null ? Math.round(data.yesOdds  * 1000) : null,
    no_odds:  data.noOdds    != null ? Math.round(data.noOdds   * 1000) : null,
    r1:       data.rsi1m     != null ? Math.round(data.rsi1m    * 10)   : null,
    r5:       data.rsi5m     != null ? Math.round(data.rsi5m    * 10)   : null,
    vol:      data.volume    != null ? Math.round(data.volume)          : null,
    mi:       data.minutesIn != null ? parseFloat(data.minutesIn)       : null,
    m1_enter: data.mode1Signal ? (data.mode1Signal.enter || false) : null,
    m1_side:  data.mode1Signal ? (data.mode1Signal.side  || null)  : null,
    m1_conf:  data.mode1Signal ? (data.mode1Signal.confidence || null) : null,
    m2_enter: data.mode2Signal ? (data.mode2Signal.enter || false) : null,
    m2_side:  data.mode2Signal ? (data.mode2Signal.side  || null)  : null,
    won:      data.won  != null ? data.won  : null,
    pnl:      data.pnl  != null ? data.pnl  : null,
  }, false, true);
}

async function insertPosition(entry, modeKey, rsi1m, rsi5m) {
  if (!ENABLED) return null;
  var rows = await sbPost('positions', {
    ticker:     entry.ticker,
    mode:       modeInt(modeKey),
    tier:       entry.tier       || null,
    side:       entry.side,
    cost:       entry.cost,
    px:         entry.contractPx,
    payout:     entry.payout,
    btc:        entry.btcPrice   != null ? Math.round(entry.btcPrice) : null,
    strike:     entry.strike     != null ? Math.round(entry.strike)   : null,
    dist:       entry.distance   != null ? Math.round(entry.distance) : null,
    r1:         rsi1m            != null ? Math.round(rsi1m    * 10)  : null,
    r5:         rsi5m            != null ? Math.round(rsi5m    * 10)  : null,
    confidence: entry.confidence || null,
    close_ts:   entry.close_time || null,
    entered_ts: new Date().toISOString(),
    live:       entry.live       || false,
  }, true, false);
  var pos = Array.isArray(rows) ? rows[0] : rows;
  return (pos && pos.id) ? pos.id : null;
}

async function resolvePosition(sbId, won, pnl, priceTicks) {
  if (!ENABLED || !sbId) return;
  await sbPatch('positions', sbId, {
    won: won, pnl: pnl, resolved_ts: new Date().toISOString(), price_ticks: priceTicks || null,
  });
}

async function insertBotState(state, event, modeKey, btcPrice, rsi1m) {
  if (!ENABLED) return null;
  await sbPost('bot_state', {
    ts: new Date().toISOString(), event: event,
    mode: modeInt(modeKey),
    m1_bank: state.mode1.bankroll, m2_bank: state.mode2.bankroll, m4_bank: state.mode4.bankroll,
    m1_ls: state.mode1.lossStreak, m2_ls: state.mode2.lossStreak,
    m3_ls: state.mode3.lossStreak, m4_ls: state.mode4.lossStreak,
    btc: btcPrice != null ? Math.round(btcPrice) : null,
    r1:  rsi1m    != null ? Math.round(rsi1m * 10) : null,
  }, false, false);
}

module.exports = { ENABLED, insertScan, upsertCapture, insertPosition, resolvePosition, insertBotState };
