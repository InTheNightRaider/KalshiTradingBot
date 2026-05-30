'use strict';
/**
 * github_state.js — commit bot state back to the bot's own repo.
 *
 * Used by the bot when running inside GitHub Actions so the dashboard
 * can read dashboard/btc_paper_state.json via the GitHub Contents API.
 *
 * Strategy: keep a single "rolling" commit on `main` instead of one
 * commit per event, so we don't fill the user's history with thousands
 * of state-update commits. The bot:
 *   1) `git stash` any unrelated changes (none expected in CI)
 *   2) `git commit --amend` the previous state commit if its message
 *      starts with the BOT_COMMIT_PREFIX, otherwise creates a new one
 *   3) `git push --force-with-lease` only that file
 *
 * Disabled outside CI (when GITHUB_ACTIONS env var is missing) so local
 * runs don't touch your git history.
 *
 * Security: all git invocations use spawnSync with an argv array, not
 * a shell string. The `label` parameter never reaches a shell, so even
 * a future caller that passes user-controlled text cannot trigger
 * command injection.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');

const BOT_COMMIT_PREFIX = 'bot: state update';
const STATE_FILE_REL    = 'dashboard/btc_paper_state.json';
const ENABLED = !!process.env.GITHUB_ACTIONS;

let _configured  = false;
let _coolingUntil = 0;     // brief backoff after a push failure
let _lastTickPush = 0;     // throttle routine 'tick' pushes
const TICK_PUSH_INTERVAL_MS = 90 * 1000;  // routine push at most every 90s

// Allow only short alphanumeric labels in the commit message — defence in
// depth. Today's callers pass only 'tick', 'entry', 'resolution'.
function _safeLabel(label) {
  const s = String(label || 'tick');
  return /^[a-z0-9_-]{1,32}$/i.test(s) ? s : 'tick';
}

function _git(args) {
  return spawnSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function _ensureConfigured() {
  if (_configured) return;
  _git(['config', 'user.email', 'bot@kalshi-paper-bot.local']);
  _git(['config', 'user.name',  'kalshi-paper-bot']);
  _configured = true;
}

/**
 * Commit + push the current state file.
 * Resolves on success or graceful skip. Never throws (best-effort).
 */
async function pushState(label) {
  if (!ENABLED) return false;
  if (Date.now() < _coolingUntil) return false;

  const safeLabel = _safeLabel(label);

  // Throttle routine tick pushes so we're not force-pushing every 30s.
  // Always push immediately for meaningful events (entry, resolution, etc.).
  if (safeLabel === 'tick') {
    if (Date.now() - _lastTickPush < TICK_PUSH_INTERVAL_MS) return false;
  }
  _ensureConfigured();

  try {
    if (!fs.existsSync(STATE_FILE_REL)) return false;

    // Are there any staged or unstaged changes to the state file?
    const status = _git(['status', '--porcelain', STATE_FILE_REL]);
    if (status.status !== 0) throw new Error('git status failed: ' + status.stderr);
    if (!status.stdout.toString().trim()) return false;

    let r = _git(['add', STATE_FILE_REL]);
    if (r.status !== 0) throw new Error('git add failed: ' + r.stderr);

    // If the previous commit was a bot-state commit, amend it instead of
    // adding a new commit to history.
    const lastMsg = _git(['log', '-1', '--pretty=%s']);
    const isAmend = lastMsg.status === 0 &&
                    lastMsg.stdout.toString().trim().startsWith(BOT_COMMIT_PREFIX);

    const msg = `${BOT_COMMIT_PREFIX} (${safeLabel}) [skip ci]`;
    if (isAmend) {
      r = _git(['commit', '--amend', '-m', msg]);
      if (r.status !== 0) throw new Error('git commit --amend failed: ' + r.stderr);
      r = _git(['push', '--force-with-lease', 'origin', 'HEAD:main']);
    } else {
      r = _git(['commit', '-m', msg]);
      if (r.status !== 0) throw new Error('git commit failed: ' + r.stderr);
      r = _git(['push', 'origin', 'HEAD:main']);
    }

    // If push failed (typically because a code commit landed on main during
    // our run, breaking --force-with-lease), recover: fetch the new tip,
    // rebase our state commit on top, and push again. This keeps the rolling
    // single-commit pattern while surviving concurrent code pushes.
    if (r.status !== 0) {
      const pushErr = r.stderr.toString();
      const f = _git(['fetch', 'origin', 'main']);
      if (f.status !== 0) throw new Error('git push failed and fetch recovery failed: ' + pushErr + ' | ' + f.stderr);
      const rb = _git(['rebase', 'origin/main']);
      if (rb.status !== 0) {
        _git(['rebase', '--abort']);
        throw new Error('git push failed and rebase recovery failed: ' + pushErr + ' | ' + rb.stderr);
      }
      // After rebase our commit is on top of the new tip — fast-forward push.
      r = _git(['push', 'origin', 'HEAD:main']);
      if (r.status !== 0) throw new Error('git push failed even after rebase: ' + r.stderr);
      console.log(`  ↻ github_state recovered from concurrent push (rebased + retried)`);
    }

    if (safeLabel === 'tick') _lastTickPush = Date.now();
    return true;
  } catch (e) {
    // Include 2 lines of stderr context so a future failure is debuggable.
    const msg = (e && e.message) ? String(e.message).split('\n').slice(0, 2).join(' | ') : String(e);
    console.log(`  !! github_state push failed (${msg}) — backing off 5 min`);
    _coolingUntil = Date.now() + 5 * 60 * 1000;
    return false;
  }
}

module.exports = { ENABLED, pushState };
