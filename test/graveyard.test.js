'use strict';
/**
 * Graveyard Scanner tests.
 *
 * The scanner finds projects you started and stopped touching. Two things make
 * that harder than "sort folders by mtime":
 *
 *   1. Repository and build noise. `.git/objects`, `node_modules`, and
 *      `target/` churn constantly — garbage collection, index rewrites, cache
 *      writes — with no human involvement. Counting them makes every abandoned
 *      project look active, which is the exact failure that would make this
 *      feature useless.
 *
 *   2. The join with live state. A folder untouched for 60 days whose server is
 *      running right now is not dormant, it is *forgotten but live* — the most
 *      valuable row in the table and the whole reason the Port Wall exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  asArray, dormancyState, isNoisePath, newestSignificant,
  classifyProject, mergeWithLive, rankGraveyard,
} = require('../lib/graveyard');

const DAY = 86400000;
const now = Date.parse('2026-08-05T12:00:00Z');
const daysAgo = (d) => new Date(now - d * DAY).toISOString();

/* ---------------- dormancy ---------------- */

test('dormancy states use the documented boundaries', () => {
  assert.equal(dormancyState(0), 'active');
  assert.equal(dormancyState(6.9), 'active');
  assert.equal(dormancyState(7), 'cooling');
  assert.equal(dormancyState(29.9), 'cooling');
  assert.equal(dormancyState(30), 'dormant');
  assert.equal(dormancyState(89.9), 'dormant');
  assert.equal(dormancyState(90), 'abandoned');
  assert.equal(dormancyState(null), 'unknown');
});

/* ---------------- noise exclusion ---------------- */

test('repository and build noise is excluded from activity', () => {
  for (const p of [
    'C:\\proj\\.git\\objects\\ab\\cdef',
    'C:\\proj\\node_modules\\left-pad\\index.js',
    'C:\\proj\\target\\debug\\build\\x.rlib',
    'C:\\proj\\.venv\\Lib\\site-packages\\x.py',
    'C:\\proj\\__pycache__\\x.pyc',
    'C:\\proj\\dist\\bundle.js',
    'C:\\proj\\.next\\cache\\x',
    'C:\\proj\\.cache\\y',
  ]) assert.equal(isNoisePath(p), true, `${p} must be noise`);
});

test('real work is not mistaken for noise', () => {
  for (const p of [
    'C:\\proj\\src\\index.js',
    'C:\\proj\\README.md',
    'C:\\proj\\package.json',
    'C:\\proj\\notes\\design.md',
    'C:\\proj\\.github\\workflows\\ci.yml',
  ]) assert.equal(isNoisePath(p), false, `${p} must count as work`);
});

test('newestSignificant ignores noise even when it is the newest file', () => {
  const files = [
    { path: 'C:\\p\\.git\\objects\\aa\\bb', mtime: daysAgo(0.1) },   // newest, noise
    { path: 'C:\\p\\node_modules\\x\\y.js', mtime: daysAgo(0.2) },   // noise
    { path: 'C:\\p\\src\\main.js', mtime: daysAgo(64) },             // the real answer
    { path: 'C:\\p\\README.md', mtime: daysAgo(80) },
  ];
  const got = newestSignificant(files);
  assert.equal(got.path, 'C:\\p\\src\\main.js');
});

test('a project with only noise reports unknown rather than fake-active', () => {
  const files = [{ path: 'C:\\p\\.git\\objects\\aa', mtime: daysAgo(0.1) }];
  assert.equal(newestSignificant(files), null);
});

/* ---------------- the PowerShell JSON boundary ----------------
 * Regression: the first live run of the scanner threw
 * "(markers || []).some is not a function". ConvertTo-Json collapses a
 * single-element array to a bare scalar, so a project with exactly one marker
 * arrives as "package.json" rather than ["package.json"]. Unit tests that hand
 * in well-formed arrays will never see this — only real collector output does.
 */

test('asArray normalises the scalar-collapse that ConvertTo-Json produces', () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray('package.json'), ['package.json']);
  assert.deepEqual(asArray(['a', 'b']), ['a', 'b']);
  assert.deepEqual(asArray({ path: 'x' }), [{ path: 'x' }]);
});

test('a project with exactly ONE marker classifies without throwing', () => {
  const p = classifyProject({
    path: 'C:\\Users\\Armyg\\solo',
    markers: 'package.json',                                  // scalar, not array
    files: { path: 'C:\\Users\\Armyg\\solo\\i.js', mtime: daysAgo(10) }, // scalar too
  }, now);
  assert.equal(p.stack, 'Node');
  assert.deepEqual(p.markers, ['package.json']);
  assert.equal(p.state, 'cooling');
  assert.equal(p.fileCount, 1);
});

test('merge survives a single-element ports list arriving as a scalar', () => {
  const projects = [classifyProject({ path: 'C:\\p\\one', markers: [], files: [{ path: 'C:\\p\\one\\a.js', mtime: daysAgo(50) }] }, now)];
  const merged = mergeWithLive(projects, { owner: 'One', projectPath: 'C:\\p\\one', ports: 8080, pids: [1] }, { port: 8080, url: 'http://localhost:8080' });
  assert.equal(merged[0].running, true);
  assert.deepEqual(merged[0].ports, [8080]);
});

/* ---------------- classification ---------------- */

test('folder names containing spaces survive intact', () => {
  const p = classifyProject({
    path: 'C:\\Users\\Armyg\\fable 5 tasty trade options 3',
    files: [{ path: 'C:\\Users\\Armyg\\fable 5 tasty trade options 3\\run_scan.bat', mtime: daysAgo(40) }],
    markers: ['bat'],
  }, now);
  assert.equal(p.name, 'fable 5 tasty trade options 3');
  assert.equal(p.state, 'dormant');
});

test('markers determine what the project appears to be', () => {
  const node = classifyProject({ path: 'C:\\p\\web', markers: ['package.json'], files: [{ path: 'C:\\p\\web\\a.js', mtime: daysAgo(2) }] }, now);
  const rust = classifyProject({ path: 'C:\\p\\svc', markers: ['Cargo.toml'], files: [{ path: 'C:\\p\\svc\\main.rs', mtime: daysAgo(2) }] }, now);
  const py = classifyProject({ path: 'C:\\p\\bot', markers: ['requirements.txt'], files: [{ path: 'C:\\p\\bot\\b.py', mtime: daysAgo(2) }] }, now);
  assert.match(node.stack, /node/i);
  assert.match(rust.stack, /rust/i);
  assert.match(py.stack, /python/i);
});

test('agent session stores are classified separately from code projects', () => {
  const a = classifyProject({
    path: 'C:\\Users\\Armyg\\AppData\\Local\\hermes',
    kind: 'agent-sessions',
    sessionCount: 12,
    files: [{ path: 'C:\\Users\\Armyg\\AppData\\Local\\hermes\\sessions\\x.json', mtime: daysAgo(5) }],
    markers: [],
  }, now);
  assert.equal(a.kind, 'agent-sessions');
  assert.equal(a.sessionCount, 12);
});

/* ---------------- the join with live state ---------------- */

test('a long-dormant folder with a running process is FORGOTTEN BUT LIVE', () => {
  const projects = [classifyProject({
    path: 'C:\\Users\\Armyg\\.openclaw',
    markers: ['package.json'],
    files: [{ path: 'C:\\Users\\Armyg\\.openclaw\\gateway.cmd', mtime: daysAgo(62) }],
  }, now)];
  const owners = [{ owner: 'OpenClaw Gateway', projectPath: 'C:\\Users\\Armyg\\.openclaw', memMB: 197, ports: [18789], pids: [13840] }];
  const merged = mergeWithLive(projects, owners, [{ port: 18789, url: 'http://localhost:18789', probe: { http: true, title: 'OpenClaw' } }]);

  assert.equal(merged[0].running, true);
  assert.equal(merged[0].state, 'live-forgotten', 'dormant + running is its own state');
  assert.deepEqual(merged[0].ports, [18789]);
  assert.equal(merged[0].url, 'http://localhost:18789');
});

test('a recently-touched project with a running process is simply active', () => {
  const projects = [classifyProject({
    path: 'C:\\Users\\Armyg\\OUROBOROS',
    markers: ['.git'],
    files: [{ path: 'C:\\Users\\Armyg\\OUROBOROS\\loop.js', mtime: daysAgo(1) }],
  }, now)];
  const merged = mergeWithLive(projects, [{ owner: 'OUROBOROS', projectPath: 'C:\\Users\\Armyg\\OUROBOROS', pids: [1], ports: [] }], []);
  assert.equal(merged[0].running, true);
  assert.equal(merged[0].state, 'active');
});

test('path matching is case-insensitive and separator-insensitive', () => {
  const projects = [classifyProject({ path: 'C:\\Users\\Armyg\\TAO_WALLET', markers: [], files: [{ path: 'C:\\Users\\Armyg\\TAO_WALLET\\x.py', mtime: daysAgo(3) }] }, now)];
  const merged = mergeWithLive(projects, [{ owner: 'TAO_WALLET', projectPath: 'c:/users/armyg/tao_wallet', pids: [9], ports: [] }], []);
  assert.equal(merged[0].running, true);
});

test('merge never invents a project that was not scanned', () => {
  const merged = mergeWithLive([], [{ owner: 'Ghost', projectPath: 'C:\\nope', pids: [1] }], []);
  assert.equal(merged.length, 0);
});

/* ---------------- ranking ---------------- */

test('ranking surfaces forgotten-but-live first, then oldest with the most evidence', () => {
  const mk = (name, days, running, ports = [], sessions = 0) => ({
    name, path: `C:\\p\\${name}`, daysDormant: days, running, ports,
    sessionCount: sessions, state: running && days >= 30 ? 'live-forgotten' : dormancyState(days),
  });
  const ranked = rankGraveyard([
    mk('fresh', 2, false),
    mk('old-dead', 200, false),
    mk('old-live', 60, true, [18789]),
    mk('mid-sessions', 45, false, [], 30),
  ]);
  assert.equal(ranked[0].name, 'old-live', 'something still serving beats everything');
  assert.notEqual(ranked[ranked.length - 1].name, 'old-live');
  assert.equal(ranked[ranked.length - 1].name, 'fresh', 'actively-worked projects rank last');
});

test('ranking is stable and total — nothing is dropped', () => {
  const input = Array.from({ length: 20 }, (_, i) => ({
    name: `p${i}`, daysDormant: i * 7, running: i % 5 === 0, ports: [], sessionCount: 0,
    state: dormancyState(i * 7),
  }));
  const ranked = rankGraveyard(input);
  assert.equal(ranked.length, input.length);
  assert.deepEqual(new Set(ranked.map((r) => r.name)), new Set(input.map((r) => r.name)));
});
