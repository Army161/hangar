'use strict';
/**
 * Manifest tests, covering the two restore bugs found in live v0.2 testing:
 *   - conhost.exe was captured by tree expansion and marked restorable, but
 *     its command line is an NT-namespace path (\??\C:\...) that cannot be
 *     respawned;
 *   - restore reported success while nothing came back, because `cmd /c`
 *     strips the outer quote pair from a quoted command, corrupting paths
 *     that contain spaces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../lib/manifest');

const { splitArgv, isRestorable } = __test;

test('splitArgv keeps quoted paths with spaces intact', () => {
  const cmd = '"C:\\Program Files\\MetaTrader 5\\terminal64.exe" /portable --flag';
  assert.deepEqual(splitArgv(cmd), [
    'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
    '/portable',
    '--flag',
  ]);
});

test('splitArgv handles the real node invocation that failed to restore', () => {
  const cmd = '"C:\\nvm4w\\nodejs\\node.exe" "C:\\Users\\Armyg\\App Data\\victim.js"';
  const argv = splitArgv(cmd);
  assert.equal(argv.length, 2);
  assert.equal(argv[0], 'C:\\nvm4w\\nodejs\\node.exe');
  assert.equal(argv[1], 'C:\\Users\\Armyg\\App Data\\victim.js');
});

test('splitArgv handles unquoted commands', () => {
  assert.deepEqual(splitArgv('ollama serve'), ['ollama', 'serve']);
});

test('conhost is never restorable', () => {
  assert.equal(isRestorable({
    name: 'conhost.exe',
    cmd: '\\??\\C:\\Windows\\system32\\conhost.exe 0x4',
    path: 'C:\\Windows\\system32\\conhost.exe',
  }), false);
});

test('NT-namespace command lines are rejected regardless of process name', () => {
  assert.equal(isRestorable({ name: 'weird.exe', cmd: '\\??\\C:\\x\\weird.exe 0x1' }), false);
});

test('a normal process with a path is restorable', () => {
  assert.equal(isRestorable({
    name: 'node.exe',
    cmd: '"C:\\nvm4w\\nodejs\\node.exe" server.js',
    path: 'C:\\nvm4w\\nodejs\\node.exe',
  }), true);
});

test('a process with no path and no cmd is not restorable', () => {
  assert.equal(isRestorable({ name: 'ghost.exe', cmd: null, path: null }), false);
});
