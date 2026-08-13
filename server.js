'use strict';
/**
 * Hangar agent — v0.2 (GUARDED WRITES)
 *
 * v0.1 was read-only. v0.2 adds Park (kill with a restore manifest) behind
 * three mandatory gates, in order:
 *   1. Dry-run plan: POST /api/plan returns exactly what would die and what
 *      the guard blocks, plus a confirmation phrase. Nothing happens.
 *   2. Typed confirmation: POST /api/execute requires the plan id AND the
 *      exact phrase. Plans expire after 5 minutes and are single-use.
 *   3. Re-evaluation at execute time: the guard runs AGAIN on a fresh
 *      process table — pids that shifted since the plan are dropped, and
 *      the manifest is written to disk BEFORE the first kill.
 *
 * Set HANGAR_READONLY=1 to disable all write endpoints entirely.
 * Bound to 127.0.0.1 only — your process table never leaves the machine.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const crypto = require('crypto');
const { attribute, traceOrigins } = require('./lib/attribute');
const { probePorts } = require('./lib/probe');
const { evaluateKill } = require('./lib/guard');
const { writeManifest, listManifests, restoreManifest, markRestored } = require('./lib/manifest');
const { entryId, evaluatePersistence, describeAction, invertAction } = require('./lib/persistence');
const { classifyProject, mergeWithLive, rankGraveyard } = require('./lib/graveyard');

const PORT = Number(process.env.HANGAR_PORT) || 7420;
const ROOT = __dirname;
const SCRIPTS = path.join(ROOT, 'scripts');
const READ_ONLY = process.env.HANGAR_READONLY === '1';
const VERSION = '0.4.0';

// --- remote access (for the installable phone/tablet client) ---------------
//
// Default is unchanged: loopback only, no token, nothing reachable off-box.
//
// Setting HANGAR_HOST binds wider, which puts a process-control API on your
// network. That is refused unless HANGAR_TOKEN is also set, and the token must
// be long enough to be worth having. Failing closed here is deliberate: the
// mistake this prevents — exposing park/execute to the LAN unauthenticated —
// is not one you get to notice and undo later.
const HOST = process.env.HANGAR_HOST || '127.0.0.1';
const TOKEN = process.env.HANGAR_TOKEN || '';
const REMOTE = HOST !== '127.0.0.1' && HOST !== 'localhost';

if (REMOTE && TOKEN.length < 24) {
  console.error('\n  Refusing to start.\n');
  console.error(`  HANGAR_HOST=${HOST} exposes this agent beyond loopback, so`);
  console.error('  HANGAR_TOKEN must be set to at least 24 characters.\n');
  console.error('  Generate one:');
  console.error('    node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"\n');
  process.exit(1);
}

// Timing-safe so the token cannot be recovered by measuring rejections.
function tokenOk(req, url) {
  if (!REMOTE) return true;
  const given = (req.headers['x-hangar-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const FAST_TTL = 4000;      // process table: refresh at most every 4s
const SLOW_TTL = 300_000;   // persistence surfaces: every 5 minutes

// ---------------------------------------------------------------------------
// PowerShell bridge
// ---------------------------------------------------------------------------
function runPowerShell(scriptFile, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, scriptFile)];
    const ps = spawn('powershell.exe', args, { windowsHide: true });

    let out = '';
    let err = '';
    const timer = setTimeout(() => { ps.kill(); reject(new Error(`${scriptFile} timed out after ${timeoutMs}ms`)); }, timeoutMs);

    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });

    ps.on('error', (e) => { clearTimeout(timer); reject(e); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new Error(`${scriptFile} exited ${code}: ${err.slice(0, 500)}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`${scriptFile} produced unparseable output: ${String(e.message).slice(0, 200)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const GRAVE_TTL = 10 * 60_000; // the sweep costs ~3s; never block the dashboard on it

const state = {
  fast: null, fastAt: 0, fastPending: null,
  slow: null, slowAt: 0, slowPending: null,
  grave: null, graveAt: 0, gravePending: null,
  prevCpu: null,      // pid -> cpuSec, for computing live CPU%
  prevCpuAt: 0,
  errors: [],
};

function noteError(scope, e) {
  const msg = `${scope}: ${e.message || e}`;
  state.errors = [{ at: new Date().toISOString(), msg }, ...state.errors].slice(0, 5);
  console.error('[hangar]', msg);
}

async function getFast() {
  const now = Date.now();
  if (state.fast && now - state.fastAt < FAST_TTL) return state.fast;
  if (state.fastPending) return state.fastPending;

  state.fastPending = runPowerShell('collect-fast.ps1', 45_000)
    .then((data) => { state.fast = data; state.fastAt = Date.now(); return data; })
    .catch((e) => { noteError('fast collector', e); return state.fast; })
    .finally(() => { state.fastPending = null; });

  return state.fastPending;
}

async function getSlow() {
  const now = Date.now();
  if (state.slow && now - state.slowAt < SLOW_TTL) return state.slow;
  if (state.slowPending) return state.slowPending;

  state.slowPending = runPowerShell('collect-slow.ps1', 90_000)
    .then((data) => { state.slow = data; state.slowAt = Date.now(); return data; })
    .catch((e) => { noteError('slow collector', e); return state.slow; })
    .finally(() => { state.slowPending = null; });

  return state.slowPending;
}

/**
 * Graveyard sweep. Lazy and long-cached: it walks the user profile and costs
 * seconds, so it is only collected when the tab is opened and never blocks a
 * dashboard refresh.
 */
async function getGraveyard(force = false) {
  const now = Date.now();
  if (!force && state.grave && now - state.graveAt < GRAVE_TTL) return state.grave;
  if (state.gravePending) return state.gravePending;

  state.gravePending = runPowerShell('collect-graveyard.ps1', 180_000)
    .then((data) => { state.grave = data; state.graveAt = Date.now(); return data; })
    .catch((e) => { noteError('graveyard collector', e); return state.grave; })
    .finally(() => { state.gravePending = null; });

  return state.gravePending;
}

/** CPU% needs two samples — cumulative seconds alone tells you nothing about now. */
function computeCpu(processes, cpus) {
  const now = Date.now();
  const cur = new Map(processes.map((p) => [p.pid, p.cpuSec]));

  if (state.prevCpu && state.prevCpuAt) {
    const wall = (now - state.prevCpuAt) / 1000;
    if (wall > 0.5) {
      for (const p of processes) {
        const before = state.prevCpu.get(p.pid);
        if (before === undefined) { p.cpuPct = null; continue; }
        const pct = ((p.cpuSec - before) / (wall * cpus)) * 100;
        p.cpuPct = Math.max(0, Math.round(pct * 10) / 10);
      }
      state.prevCpu = cur;
      state.prevCpuAt = now;
      return;
    }
  } else {
    state.prevCpu = cur;
    state.prevCpuAt = now;
  }
  for (const p of processes) if (p.cpuPct === undefined) p.cpuPct = null;
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------
async function buildSnapshot() {
  const [fast, slow] = await Promise.all([getFast(), getSlow()]);
  if (!fast) throw new Error('No process data yet — the collector has not returned.');

  const rawProcs = fast.processes || [];
  computeCpu(rawProcs, fast.system.cpus || 1);

  const { processes, owners, fanout } = attribute(rawProcs, { homeDir: os.homedir() });
  const entries = (slow && slow.entries) || [];
  const origins = traceOrigins(processes, entries);

  // Attach origin info to the owner that the traced process belongs to.
  const originByOwnerKey = new Map();
  for (const [pid, origin] of origins) {
    const proc = processes.find((p) => p.pid === pid);
    if (!proc) continue;
    const key = `${proc.kind}::${proc.owner}`;
    const existing = originByOwnerKey.get(key);
    if (!existing || origin.score > existing.score) originByOwnerKey.set(key, origin);
  }

  const byPid = new Map(processes.map((p) => [p.pid, p]));

  // --- Port wall ---
  const portList = [...new Set((fast.ports || []).map((p) => p.port))].sort((a, b) => a - b);
  let probes = new Map();
  try {
    probes = await probePorts(portList);
  } catch (e) {
    noteError('port probe', e);
  }

  const portOwner = new Map();
  for (const p of fast.ports || []) if (!portOwner.has(p.port)) portOwner.set(p.port, p.pid);

  const ports = portList.map((port) => {
    const pid = portOwner.get(port);
    const proc = byPid.get(pid);
    const probe = probes.get(port) || { http: false, reason: 'unprobed' };
    return {
      port,
      pid,
      url: `http://localhost:${port}`,
      process: proc ? proc.name : null,
      owner: proc ? proc.owner : 'unknown',
      kind: proc ? proc.kind : null,
      memMB: proc ? proc.memMB : null,
      reattach: proc ? proc.reattach : false,
      probe,
    };
  });

  // --- Owner rollup, with origin + ports attached ---
  const ownersOut = owners.map((g) => {
    const origin = originByOwnerKey.get(g.key) || null;
    const ownPorts = ports.filter((p) => g.pids.includes(p.pid)).map((p) => p.port);
    const cpuPct = g.pids.reduce((sum, pid) => {
      const p = byPid.get(pid);
      return sum + (p && p.cpuPct ? p.cpuPct : 0);
    }, 0);
    return {
      ...g,
      cpuPct: Math.round(cpuPct * 10) / 10,
      ports: ownPorts,
      origin: origin && {
        kind: origin.kind, name: origin.name, command: origin.command,
        confidence: origin.confidence || 'likely',
        location: origin.location, added: origin.added, addedSource: origin.addedSource,
        state: origin.state || null, lastRun: origin.lastRun || null,
        nextRun: origin.nextRun || null, triggers: origin.triggers || null,
        why: origin.why, score: origin.score,
      },
    };
  });

  const totalGB = fast.system.totalGB;
  const usedGB = Math.round((totalGB - fast.system.freeGB) * 10) / 10;

  // Ship the process rows too, so expanding an owner shows real command lines.
  // Trimmed because some MCP invocations run to several kilobytes of argv.
  const processesOut = processes.map((p) => ({
    pid: p.pid, ppid: p.ppid, name: p.name, memMB: p.memMB, cpuPct: p.cpuPct ?? null,
    started: p.started, owner: p.owner, kind: p.kind,
    cmd: p.cmd ? p.cmd.slice(0, 400) : null,
    path: p.path || null,
  }));

  return {
    ts: new Date().toISOString(),
    readOnly: READ_ONLY,
    version: VERSION,
    vram: fast.vram || null,
    system: { ...fast.system, usedGB },
    stale: { processes: Date.now() - state.fastAt, persistence: Date.now() - state.slowAt },
    processes: processesOut,
    // Entries carry a stable id and a live enabled flag so the Origins tab can
    // offer a reversible off switch per row.
    entriesWithId: entries.map((e) => ({
      ...e,
      id: entryId(e),
      disabled: e.enabled === false || e.state === 'Disabled',
    })),
    owners: ownersOut,
    fanout,
    ports,
    entries,
    errors: state.errors,
    counts: {
      processes: processes.length,
      owners: ownersOut.length,
      ports: ports.length,
      browsable: ports.filter((p) => p.probe && p.probe.browsable).length,
      persistence: entries.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Park / Restore machinery
// ---------------------------------------------------------------------------
const PLAN_TTL_MS = 5 * 60 * 1000;
const plans = new Map(); // planId -> { verdict, phrase, expiresAt, used }

/** My own ancestry: the chain of parents above this server process. */
function ancestryChain(processes) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const chain = [];
  let cur = process.pid;
  for (let i = 0; i < 30 && cur && byPid.has(cur); i++) {
    chain.push(cur);
    cur = byPid.get(cur).ppid;
  }
  return chain;
}

function attachPorts(victims, fastPorts) {
  const portsByPid = new Map();
  for (const p of fastPorts || []) {
    if (!portsByPid.has(p.pid)) portsByPid.set(p.pid, []);
    portsByPid.get(p.pid).push(p.port);
  }
  return victims.map((v) => ({ ...v, ports: portsByPid.get(v.pid) || [] }));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** POST /api/plan — dry-run. Nothing is killed here, ever. */
async function handlePlan(body, res) {
  const pids = (body.pids || []).map(Number).filter(Number.isInteger);
  if (!pids.length) return json(res, 400, { error: 'pids required' });

  const fast = await getFast();
  if (!fast) return json(res, 503, { error: 'no process data yet' });

  const procs = fast.processes;
  const verdict = evaluateKill(pids, procs, {
    includeTree: body.includeTree !== false,
    protectedPids: ancestryChain(procs),
    selfPid: process.pid,
  });
  verdict.allowed = attachPorts(verdict.allowed, fast.ports);

  const totalMB = Math.round(verdict.allowed.reduce((a, v) => a + (v.memMB || 0), 0));
  const phrase = `PARK ${verdict.allowed.length}`;
  const planId = crypto.randomBytes(8).toString('hex');
  plans.set(planId, {
    pids, includeTree: body.includeTree !== false,
    allowedPids: verdict.allowed.map((v) => v.pid),
    phrase, expiresAt: Date.now() + PLAN_TTL_MS, used: false,
  });
  // Opportunistic cleanup of stale plans.
  for (const [id, p] of plans) if (p.expiresAt < Date.now()) plans.delete(id);

  json(res, 200, {
    planId,
    confirmPhrase: phrase,
    expiresInSec: PLAN_TTL_MS / 1000,
    estimateMB: totalMB,
    allowed: verdict.allowed,
    blocked: verdict.blocked,
  });
}

/** POST /api/execute — the only code path in Hangar that kills anything. */
async function handleExecute(body, res) {
  const plan = plans.get(body.planId);
  if (!plan) return json(res, 404, { error: 'unknown or expired plan — run the dry-run again' });
  if (plan.used) return json(res, 409, { error: 'plan already executed' });
  if (plan.expiresAt < Date.now()) { plans.delete(body.planId); return json(res, 410, { error: 'plan expired — run the dry-run again' }); }
  if (body.confirm !== plan.phrase) {
    return json(res, 403, { error: `confirmation mismatch — type exactly: ${plan.phrase}` });
  }
  plan.used = true;

  // Re-evaluate on a FRESH table. PIDs recycle; a plan is a proposal, not a
  // license. Anything that changed since the dry-run simply drops out.
  state.fastAt = 0; // force collector refresh
  const fast = await getFast();
  if (!fast) return json(res, 503, { error: 'no process data' });
  const procs = fast.processes;
  const verdict = evaluateKill(plan.pids, procs, {
    includeTree: plan.includeTree,
    protectedPids: ancestryChain(procs),
    selfPid: process.pid,
  });
  // Also drop anything that was not in the plan the user confirmed.
  const confirmedSet = new Set(plan.allowedPids);
  const victims = attachPorts(
    verdict.allowed.filter((v) => confirmedSet.has(v.pid)),
    fast.ports
  ).map((v) => {
    const full = procs.find((p) => p.pid === v.pid) || {};
    return { ...v, path: full.path || null, cmd: full.cmd || v.cmd };
  });

  if (!victims.length) {
    return json(res, 200, { killed: [], skipped: verdict.blocked, note: 'nothing left to kill — processes changed since the plan' });
  }

  // Manifest BEFORE kill. If this throws, nothing dies.
  let manifest;
  try {
    manifest = writeManifest('park', victims, { confirmPhrase: plan.phrase, requestedPids: plan.pids });
  } catch (e) {
    return json(res, 500, { error: `manifest write failed, nothing was killed: ${e.message}` });
  }

  const killed = [];
  const failed = [];
  for (const v of victims) {
    try { process.kill(v.pid); killed.push(v); }
    catch (e) { failed.push({ ...v, error: e.code || e.message }); }
  }
  state.fastAt = 0; // next snapshot reflects reality

  json(res, 200, {
    manifestId: manifest.id,
    killed,
    failed,
    blocked: verdict.blocked,
    freedEstimateMB: Math.round(killed.reduce((a, v) => a + (v.memMB || 0), 0)),
  });
}

// ---------------------------------------------------------------------------
// Persistence control — the changes that survive a reboot
// ---------------------------------------------------------------------------
const persistPlans = new Map(); // planId -> { ids, phrase, actions, expiresAt, used }

function loadProtectedConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'protected.json'), 'utf8'));
  } catch {
    return { names: [], projects: [] };
  }
}

/** Run the PowerShell executor with a JSON action list on stdin. */
function applyPersistence(actions) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(SCRIPTS, 'persistence-apply.ps1'),
    ], { windowsHide: true });

    let out = '', err = '';
    const timer = setTimeout(() => { ps.kill(); reject(new Error('persistence executor timed out')); }, 120_000);
    ps.stdout.setEncoding('utf8'); ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', (e) => { clearTimeout(timer); reject(e); });
    ps.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(`executor output unparseable: ${(err || out).slice(0, 300)}`)); }
    });
    ps.stdin.write(JSON.stringify({ actions }));
    ps.stdin.end();
  });
}

/** POST /api/persist/plan — dry run over startup entries, tasks and services. */
async function handlePersistPlan(body, res) {
  const ids = (body.ids || []).map(String).filter(Boolean);
  if (!ids.length) return json(res, 400, { error: 'ids required' });
  const mode = body.mode === 'enable' ? 'enable' : 'disable';

  const slow = await getSlow();
  if (!slow) return json(res, 503, { error: 'persistence data not collected yet' });

  const entries = slow.entries || [];
  const verdict = mode === 'disable'
    ? evaluatePersistence(ids, entries, { config: loadProtectedConfig() })
    : { // re-enabling is always permitted; it only ever restores prior state
        allowed: ids.map((id) => {
          const e = entries.find((x) => entryId(x) === id);
          return e
            ? { id, name: e.display || e.name, kind: e.kind, command: e.command, location: e.location, added: e.added, action: describeAction(e, 'enable') }
            : { id, name: id, kind: 'unknown', action: { op: 'unsupported', summary: 'entry not found', needsAdmin: false, destructive: false } };
        }),
        blocked: [],
      };

  const needsAdmin = verdict.allowed.filter((a) => a.action?.needsAdmin);
  const phrase = `${mode === 'disable' ? 'DISABLE' : 'ENABLE'} ${verdict.allowed.length}`;
  const planId = crypto.randomBytes(8).toString('hex');
  persistPlans.set(planId, {
    ids, mode, phrase, expiresAt: Date.now() + PLAN_TTL_MS, used: false,
    actions: verdict.allowed.map((a) => ({ id: a.id, ...a.action })),
  });
  for (const [id, p] of persistPlans) if (p.expiresAt < Date.now()) persistPlans.delete(id);

  json(res, 200, {
    planId, mode, confirmPhrase: phrase, expiresInSec: PLAN_TTL_MS / 1000,
    allowed: verdict.allowed, blocked: verdict.blocked,
    adminRequired: needsAdmin.length,
    adminNote: needsAdmin.length
      ? `${needsAdmin.length} of these need an elevated agent (HKLM keys and services). They will be reported as skipped, not silently failed.`
      : null,
  });
}

/** POST /api/persist/execute — applies a confirmed plan and manifests it. */
async function handlePersistExecute(body, res) {
  const plan = persistPlans.get(body.planId);
  if (!plan) return json(res, 404, { error: 'unknown or expired plan — run the dry run again' });
  if (plan.used) return json(res, 409, { error: 'plan already executed' });
  if (plan.expiresAt < Date.now()) { persistPlans.delete(body.planId); return json(res, 410, { error: 'plan expired' }); }
  if (body.confirm !== plan.phrase) return json(res, 403, { error: `confirmation mismatch — type exactly: ${plan.phrase}` });
  plan.used = true;

  if (!plan.actions.length) return json(res, 200, { applied: [], note: 'nothing to do' });

  // Manifest BEFORE touching the registry, the Startup folder, or any service.
  let manifest;
  try {
    manifest = writeManifest(`persist-${plan.mode}`,
      plan.actions.map((a) => ({
        pid: null, name: a.id, memMB: null,
        cmd: a.summary, path: null, ports: [],
        persistence: a,
      })),
      { confirmPhrase: plan.phrase, mode: plan.mode, ids: plan.ids });
  } catch (e) {
    return json(res, 500, { error: `manifest write failed, nothing was changed: ${e.message}` });
  }

  let run;
  try { run = await applyPersistence(plan.actions); }
  catch (e) { return json(res, 500, { error: e.message, manifestId: manifest.id }); }

  state.slowAt = 0; // next snapshot reflects the new persistence state

  const ok = run.results.filter((r) => r.ok);
  const failed = run.results.filter((r) => !r.ok);
  json(res, 200, {
    manifestId: manifest.id, mode: plan.mode, elevated: run.elevated,
    applied: ok, failed,
    note: failed.some((f) => /elevated/i.test(f.error || ''))
      ? 'Some entries need an Administrator agent. Restart Hangar elevated and re-run those.'
      : null,
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  // Served with the correct type or the browser silently ignores the manifest
  // and the app is not installable.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(res, rel) {
  const WEB_ROOT = path.join(ROOT, 'apps', 'desktop', 'src');
  const file = path.join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // No-op on loopback. When bound wider, every request needs the token —
  // assets included, so an unauthenticated caller cannot even confirm what is
  // listening here.
  if (!tokenOk(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      .end('Unauthorized');
    return;
  }

  if (url.pathname === '/api/snapshot') {
    try {
      const snap = await buildSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(snap));
    } catch (e) {
      noteError('snapshot', e);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, readOnly: READ_ONLY, version: VERSION, uptimeSec: Math.round(process.uptime()) });
  }

  if (url.pathname === '/api/manifests' && req.method === 'GET') {
    return json(res, 200, { manifests: listManifests() });
  }

  // Read-only. The Graveyard never writes, moves, or deletes anything.
  if (url.pathname === '/api/graveyard' && req.method === 'GET') {
    try {
      const [grave, snap] = await Promise.all([
        getGraveyard(url.searchParams.get('refresh') === '1'),
        buildSnapshot().catch(() => null),
      ]);
      if (!grave) return json(res, 503, { error: 'graveyard sweep has not completed yet' });

      const nowMs = Date.now();
      const classified = (grave.projects || []).map((p) => {
        const c = classifyProject(p, nowMs);
        // Carry collector-only fields the pure classifier does not know about.
        return {
          ...c,
          agent: p.agent || null,
          subject: p.subject || null,
          fileCount: p.fileCount ?? c.fileCount,
        };
      });
      const merged = mergeWithLive(classified, snap ? snap.owners : [], snap ? snap.ports : []);
      const ranked = rankGraveyard(merged);

      const byState = {};
      for (const p of ranked) byState[p.state] = (byState[p.state] || 0) + 1;

      return json(res, 200, {
        ts: grave.ts, home: grave.home, ageMs: Date.now() - state.graveAt,
        counts: { total: ranked.length, ...byState },
        projects: ranked,
      });
    } catch (e) {
      noteError('graveyard', e);
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST') {
    if (READ_ONLY) return json(res, 403, { error: 'Hangar is running in read-only mode (HANGAR_READONLY=1).' });
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }

    try {
      if (url.pathname === '/api/plan') return await handlePlan(body, res);
      if (url.pathname === '/api/execute') return await handleExecute(body, res);
      if (url.pathname === '/api/persist/plan') return await handlePersistPlan(body, res);
      if (url.pathname === '/api/persist/execute') return await handlePersistExecute(body, res);
      if (url.pathname === '/api/restore') {
        if (!body.manifestId) return json(res, 400, { error: 'manifestId required' });
        const result = restoreManifest(String(body.manifestId));

        // Persistence manifests undo by inverting their recorded actions.
        if (result.needsPersistenceExecutor) {
          const actions = result.manifest.victims
            .map((v) => (v.persistence ? { id: v.name, ...invertAction(v.persistence) } : null))
            .filter((a) => a && a.op);
          if (!actions.length) {
            return json(res, 422, {
              error: 'this manifest predates persistence-action recording and cannot be auto-restored',
              manifestId: result.manifest.id,
            });
          }
          const run = await applyPersistence(actions);
          markRestored(result.manifest.id, run.results);
          state.slowAt = 0;
          return json(res, 200, {
            ok: run.results.every((r) => r.ok),
            kind: 'persistence',
            elevated: run.elevated,
            results: run.results,
          });
        }

        state.fastAt = 0;
        return json(res, result.ok ? 200 : 404, result);
      }
    } catch (e) {
      noteError('write endpoint', e);
      return json(res, 500, { error: e.message });
    }
    return json(res, 404, { error: 'unknown endpoint' });
  }

  if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method not allowed.'); return; }

  serveStatic(res, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  HANGAR  v${VERSION}  ·  ${READ_ONLY ? 'read-only' : 'guarded writes'}`);
  console.log('  ───────────────────────────────────────────');
  console.log(`  Dashboard   http://localhost:${PORT}`);
  console.log(`  Host        ${os.hostname()}`);
  if (REMOTE) {
    const lan = Object.values(os.networkInterfaces()).flat()
      .find((n) => n && n.family === 'IPv4' && !n.internal);
    console.log(`  Remote      http://${lan ? lan.address : HOST}:${PORT}/?token=…`);
    console.log('  Auth        token required on every request');
    console.log('  ⚠  This agent is reachable from your network.');
  } else {
    console.log('  Remote      off — loopback only');
  }
  console.log(READ_ONLY
    ? '  Mode        read-only — all write endpoints disabled'
    : '  Mode        guarded — park requires dry-run + typed confirmation;\n              manifests written before any kill; restore available');
  console.log('');
  console.log('  Warming collectors…');
  Promise.all([getFast(), getSlow()])
    .then(() => console.log('  Ready.\n'))
    .catch((e) => console.error('  Collector warm-up failed:', e.message));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Start with a different one:\n    set HANGAR_PORT=7421 && node server.js\n`);
    process.exit(1);
  }
  throw e;
});
