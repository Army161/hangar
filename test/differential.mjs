#!/usr/bin/env node
/**
 * Differential harness — the third M2 acceptance gate.
 *
 * Runs the Node stack and the Rust stack against the same live machine and
 * diffs their attribution. The two cannot sample the same instant, so an exact
 * zero-diff over every process is impossible: processes genuinely start and
 * exit between the two sweeps. What must agree is the *interpretation* — for
 * every owner both stacks saw, the kind and the root count must match, because
 * those are the two values that produced field bugs (the explorer rollup and
 * the "16 Claude roots" premise).
 *
 *   node test/differential.mjs
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// On Windows an absolute path is not a valid ESM specifier — it must be a
// file:// URL, or the loader reads "C:" as an unsupported protocol.
const { attribute } = await import(pathToFileURL(path.join(ROOT, 'lib', 'attribute.js')).href);

const RUST = path.join(ROOT, 'target', 'release', 'hangar-collect.exe');
const PS = path.join(ROOT, 'scripts', 'collect-fast.ps1');

function runNode() {
  const t = Date.now();
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const raw = JSON.parse(out);
  const ms = Date.now() - t;
  const { owners } = attribute(raw.processes, { homeDir: process.env.USERPROFILE });
  return { owners, procs: raw.processes.length, ms };
}

function runRust() {
  const t = Date.now();
  const out = execFileSync(RUST, [], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out);
  return { owners: j.owners, procs: j.processes.length, ms: Date.now() - t };
}

const pad = (s, n) => String(s).padEnd(n);

console.log('Running both stacks against the live machine…\n');
const js = runNode();
const rs = runRust();

console.log(`  node + powershell : ${pad(js.procs + ' procs', 14)} ${pad(js.owners.length + ' owners', 12)} ${js.ms} ms`);
console.log(`  rust              : ${pad(rs.procs + ' procs', 14)} ${pad(rs.owners.length + ' owners', 12)} ${rs.ms} ms`);
console.log(`  speedup           : ${(js.ms / rs.ms).toFixed(1)}×\n`);

const jsBy = new Map(js.owners.map((o) => [o.owner, o]));
const rsBy = new Map(rs.owners.map((o) => [o.owner, o]));
const shared = [...jsBy.keys()].filter((k) => rsBy.has(k));

const diffs = [];
for (const name of shared) {
  const a = jsBy.get(name);
  const b = rsBy.get(name);
  if (a.kind !== b.kind) {
    diffs.push({ owner: name, field: 'kind', node: a.kind, rust: b.kind });
  }
  // Root count is the value that produced the "16 orphaned Claude instances"
  // premise. Process churn can shift it by one; a real divergence will not be
  // that small when the owner has several roots.
  const rootDelta = Math.abs(a.rootPids.length - b.rootPids.length);
  if (rootDelta > 1) {
    diffs.push({ owner: name, field: 'rootPids', node: a.rootPids.length, rust: b.rootPids.length });
  }
}

console.log(`  owners in both stacks : ${shared.length}`);
console.log(`  node-only             : ${[...jsBy.keys()].filter((k) => !rsBy.has(k)).join(', ') || '(none)'}`);
console.log(`  rust-only             : ${[...rsBy.keys()].filter((k) => !jsBy.has(k)).join(', ') || '(none)'}\n`);

// Spot-check the owners whose misattribution caused real incidents.
console.log('  Regression checks on the owners that produced field bugs:');
for (const name of ['explorer', 'Claude', 'Windows', 'WSL 2']) {
  const a = jsBy.get(name);
  const b = rsBy.get(name);
  if (!a || !b) { console.log(`    ${pad(name, 12)} not present in both`); continue; }
  const ok = a.kind === b.kind && Math.abs(a.rootPids.length - b.rootPids.length) <= 1;
  console.log(`    ${pad(name, 12)} node: ${pad(a.rootPids.length + ' roots', 10)} ${pad(Math.round(a.memMB) + ' MB', 10)}` +
              ` rust: ${pad(b.rootPids.length + ' roots', 10)} ${pad(Math.round(b.memMB) + ' MB', 10)} ${ok ? 'OK' : 'DIVERGENT'}`);
}

if (diffs.length) {
  console.log(`\n  ${diffs.length} DIVERGENCE(S):`);
  for (const d of diffs) console.log(`    ${pad(d.owner, 26)} ${pad(d.field, 10)} node=${d.node} rust=${d.rust}`);
  process.exitCode = 1;
} else {
  console.log('\n  No divergences. Rust attribution agrees with the Node stack.');
}
