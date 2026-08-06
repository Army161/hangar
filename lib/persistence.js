'use strict';
/**
 * Persistence control — the layer that makes cleanup survive a reboot.
 *
 * Killing a process is temporary. On 2026-07-29 WSL was back within the hour
 * because a scheduled task relaunches it. The only changes that lasted on this
 * machine were configuration changes: the 2026-07-30 session disabled plugins
 * and removed extensions, and free RAM went from 632 MB to 6.9 GB across a
 * reboot. This module does that class of change, reversibly.
 *
 * Invariants, same shape as lib/guard.js:
 *   1. Pure functions. Verdicts and action descriptions are returned as data.
 *   2. Every requested id lands in exactly one bucket — allowed or blocked.
 *   3. NOTHING is deleted. Startup files move to quarantine; registry values
 *      are recorded verbatim before removal; tasks are disabled, not
 *      unregistered; services get a StartupType change, not a delete.
 *   4. Admin-requiring actions are labelled up front rather than failing
 *      halfway — the `cowork-svc.exe` access-denied lesson from 07-29.
 */

const path = require('path');

const QUARANTINE = path.join(__dirname, '..', 'quarantine');

/** Stable identifier for a persistence entry across snapshots. */
function entryId(entry) {
  return `${entry.kind}::${entry.location || ''}::${entry.name}`;
}

/**
 * Never disablable, regardless of what the caller asks for. Losing these
 * either blinds the machine's defences or breaks the OS.
 */
const SECURITY = [
  /^SecurityHealth/i, /^WinDefend$/i, /^MDCoreSvc$/i, /^Sense$/i,
  /^wscsvc$/i, /^MsMpEng/i, /Defender/i, /^SgrmBroker$/i,
];

const CORE_SERVICES = [
  /^WSLService$/i, /^LxssManager$/i, /^Winmgmt$/i, /^RpcSs$/i, /^Dhcp$/i,
  /^Dnscache$/i, /^EventLog$/i, /^Schedule$/i, /^BFE$/i, /^mpssvc$/i,
  /^CryptSvc$/i, /^TrustedInstaller$/i, /^wuauserv$/i, /^ClickToRunSvc$/i,
  /^NvContainer/i, /^nvagent$/i, /^AudioSrv/i, /^Audiosrv$/i,
];

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Decide which persistence entries may be disabled.
 *
 * @param {string[]} ids       entryId values the caller wants to act on
 * @param {Array}    entries   the full persistence entry list from the collector
 * @param {object}   opts      { config: {names, projects} }
 */
function evaluatePersistence(ids, entries, opts = {}) {
  const cfg = opts.config || { names: [], projects: [] };
  const nameDeny = (cfg.names || []).map((n) => new RegExp('^' + escapeRe(n), 'i'));
  const projectDeny = (cfg.projects || []).map((n) => new RegExp(escapeRe(n), 'i'));

  const byId = new Map(entries.map((e) => [entryId(e), e]));
  const allowed = [];
  const blocked = [];

  for (const id of ids) {
    const e = byId.get(id);
    if (!e) {
      blocked.push({ id, name: id, reason: 'not found — the entry list changed since the plan' });
      continue;
    }
    const item = {
      id, name: e.display || e.name, kind: e.kind,
      command: e.command || null, location: e.location || null, added: e.added || null,
    };
    const hay = `${e.name} ${e.display || ''} ${e.command || ''} ${e.target || ''}`;

    let reason = null;
    if (e.enabled === false || e.state === 'Disabled') {
      reason = 'already disabled — nothing to do';
    } else if (SECURITY.some((re) => re.test(e.name) || re.test(e.display || ''))) {
      reason = 'protected: security software';
    } else if (e.kind === 'service' && CORE_SERVICES.some((re) => re.test(e.name))) {
      reason = 'protected: core system service';
    } else if (projectDeny.some((re) => re.test(hay))) {
      reason = 'protected project (config/protected.json)';
    } else if (nameDeny.some((re) => re.test(e.name) || re.test(path.basename(e.target || '')))) {
      reason = 'protected: on your protected-apps list (config/protected.json)';
    }

    if (reason) blocked.push({ ...item, reason });
    else allowed.push({ ...item, action: describeAction(e, 'disable') });
  }

  allowed.sort((a, b) => a.id.localeCompare(b.id));
  blocked.sort((a, b) => a.id.localeCompare(b.id));
  return { allowed, blocked };
}

/**
 * Describe exactly what will be done to an entry — the command, whether it
 * needs elevation, and whether anything is destroyed. This is what the dry-run
 * preview shows, so it must be literal rather than approximate.
 */
function describeAction(entry, mode /* 'disable' | 'enable' */) {
  const disable = mode === 'disable';

  switch (entry.kind) {
    case 'startup-folder': {
      const file = entry.target || entry.command;
      const base = path.basename(file);
      const parked = path.join(QUARANTINE, 'startup', base);
      return {
        op: 'move-file',
        from: disable ? file : parked,
        to: disable ? parked : file,
        // Moving preserves the file byte-for-byte; the only loss would be the
        // folder it sat in, which we record on both sides.
        destructive: false,
        needsAdmin: /ProgramData/i.test(file || ''),
        summary: disable
          ? `Move ${base} out of Startup into quarantine`
          : `Move ${base} back into Startup`,
      };
    }

    case 'registry-run': {
      const hklm = /^HKLM/i.test(entry.location || '');
      return {
        op: disable ? 'registry-remove-value' : 'registry-restore-value',
        hive: entry.location,
        valueName: entry.name,
        // Recording the exact value is what makes removal reversible.
        recordedValue: entry.command,
        destructive: false,
        needsAdmin: hklm,
        summary: disable
          ? `Remove Run value "${entry.name}" from ${entry.location} (value recorded)`
          : `Recreate Run value "${entry.name}" in ${entry.location}`,
      };
    }

    case 'scheduled-task': {
      const full = `${(entry.location || '\\').replace(/\\+$/, '')}\\${entry.name}`.replace(/^\\\\/, '\\');
      const verb = disable ? 'Disable-ScheduledTask' : 'Enable-ScheduledTask';
      return {
        op: disable ? 'task-disable' : 'task-enable',
        taskName: entry.name,
        taskPath: entry.location || '\\',
        command: `${verb} -TaskName '${entry.name}' -TaskPath '${entry.location || '\\'}'`,
        destructive: false,
        // Tasks the user registered are user-owned; system ones need admin.
        needsAdmin: /^\\Microsoft\\/i.test(entry.location || ''),
        summary: disable
          ? `Disable scheduled task ${full} (definition kept)`
          : `Re-enable scheduled task ${full}`,
      };
    }

    case 'service': {
      const previous = entry.startMode || 'Auto';
      const target = disable ? 'Disabled' : previous;
      return {
        op: 'service-startuptype',
        serviceName: entry.name,
        previous,
        target,
        command: `Set-Service -Name '${entry.name}' -StartupType ${target}`,
        destructive: false,
        needsAdmin: true,
        summary: disable
          ? `Set service ${entry.name} StartupType to Disabled (was ${previous})`
          : `Restore service ${entry.name} StartupType to ${previous}`,
      };
    }

    default:
      return {
        op: 'unsupported',
        destructive: false,
        needsAdmin: false,
        summary: `No supported action for kind "${entry.kind}"`,
      };
  }
}

/**
 * Invert a recorded action so a manifest can be undone.
 *
 * This works from the action stored in the manifest, not from a live entry —
 * which matters because a disabled entry often disappears from the collector
 * entirely (a moved Startup file is no longer in the Startup folder, a removed
 * Run value is no longer in the key). The manifest is the only remaining
 * record, so it has to be sufficient on its own.
 */
function invertAction(action) {
  if (!action || !action.op) return null;
  switch (action.op) {
    case 'move-file':
      return {
        ...action, op: 'move-file',
        from: action.to, to: action.from,
        summary: `Move ${path.basename(action.from || '')} back to its original location`,
      };
    case 'registry-remove-value':
      return {
        ...action, op: 'registry-restore-value',
        summary: `Recreate Run value "${action.valueName}" in ${action.hive}`,
      };
    case 'registry-restore-value':
      return {
        ...action, op: 'registry-remove-value',
        summary: `Remove Run value "${action.valueName}" from ${action.hive}`,
      };
    case 'task-disable':
      return {
        ...action, op: 'task-enable',
        command: `Enable-ScheduledTask -TaskName '${action.taskName}' -TaskPath '${action.taskPath}'`,
        summary: `Re-enable scheduled task ${action.taskName}`,
      };
    case 'task-enable':
      return {
        ...action, op: 'task-disable',
        command: `Disable-ScheduledTask -TaskName '${action.taskName}' -TaskPath '${action.taskPath}'`,
        summary: `Disable scheduled task ${action.taskName}`,
      };
    case 'service-startuptype':
      return {
        ...action, op: 'service-startuptype',
        previous: action.target, target: action.previous,
        command: `Set-Service -Name '${action.serviceName}' -StartupType ${action.previous}`,
        summary: `Restore service ${action.serviceName} StartupType to ${action.previous}`,
      };
    default:
      return null;
  }
}

module.exports = { entryId, evaluatePersistence, describeAction, invertAction, QUARANTINE };
