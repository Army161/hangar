'use strict';
/**
 * Persistence control tests.
 *
 * This is the layer that actually makes cleanup stick. Process kills are
 * temporary — on 2026-07-29 WSL was back within the hour via its scheduled
 * task. The July 30-31 session proved the opposite: disabling extensions and
 * plugins survived a reboot and took free RAM from 632 MB to 6.9 GB.
 *
 * Because this writes to the registry, the Startup folder, Task Scheduler and
 * the service database, the guard here is stricter than the process guard and
 * NOTHING is ever deleted:
 *   - Startup files are MOVED to a quarantine folder, not removed.
 *   - Registry values are recorded verbatim, then the value is removed.
 *   - Tasks are disabled, never unregistered.
 *   - Services have their StartupType changed, never deleted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { entryId, evaluatePersistence, describeAction, invertAction } = require('../lib/persistence');

function entries() {
  return [
    { kind: 'startup-folder', name: 'Ollama', location: 'C:\\Users\\Armyg\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', command: '...\\Startup\\Ollama.lnk', target: 'C:\\Users\\Armyg\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Ollama.lnk', added: '2026-04-04T15:03:21', enabled: true },
    { kind: 'startup-folder', name: 'TikTok', location: 'C:\\Users\\Armyg\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup', command: '...\\Startup\\TikTok.lnk', target: '...\\Startup\\TikTok.lnk', added: '2026-04-02T03:53:35', enabled: true },
    { kind: 'startup-folder', name: 'tao_alerts_autostart', location: '...Startup', command: '...\\tao_alerts_autostart.vbs', target: 'C:\\Users\\Armyg\\...\\tao_alerts_autostart.vbs', added: '2026-06-12T18:47:00', enabled: true },
    { kind: 'registry-run', name: 'SignalRgb', location: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', command: '"C:\\Users\\Armyg\\AppData\\Local\\VortxEngine\\SignalRgbLauncher.exe" --silent', target: 'C:\\...\\SignalRgbLauncher.exe', enabled: true },
    { kind: 'registry-run', name: 'SecurityHealth', location: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', command: 'C:\\Windows\\system32\\SecurityHealthSystray.exe', target: 'C:\\Windows\\system32\\SecurityHealthSystray.exe', enabled: true },
    { kind: 'scheduled-task', name: 'TAO Alerts Watchdog', location: '\\', command: 'wscript.exe "C:\\Users\\Armyg\\TAO_WALLET\\run_alerts.vbs"', enabled: true, state: 'Ready' },
    { kind: 'scheduled-task', name: 'StartWSL2OnBoot', location: '\\', command: "wsl.exe -d Ubuntu -- bash -c 'exit 0'", enabled: true, state: 'Ready' },
    { kind: 'scheduled-task', name: 'PredictionArbScan', location: '\\', command: '"C:\\Users\\Armyg\\fable 5 tasty trade options 3\\run_scan.bat"', enabled: true, state: 'Ready' },
    { kind: 'service', name: 'WinDefend', display: 'Microsoft Defender Antivirus Service', location: 'Services', command: 'C:\\ProgramData\\...\\MsMpEng.exe', enabled: true, state: 'Running' },
    { kind: 'service', name: 'SignalRgb.Service', display: 'SignalRgb.Service', location: 'Services', command: 'C:\\...\\SignalRgbService.exe', enabled: true, state: 'Running' },
    { kind: 'service', name: 'WSLService', display: 'WSL Service', location: 'Services', command: 'C:\\Program Files\\WSL\\wslservice.exe', enabled: true, state: 'Running' },
  ];
}

const CFG = { names: ['ollama', 'terminal64', 'OneDrive'], projects: ['TAO_WALLET', 'OUROBOROS'] };
const OPTS = { config: CFG };

test('entryId is stable and unique per entry', () => {
  const es = entries();
  const ids = es.map(entryId);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  assert.equal(entryId(es[0]), entryId({ ...es[0] }), 'same entry yields same id');
});

test('protected apps cannot be disabled — Ollama startup entry', () => {
  const es = entries();
  const v = evaluatePersistence([entryId(es[0])], es, OPTS);
  assert.equal(v.allowed.length, 0);
  assert.match(v.blocked[0].reason, /protected/i);
});

test('protected projects cannot be disabled — TAO_WALLET watchdog', () => {
  const es = entries();
  const tao = es.find((e) => e.name === 'TAO Alerts Watchdog');
  const v = evaluatePersistence([entryId(tao)], es, OPTS);
  assert.equal(v.allowed.length, 0);
  assert.match(v.blocked[0].reason, /protected project/i);
});

test('security software is never disablable, even by name request', () => {
  const es = entries();
  const ids = [entryId(es.find((e) => e.name === 'SecurityHealth')), entryId(es.find((e) => e.name === 'WinDefend'))];
  const v = evaluatePersistence(ids, es, OPTS);
  assert.equal(v.allowed.length, 0);
  assert.equal(v.blocked.length, 2);
  for (const b of v.blocked) assert.match(b.reason, /security/i);
});

test('core Windows services are protected', () => {
  const es = entries();
  const wsl = es.find((e) => e.name === 'WSLService');
  const v = evaluatePersistence([entryId(wsl)], es, OPTS);
  assert.equal(v.allowed.length, 0, 'WSLService is infrastructure, not a user app');
});

test('ordinary entries are allowed: TikTok shortcut, SignalRgb run key, arb scan', () => {
  const es = entries();
  const ids = ['TikTok', 'SignalRgb', 'PredictionArbScan'].map((n) => entryId(es.find((e) => e.name === n)));
  const v = evaluatePersistence(ids, es, OPTS);
  assert.equal(v.allowed.length, 3);
  assert.equal(v.blocked.length, 0);
});

test('every requested id lands in exactly one bucket', () => {
  const es = entries();
  const ids = es.map(entryId);
  const v = evaluatePersistence(ids, es, OPTS);
  const all = [...v.allowed, ...v.blocked].map((x) => x.id);
  assert.equal(all.length, ids.length);
  assert.deepEqual(new Set(all), new Set(ids));
});

test('unknown ids are reported, not silently dropped', () => {
  const es = entries();
  const v = evaluatePersistence(['does::not::exist'], es, OPTS);
  assert.equal(v.allowed.length, 0);
  assert.equal(v.blocked.length, 1);
  assert.match(v.blocked[0].reason, /not found/i);
});

test('already-disabled entries are not offered again', () => {
  const es = entries();
  es[1].enabled = false;
  const v = evaluatePersistence([entryId(es[1])], es, OPTS);
  assert.equal(v.allowed.length, 0);
  assert.match(v.blocked[0].reason, /already disabled/i);
});

/* ---- action shape: what will actually be done, and can it be undone ---- */

test('startup-folder disable MOVES the file, never deletes it', () => {
  const a = describeAction(entries()[1], 'disable');
  assert.equal(a.op, 'move-file');
  assert.ok(a.to.includes('quarantine'), 'destination is the quarantine folder');
  assert.equal(a.destructive, false);
  assert.equal(a.needsAdmin, false);
});

test('registry-run disable records the value before removing it', () => {
  const es = entries();
  const a = describeAction(es.find((e) => e.name === 'SignalRgb'), 'disable');
  assert.equal(a.op, 'registry-remove-value');
  assert.equal(a.recordedValue, '"C:\\Users\\Armyg\\AppData\\Local\\VortxEngine\\SignalRgbLauncher.exe" --silent');
  assert.equal(a.destructive, false, 'recoverable because the value is recorded');
});

test('HKLM registry needs admin, HKCU does not', () => {
  const es = entries();
  const hkcu = describeAction(es.find((e) => e.name === 'SignalRgb'), 'disable');
  const hklm = describeAction({ ...es[3], location: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' }, 'disable');
  assert.equal(hkcu.needsAdmin, false);
  assert.equal(hklm.needsAdmin, true);
});

test('scheduled task disable never unregisters', () => {
  const es = entries();
  const a = describeAction(es.find((e) => e.name === 'PredictionArbScan'), 'disable');
  assert.equal(a.op, 'task-disable');
  assert.match(a.command, /Disable-ScheduledTask/);
  assert.doesNotMatch(a.command, /Unregister/);
});

test('service disable changes StartupType and records the old one', () => {
  const es = entries();
  const a = describeAction({ ...es.find((e) => e.name === 'SignalRgb.Service'), startMode: 'Auto' }, 'disable');
  assert.equal(a.op, 'service-startuptype');
  assert.equal(a.previous, 'Auto');
  assert.equal(a.needsAdmin, true);
  assert.doesNotMatch(a.command, /Remove-Service|sc\.exe delete/);
});

test('enable is the exact inverse of disable for every kind', () => {
  const es = entries();

  // File moves invert by swapping endpoints, so undo lands the file exactly
  // where it started — that is the invariant, not a differing command string.
  const tik = es.find((x) => x.name === 'TikTok');
  const dMove = describeAction(tik, 'disable');
  const uMove = describeAction(tik, 'enable');
  assert.equal(uMove.from, dMove.to, 'enable reads from where disable wrote');
  assert.equal(uMove.to, dMove.from, 'enable writes back to the original path');

  // Registry and task/service actions invert by op or command.
  const sig = es.find((x) => x.name === 'SignalRgb');
  assert.equal(describeAction(sig, 'disable').op, 'registry-remove-value');
  assert.equal(describeAction(sig, 'enable').op, 'registry-restore-value');

  const arb = es.find((x) => x.name === 'PredictionArbScan');
  assert.match(describeAction(arb, 'disable').command, /Disable-ScheduledTask/);
  assert.match(describeAction(arb, 'enable').command, /Enable-ScheduledTask/);

  const svc = { ...es.find((x) => x.name === 'SignalRgb.Service'), startMode: 'Auto' };
  assert.match(describeAction(svc, 'disable').command, /StartupType Disabled/);
  assert.match(describeAction(svc, 'enable').command, /StartupType Auto/);
});

/* ---- undo from the manifest alone ----
 * Regression: the first real persistence change (2026-08-05, three social
 * shortcuts) wrote a manifest containing only prose — "Move Facebook.lnk out
 * of Startup into quarantine" — because writeManifest dropped the action
 * object. Restore would have tried to spawn that sentence as a process.
 * A disabled entry usually vanishes from the collector entirely, so the
 * manifest is the ONLY remaining record and must be sufficient by itself.
 */
test('invertAction round-trips every op back to the original state', () => {
  const es = entries();
  const cases = [
    es.find((e) => e.name === 'TikTok'),
    es.find((e) => e.name === 'SignalRgb'),
    es.find((e) => e.name === 'PredictionArbScan'),
    { ...es.find((e) => e.name === 'SignalRgb.Service'), startMode: 'Auto' },
  ];
  for (const e of cases) {
    const forward = describeAction(e, 'disable');
    const back = invertAction(forward);
    assert.ok(back, `${e.name}: must be invertible`);
    const again = invertAction(back);
    assert.equal(again.op, forward.op, `${e.name}: double inversion returns the original op`);
    if (forward.op === 'move-file') {
      assert.equal(back.from, forward.to);
      assert.equal(back.to, forward.from);
      assert.equal(again.from, forward.from, 'file returns to where it started');
    }
    if (forward.op === 'service-startuptype') {
      assert.equal(back.target, forward.previous, 'service returns to its old StartupType');
    }
  }
});

test('invertAction carries the data needed with no live entry available', () => {
  // Simulate restoring long after the entry disappeared from the collector.
  const forward = describeAction(entries().find((e) => e.name === 'SignalRgb'), 'disable');
  const back = invertAction(JSON.parse(JSON.stringify(forward)));
  assert.equal(back.op, 'registry-restore-value');
  assert.equal(back.hive, forward.hive);
  assert.equal(back.valueName, 'SignalRgb');
  assert.ok(back.recordedValue.includes('SignalRgbLauncher.exe'), 'the value survives the round trip');
});

test('an action object with no op cannot be inverted into something dangerous', () => {
  assert.equal(invertAction(null), null);
  assert.equal(invertAction({}), null);
  assert.equal(invertAction({ op: 'unsupported' }), null);
});

test('no action of any kind is destructive', () => {
  const es = entries();
  for (const e of es) {
    for (const mode of ['disable', 'enable']) {
      const a = describeAction(e, mode);
      assert.equal(a.destructive, false, `${e.name} ${mode} must be non-destructive`);
      assert.doesNotMatch(String(a.command || ''), /Remove-Item|Unregister-|sc\.exe delete|Remove-Service|del /i);
    }
  }
});
