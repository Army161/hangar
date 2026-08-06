'use strict';
/**
 * Guard tests. The first block is a regression test for the 2026-07-29 incident:
 * a batch kill of the MT5 dashboard tree included terminal64.exe (a protected
 * trading terminal), and the deny-list guard silently failed to block it.
 *
 * Root cause then: the guard emitted log strings inside a PowerShell
 * Where-Object block, polluting the pipeline so blocked items passed anyway.
 * The structural lesson encoded here: a guard must RETURN verdicts as data,
 * every requested pid must appear in exactly one of allowed/blocked, and
 * protection must be evaluated AFTER tree expansion, on the final kill list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateKill } = require('../lib/guard');

/** Minimal process-table stub mirroring the real 2026-07-29 layout. */
function mt5Scenario() {
  return [
    // my own session chain
    { pid: 68340, ppid: 36824, name: 'pwsh.exe', cmd: 'pwsh -NoProfile' },
    { pid: 36824, ppid: 24248, name: 'claude.exe', cmd: 'claude renderer' },
    { pid: 24248, ppid: 10268, name: 'claude.exe', cmd: 'claude main' },
    { pid: 10268, ppid: 10216, name: 'explorer.exe', cmd: 'explorer' },
    // MT5 dashboard tree: python server spawned terminal64 as a child
    { pid: 11380, ppid: 4444, name: 'python.exe', cmd: 'python C:\\Users\\Armyg\\metatrader5-tradingbot\\dashboard\\server.py' },
    { pid: 41660, ppid: 11380, name: 'terminal64.exe', cmd: '"C:\\Program Files\\MetaTrader 5\\terminal64.exe"' },
    // unrelated killable process
    { pid: 46456, ppid: 4444, name: 'bun.exe', cmd: 'C:\\Users\\Armyg\\.bun\\bin\\bun.exe server.ts' },
    // protected-by-project process
    { pid: 33333, ppid: 4444, name: 'python.exe', cmd: 'python C:\\Users\\Armyg\\TAO_WALLET\\tao_alerts.py' },
    { pid: 44444, ppid: 4444, name: 'node.exe', cmd: 'node C:\\Users\\Armyg\\OUROBOROS\\loop.js' },
    // system process
    { pid: 4, ppid: 0, name: 'System', cmd: null },
    { pid: 555, ppid: 4, name: 'svchost.exe', cmd: 'svchost -k netsvcs' },
    // defender
    { pid: 4812, ppid: 555, name: 'MsMpEng.exe', cmd: null },
    // ollama
    { pid: 29768, ppid: 10268, name: 'ollama.exe', cmd: 'ollama serve' },
  ];
}

const OPTS = { protectedPids: [68340, 36824, 24248, 10268], selfPid: 99999 };

test('MT5 regression: killing the dashboard tree must block terminal64.exe', () => {
  const procs = mt5Scenario();
  // The exact request from the incident: kill the :8899 dashboard, expand tree.
  const verdict = evaluateKill([11380], procs, { ...OPTS, includeTree: true });

  const allowedPids = verdict.allowed.map((v) => v.pid);
  const blockedPids = verdict.blocked.map((v) => v.pid);

  // terminal64 was pulled in by tree expansion — it MUST be blocked.
  assert.ok(blockedPids.includes(41660), 'terminal64.exe must be blocked');
  assert.ok(!allowedPids.includes(41660), 'terminal64.exe must not be allowed');
  // the dashboard itself is a legitimate target
  assert.ok(allowedPids.includes(11380), 'the dashboard python is killable');
  // the blocked entry must say why
  const t = verdict.blocked.find((v) => v.pid === 41660);
  assert.match(t.reason, /protected/i);
});

test('every requested pid lands in exactly one bucket — no silent drops', () => {
  const procs = mt5Scenario();
  const req = [11380, 46456, 4812, 29768];
  const verdict = evaluateKill(req, procs, { ...OPTS, includeTree: true });
  const all = [...verdict.allowed, ...verdict.blocked].map((v) => v.pid);
  // tree expansion adds 41660 under 11380
  const expected = new Set([...req, 41660]);
  assert.equal(all.length, new Set(all).size, 'no pid may appear twice');
  assert.deepEqual(new Set(all), expected, 'every expanded pid is accounted for');
});

test('deny list blocks by name: system, defender, ollama', () => {
  const verdict = evaluateKill([4, 555, 4812, 29768], mt5Scenario(), OPTS);
  assert.equal(verdict.allowed.length, 0);
  assert.equal(verdict.blocked.length, 4);
});

test('protected chain blocks my own session even if requested directly', () => {
  const verdict = evaluateKill([24248, 36824], mt5Scenario(), OPTS);
  assert.equal(verdict.allowed.length, 0);
  for (const b of verdict.blocked) assert.match(b.reason, /session|chain/i);
});

test('protected projects (TAO_WALLET, OUROBOROS) block by command line', () => {
  const verdict = evaluateKill([33333, 44444], mt5Scenario(), OPTS);
  assert.equal(verdict.allowed.length, 0);
  assert.equal(verdict.blocked.length, 2);
});

test('tree expansion cannot smuggle a protected pid into allowed', () => {
  // Request a parent whose subtree contains BOTH killable and protected procs.
  const procs = mt5Scenario();
  procs.push({ pid: 4444, ppid: 10216, name: 'cmd.exe', cmd: 'cmd /c stuff' });
  const verdict = evaluateKill([4444], procs, { ...OPTS, includeTree: true });
  const allowedPids = verdict.allowed.map((v) => v.pid);
  assert.ok(!allowedPids.includes(41660), 'terminal64 blocked via deep expansion');
  assert.ok(!allowedPids.includes(33333), 'TAO blocked via deep expansion');
  assert.ok(!allowedPids.includes(44444) || true, 'OUROBOROS node evaluated');
  const ouro = verdict.blocked.find((v) => v.pid === 44444);
  assert.ok(ouro, 'OUROBOROS process must be in blocked');
});

test('guard protects the hangar server itself', () => {
  const procs = mt5Scenario();
  procs.push({ pid: 7777, ppid: 4444, name: 'node.exe', cmd: 'node hangar/server.js' });
  const verdict = evaluateKill([7777], procs, { ...OPTS, selfPid: 7777 });
  assert.equal(verdict.allowed.length, 0);
  assert.match(verdict.blocked[0].reason, /hangar/i);
});

test('verdict is pure data: no strings mixed into arrays (the PS bug class)', () => {
  const verdict = evaluateKill([11380, 46456], mt5Scenario(), { ...OPTS, includeTree: true });
  for (const v of [...verdict.allowed, ...verdict.blocked]) {
    assert.equal(typeof v, 'object', 'bucket items must be objects, never strings');
    assert.equal(typeof v.pid, 'number');
  }
});
