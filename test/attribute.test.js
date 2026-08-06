'use strict';
/**
 * Attribution regression tests for the two bugs found in v0.1 on real data:
 *
 * Bug 1 — explorer rollup: every desktop-launched app inherited owner
 * "explorer" through the fallback chain, so the dashboard showed
 * "explorer 14 GB / 91 procs". Fallback owners must not propagate; only
 * signature/project matches may be inherited.
 *
 * Bug 2 — phantom roots: rootPids counted every directly-matched process,
 * so 16 sibling claude.exe renderers under one parent read as "16 roots"
 * — which then produced the false "16 orphaned Claude instances / ~7 GB"
 * cleanup premise. A root is a group member whose parent is OUTSIDE the group.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { attribute } = require('../lib/attribute');

const HOME = 'C:\\Users\\Armyg';

test('bug 1: unmatched apps launched from explorer do NOT inherit "explorer"', () => {
  const procs = [
    { pid: 100, ppid: 1, name: 'explorer.exe', memMB: 170, cpuSec: 0, cmd: 'explorer', path: 'C:\\Windows\\explorer.exe' },
    // dyad matched no signature in v0.1 and got rolled into explorer
    { pid: 200, ppid: 100, name: 'dyad.exe', memMB: 900, cpuSec: 0, cmd: '"C:\\Programs\\dyad\\dyad.exe"', path: 'C:\\Programs\\dyad\\dyad.exe' },
    { pid: 201, ppid: 200, name: 'dyad.exe', memMB: 220, cpuSec: 0, cmd: 'dyad renderer', path: 'C:\\Programs\\dyad\\dyad.exe' },
  ];
  const { owners } = attribute(procs, { homeDir: HOME });
  const explorer = owners.find((o) => o.owner === 'explorer');
  const dyad = owners.find((o) => o.owner === 'dyad');

  assert.ok(dyad, 'dyad must be its own owner');
  assert.equal(dyad.procs, 2, 'dyad renderer inherits from dyad, not explorer');
  assert.ok(explorer.memMB < 200, `explorer must hold only its own memory, got ${explorer.memMB}`);
});

test('bug 1b: signature matches still inherit through shells', () => {
  const procs = [
    { pid: 300, ppid: 1, name: 'claude.exe', memMB: 800, cpuSec: 0, cmd: 'claude main', path: 'C:\\claude\\claude.exe' },
    { pid: 301, ppid: 300, name: 'cmd.exe', memMB: 8, cpuSec: 0, cmd: 'cmd /c npx something', path: null },
    { pid: 302, ppid: 301, name: 'node.exe', memMB: 90, cpuSec: 0, cmd: 'node some-generic-thing.js', path: null },
  ];
  const { owners } = attribute(procs, { homeDir: HOME });
  const claude = owners.find((o) => o.owner === 'Claude');
  assert.ok(claude, 'Claude group exists');
  assert.equal(claude.procs, 3, 'shell and node under claude inherit Claude');
});

test('bug 2: sibling renderers under one parent are ONE root, not sixteen', () => {
  const procs = [
    { pid: 400, ppid: 1, name: 'claude.exe', memMB: 800, cpuSec: 0, cmd: 'claude main', path: null },
  ];
  // 15 renderer children, all matching the claude signature directly
  for (let i = 1; i <= 15; i++) {
    procs.push({ pid: 400 + i, ppid: 400, name: 'claude.exe', memMB: 120, cpuSec: 0, cmd: 'claude renderer', path: null });
  }
  const { owners, fanout } = attribute(procs, { homeDir: HOME });
  const claude = owners.find((o) => o.owner === 'Claude');

  assert.equal(claude.procs, 16);
  assert.equal(claude.rootPids.length, 1, `one tree = one root, got ${claude.rootPids.length}`);
  assert.deepEqual(claude.rootPids, [400]);
  // and therefore no fan-out entry: one copy is not a duplicate
  assert.ok(!fanout.find((f) => f.owner === 'Claude'), 'single tree must not appear in fan-out');
});

test('bug 2b: two independent trees of the same owner ARE two roots', () => {
  const procs = [
    { pid: 500, ppid: 1, name: 'node.exe', memMB: 100, cpuSec: 0, cmd: 'npx mongodb-mcp-server', path: null },
    { pid: 501, ppid: 500, name: 'node.exe', memMB: 80, cpuSec: 0, cmd: 'node mongodb-mcp-server/dist/index.js', path: null },
    { pid: 600, ppid: 2, name: 'node.exe', memMB: 95, cpuSec: 0, cmd: 'npx mongodb-mcp-server', path: null },
  ];
  const { owners, fanout } = attribute(procs, { homeDir: HOME });
  const mongo = owners.find((o) => o.owner === 'mongodb-mcp-server');
  assert.ok(mongo);
  assert.equal(mongo.rootPids.length, 2, 'two independent launches = two roots');
  const f = fanout.find((x) => x.owner === 'mongodb-mcp-server');
  assert.ok(f, 'genuine duplicate appears in fan-out');
  assert.equal(f.copies, 2);
});
