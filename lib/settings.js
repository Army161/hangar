'use strict';
/**
 * Hangar settings — persisted preferences, protection lists, and integrations.
 *
 * Two files, deliberately separate:
 *
 *   config/settings.json        safe to commit and to read back in full
 *   config/settings.local.json  secrets; gitignored, never returned verbatim
 *
 * Secrets go out masked (••••last4) and are only replaced when the client sends
 * a genuinely new value. A UI that round-trips a masked string must not be able
 * to overwrite the real key with dots, so writes ignore any value that still
 * looks like a mask.
 *
 * Everything here is whitelist-driven. An unknown key is dropped rather than
 * merged — this file is written from an HTTP handler, and a settings endpoint
 * that merges arbitrary structure is an arbitrary-write primitive.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
const LOCAL = path.join(CONFIG_DIR, 'settings.local.json');
const PROTECTED = path.join(CONFIG_DIR, 'protected.json');

const MASK = '••••';

const DEFAULTS = {
  appearance: {
    theme: 'system',          // system | light | dark
    density: 'comfortable',   // comfortable | compact
  },
  collection: {
    fastTtlMs: 4000,          // process table
    slowTtlMs: 300000,        // startup, tasks, services
    probePorts: true,
  },
  integrations: {
    amplitude: {
      enabled: false,
      serverZone: 'US',       // US | EU
      // apiKey lives in settings.local.json
    },
    agents: {
      enabled: false,
      endpoints: [],          // [{ id, label, url, transport }]
    },
  },
};

// key path -> validator. Anything absent from this table is discarded.
const SCHEMA = {
  'appearance.theme': (v) => ['system', 'light', 'dark'].includes(v),
  'appearance.density': (v) => ['comfortable', 'compact'].includes(v),
  'collection.fastTtlMs': (v) => Number.isInteger(v) && v >= 1000 && v <= 60000,
  'collection.slowTtlMs': (v) => Number.isInteger(v) && v >= 30000 && v <= 3600000,
  'collection.probePorts': (v) => typeof v === 'boolean',
  'integrations.amplitude.enabled': (v) => typeof v === 'boolean',
  'integrations.amplitude.serverZone': (v) => ['US', 'EU'].includes(v),
  'integrations.agents.enabled': (v) => typeof v === 'boolean',
  'integrations.agents.endpoints': (v) => Array.isArray(v) && v.length <= 20
    && v.every((e) => e && typeof e.label === 'string' && e.label.length <= 80
      && typeof e.url === 'string' && isLocalHttp(e.url)),
};

// Agent endpoints are dialled by the agent process, so an arbitrary URL here is
// an SSRF primitive. Loopback only — this is a local tool.
function isLocalHttp(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(p.hostname);
  } catch { return false; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot truncate a good config.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object'
      ? deepMerge(out[k], v)
      : v;
  }
  return out;
}

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function set(obj, dotted, val) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[last] = val;
}

function maskSecret(s) {
  if (!s) return '';
  return s.length <= 4 ? MASK : MASK + s.slice(-4);
}

function looksMasked(s) {
  return typeof s === 'string' && s.startsWith(MASK);
}

/** Full settings with secrets masked — safe to send to a client. */
function load() {
  const stored = readJson(SETTINGS, {});
  const local = readJson(LOCAL, {});
  const merged = deepMerge(DEFAULTS, stored);

  merged.integrations.amplitude.apiKey = maskSecret(local.amplitudeApiKey);
  merged.integrations.amplitude.configured = Boolean(local.amplitudeApiKey);
  return merged;
}

/**
 * Apply a patch. Returns { settings, applied, rejected } — rejected keys are
 * reported rather than silently dropped, so a UI bug is visible.
 */
function save(patch) {
  const stored = readJson(SETTINGS, {});
  const current = deepMerge(DEFAULTS, stored);
  const applied = [];
  const rejected = [];

  for (const key of Object.keys(SCHEMA)) {
    const incoming = get(patch, key);
    if (incoming === undefined) continue;
    if (SCHEMA[key](incoming)) { set(current, key, incoming); applied.push(key); }
    else rejected.push(key);
  }

  // Secrets never travel with the rest.
  const key = get(patch, 'integrations.amplitude.apiKey');
  if (typeof key === 'string' && !looksMasked(key)) {
    const local = readJson(LOCAL, {});
    if (key === '') delete local.amplitudeApiKey;
    else if (/^[A-Za-z0-9_-]{16,128}$/.test(key)) local.amplitudeApiKey = key;
    else rejected.push('integrations.amplitude.apiKey');

    if (!rejected.includes('integrations.amplitude.apiKey')) {
      writeJson(LOCAL, local);
      applied.push('integrations.amplitude.apiKey');
    }
  }

  delete current.integrations.amplitude.apiKey;
  delete current.integrations.amplitude.configured;
  writeJson(SETTINGS, current);

  return { settings: load(), applied, rejected };
}

/** The user-editable never-kill list. The system-critical list lives in code. */
function loadProtected() {
  const p = readJson(PROTECTED, { names: [], projects: [] });
  return { names: p.names || [], projects: p.projects || [], _comment: p._comment };
}

function saveProtected({ names, projects }) {
  const clean = (arr) => (Array.isArray(arr) ? arr : [])
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0 && s.length <= 120)
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, 500);

  const existing = readJson(PROTECTED, {});
  const next = {
    _comment: existing._comment
      || 'Apps and projects Hangar must never kill.',
    names: clean(names),
    projects: clean(projects),
  };
  writeJson(PROTECTED, next);
  return loadProtected();
}

/**
 * Per-provider agent API keys, in full.
 *
 * Server-side only — never sent to a client. The settings endpoint returns
 * masked values; this is for handing a key to a provider adapter at call time.
 */
function agentKeys() {
  const local = readJson(LOCAL, {});
  const out = {};
  for (const [k, v] of Object.entries(local)) {
    const m = /^agentKey_(.+)$/.exec(k);
    if (m && v) out[m[1]] = v;
  }
  return out;
}

/** Which providers have a key, without revealing any of them. */
function agentKeyStatus() {
  const keys = agentKeys();
  const out = {};
  for (const [provider, v] of Object.entries(keys)) out[provider] = maskSecret(v);
  return out;
}

function saveAgentKey(provider, value) {
  if (!/^[a-z][a-z0-9_-]{1,32}$/i.test(String(provider))) return { ok: false, reason: 'bad-provider' };
  const local = readJson(LOCAL, {});
  if (value === '') delete local[`agentKey_${provider}`];
  else if (typeof value === 'string' && value.length >= 8 && value.length <= 400 && !looksMasked(value)) {
    local[`agentKey_${provider}`] = value;
  } else return { ok: false, reason: 'bad-key' };
  writeJson(LOCAL, local);
  return { ok: true, status: agentKeyStatus() };
}

module.exports = {
  DEFAULTS, load, save, loadProtected, saveProtected,
  agentKeys, agentKeyStatus, saveAgentKey,
  isLocalHttp, maskSecret, _paths: { SETTINGS, LOCAL, PROTECTED },
};
