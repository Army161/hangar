'use strict';
/**
 * Kill guard. Every destructive action in Hangar goes through evaluateKill().
 *
 * Design rules, written in blood (2026-07-29, terminal64.exe):
 *   1. The guard is a PURE FUNCTION. It returns verdict objects; it never
 *      logs, never emits, never mutates. Mixing output into return values is
 *      exactly the bug that killed MetaTrader.
 *   2. Protection is evaluated AFTER tree expansion, on the final pid list.
 *      A killable parent never launders its protected children.
 *   3. Every pid in the expanded request appears in exactly one bucket:
 *      allowed or blocked. Silent drops are treated as bugs by the tests.
 *   4. When in doubt, block. A false "blocked" costs a second click; a false
 *      "allowed" costs someone's trading terminal.
 */

const fs = require('fs');
const path = require('path');

// System-critical: killing these can take down the session or the OS.
// This list is code, not config — it should not be editable from the UI.
const SYSTEM_DENY = [
  /^System(\s|$)/i, /^Registry$/i, /^Memory Compression$/i, /^smss\.exe$/i,
  /^csrss\.exe$/i, /^wininit\.exe$/i, /^winlogon\.exe$/i, /^services\.exe$/i,
  /^lsass\.exe$/i, /^svchost\.exe$/i, /^dwm\.exe$/i, /^fontdrvhost\.exe$/i,
  /^MsMpEng\.exe$/i, /^MpDefender/i, /^SecurityHealth/i, /^explorer\.exe$/i,
  /^NVDisplay/i, /^nvcontainer/i, /^wslservice\.exe$/i,
];

/**
 * User-editable protections live in config/protected.json so "never touch my
 * trading terminal" survives restarts and is visible in one reviewable place.
 */
const DEFAULT_CONFIG = {
  names: ['ollama', 'ollama app', 'llama-server', 'terminal64', 'OneDrive', 'SignalRgb'],
  projects: ['TAO_WALLET', 'OUROBOROS'],
};

let cachedConfig = null;
function loadConfig(configPath) {
  if (cachedConfig) return cachedConfig;
  const file = configPath || path.join(__dirname, '..', 'config', 'protected.json');
  try {
    cachedConfig = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    cachedConfig = DEFAULT_CONFIG;
  }
  return cachedConfig;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand requested pids to full descendant trees. Returns a Set of pids. */
function expandTrees(pids, byPid, kids) {
  const out = new Set();
  const stack = [...pids];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    if (!byPid.has(cur)) continue; // pid died between snapshot and request
    out.add(cur);
    for (const k of kids.get(cur) || []) stack.push(k);
  }
  return out;
}

/**
 * Evaluate a kill request.
 *
 * @param {number[]} requestedPids  pids the user asked to kill
 * @param {Array}    processes      [{pid, ppid, name, cmd, path?, memMB?}]
 * @param {object}   opts
 *   - includeTree:   expand to descendants (default false)
 *   - protectedPids: this session's ancestry chain
 *   - selfPid:       the hangar server's own pid
 *   - config:        override protected.json (tests use this)
 * @returns {{allowed: Array, blocked: Array, expanded: number[]}}
 */
function evaluateKill(requestedPids, processes, opts = {}) {
  const cfg = opts.config || loadConfig(opts.configPath);
  const protectedPids = new Set(opts.protectedPids || []);
  if (opts.selfPid) protectedPids.add(opts.selfPid);
  if (typeof process !== 'undefined' && process.pid) protectedPids.add(process.pid);

  const byPid = new Map();
  const kids = new Map();
  for (const p of processes) {
    byPid.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }

  const nameDeny = cfg.names.map((n) => new RegExp('^' + escapeRe(n), 'i'));
  const projectDeny = cfg.projects.map((n) => new RegExp(escapeRe(n), 'i'));

  const finalPids = opts.includeTree
    ? expandTrees(requestedPids, byPid, kids)
    : new Set(requestedPids.filter((p) => byPid.has(p)));

  const allowed = [];
  const blocked = [];

  for (const pid of finalPids) {
    const p = byPid.get(pid);
    const item = { pid, name: p.name, memMB: p.memMB ?? null, cmd: p.cmd ?? null };
    const hay = `${p.cmd || ''} ${p.path || ''}`;

    let reason = null;
    if (pid === opts.selfPid || (p.cmd && /hangar[\\/]server\.js/i.test(p.cmd))) {
      reason = 'protected: the hangar agent itself';
    } else if (protectedPids.has(pid)) {
      reason = 'protected: this session’s own process chain';
    } else if (SYSTEM_DENY.some((re) => re.test(p.name))) {
      reason = 'protected: system-critical process';
    } else if (nameDeny.some((re) => re.test(p.name))) {
      reason = 'protected: on your protected-apps list (config/protected.json)';
    } else if (projectDeny.some((re) => re.test(hay))) {
      reason = 'protected: belongs to a protected project (config/protected.json)';
    }

    if (reason) blocked.push({ ...item, reason });
    else allowed.push(item);
  }

  // Deterministic ordering keeps the dry-run preview stable across refreshes.
  allowed.sort((a, b) => a.pid - b.pid);
  blocked.sort((a, b) => a.pid - b.pid);

  return { allowed, blocked, expanded: [...finalPids].sort((a, b) => a - b) };
}

/** Test hook: clear the config cache. */
function _resetConfigCache() { cachedConfig = null; }

module.exports = { evaluateKill, expandTrees, _resetConfigCache };
