'use strict';
/**
 * Hangar attribution engine.
 *
 * Turns an anonymous process table into named owners. This is the piece every
 * other view sits on top of: a PID is useless, "OpenClaw Gateway serving :18789"
 * is actionable.
 *
 * Strategy, in order:
 *   1. Match the command line against a signature table (most specific wins).
 *   2. Failing that, look for a project folder under the user's home.
 *   3. Failing that, inherit from the nearest ancestor that matched.
 *   4. Failing that, fall back to the executable name.
 */

const KIND = {
  MCP: 'mcp',
  AGENT: 'agent',
  RUNTIME: 'ai-runtime',
  PROJECT: 'project',
  DEVTOOL: 'devtool',
  APP: 'app',
  SYSTEM: 'system',
  SHELL: 'shell',
};

// ---------------------------------------------------------------------------
// Signature table. Order matters — first match wins, so put specific before broad.
//
// ADD YOUR OWN PROJECTS HERE. If Hangar labels something "node.exe" that you
// know is really "Portfolio Site", add a line and it is named everywhere at once.
// ---------------------------------------------------------------------------
const SIGNATURES = [
  // --- agent runtimes -------------------------------------------------------
  { re: /[\\/]\.openclaw[\\/]|node_modules[\\/]openclaw[\\/]/i, kind: KIND.AGENT, name: 'OpenClaw Gateway', reattach: true },
  { re: /AppData[\\/]Local[\\/]hermes[\\/](?!bin[\\/])|hermes_cli/i, kind: KIND.AGENT, name: 'Hermes Agent', reattach: true },
  { re: /ollama[\\/]ollama[\s"]|ollama\.exe|ollama app\.exe/i, kind: KIND.RUNTIME, name: 'Ollama', reattach: true },
  { re: /\bclaude\.exe\b/i, kind: KIND.AGENT, name: 'Claude', reattach: true },
  { re: /cursor\.exe/i, kind: KIND.AGENT, name: 'Cursor' },

  // --- Claude extensions: pull the vendor + package out of the folder id -----
  {
    re: /Claude Extensions[\\/]([\w.\-]+)/i,
    kind: KIND.MCP,
    name: (m) => {
      const parts = m[1].split('.');
      return parts.length > 1 ? parts[parts.length - 1] : m[1];
    },
    vendor: (m) => {
      const p = m[1].split('.');
      return p.length > 2 ? p[p.length - 2] : null;
    },
  },

  // --- MCP servers by package shape ----------------------------------------
  { re: /mcp-server-([\w\-]+)/i, kind: KIND.MCP, name: (m) => `mcp-server-${m[1]}` },
  {
    re: /awslabs\.([\w_\-]+?)(?:-mcp-server|_mcp_server)/i,
    kind: KIND.MCP,
    // Package ids already carry the aws- prefix half the time; don't double it.
    name: (m) => { const n = m[1].replace(/_/g, '-'); return /^aws-?/i.test(n) ? n : `aws-${n}`; },
    vendor: 'awslabs',
  },
  { re: /mcp-proxy-for-aws/i, kind: KIND.MCP, name: 'mcp-proxy-for-aws', vendor: 'awslabs' },
  { re: /@([\w\-]+)[\\/]([\w\-]*mcp[\w\-]*)/i, kind: KIND.MCP, name: (m) => m[2], vendor: (m) => m[1] },
  { re: /node_modules[\\/]@([\w\-]+)[\\/]([\w\-]+)/i, kind: KIND.MCP, name: (m) => m[2], vendor: (m) => m[1] },
  { re: /\b([\w\-]+-mcp(?:-server)?)\b/i, kind: KIND.MCP, name: (m) => m[1] },
  { re: /\bserena\b/i, kind: KIND.MCP, name: 'serena' },
  { re: /\bdesktop-?commander\b/i, kind: KIND.MCP, name: 'desktop-commander' },

  // --- dev tooling ----------------------------------------------------------
  { re: /\b(vite|webpack|next dev|nodemon|ts-node|esbuild|turbopack)\b/i, kind: KIND.DEVTOOL, name: (m) => m[1].split(' ')[0], serves: true },
  { re: /\b(uvicorn|gunicorn|flask|django)\b/i, kind: KIND.DEVTOOL, name: (m) => m[1], serves: true },
  // Only the WSL plumbing itself. A bare `wsl.exe -- <your script>` is YOUR
  // project running in Linux, not "WSL", so it falls through to project matching.
  { re: /wslrelay\.exe|wslservice\.exe|wslhost\.exe|vmmemWSL|\bvmmem\b/i, kind: KIND.SYSTEM, name: 'WSL 2' },
  { re: /Docker Desktop|com\.docker/i, kind: KIND.APP, name: 'Docker Desktop' },

  // --- named desktop apps worth calling out ---------------------------------
  { re: /SignalRgb/i, kind: KIND.APP, name: 'SignalRGB' },
  { re: /terminal64\.exe|MetaTrader/i, kind: KIND.APP, name: 'MetaTrader 5', reattach: true },
  { re: /Wondershare|Filmora|WsToastNotification/i, kind: KIND.APP, name: 'Wondershare Filmora' },
  { re: /OneDrive/i, kind: KIND.APP, name: 'OneDrive' },
  { re: /TradingView/i, kind: KIND.APP, name: 'TradingView' },
  { re: /msedgewebview2/i, kind: KIND.SYSTEM, name: 'Edge WebView2' },
  { re: /MsMpEng|MpDefenderCoreService|SecurityHealth/i, kind: KIND.SYSTEM, name: 'Microsoft Defender' },
  { re: /MSPCManager/i, kind: KIND.APP, name: 'Microsoft PC Manager' },
  { re: /nvcontainer|NVDisplay|NVIDIA/i, kind: KIND.SYSTEM, name: 'NVIDIA' },
];

// Folders under the home directory that are plumbing, not projects.
const NOT_A_PROJECT = new Set([
  'appdata', 'scoop', 'onedrive', 'documents', 'downloads', 'desktop', 'pictures',
  'videos', 'music', 'node_modules', '.cache', '.claude', '.cursor', '.vscode',
  '.git', '.npm', '.nuget', '.dotnet', '.gradle', '.docker', '.ssh', 'nvm4w',
  'contacts', 'favorites', 'links', 'searches', 'saved games', '3d objects',
]);

const SHELLS = new Set(['cmd.exe', 'conhost.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe']);
const SYSTEM_PROCS = new Set([
  'svchost.exe', 'System', 'Registry', 'smss.exe', 'csrss.exe', 'wininit.exe',
  'services.exe', 'lsass.exe', 'winlogon.exe', 'fontdrvhost.exe', 'dwm.exe',
  'RuntimeBroker.exe', 'Memory Compression', 'System Idle Process', 'dllhost.exe',
  'sihost.exe', 'taskhostw.exe', 'ctfmon.exe', 'spoolsv.exe', 'audiodg.exe',
]);

function resolveField(field, match) {
  if (typeof field === 'function') return field(match);
  return field || null;
}

// Extractions that technically matched but carry no information. If a rule
// produces one of these, fall through and let a later rule try.
const BAD_NAMES = new Set([
  'mcp', 'mcp-server', 'server', 'index', 'main', 'dist', 'build', 'bin', '.bin',
  'npm', 'npx', 'node', 'run', 'start', 'cli', 'lib', 'src', 'app', '.', '..',
  // CLI verbs that look like package names when scraped out of an argv.
  'start-mcp-server', 'run-mcp-server', 'serve', 'stdio', 'notebook-tools',
]);

/** Match one process against the signature table. Returns null if nothing fits. */
function matchSignature(proc) {
  const hay = `${proc.cmd || ''} ${proc.path || ''} ${proc.name || ''}`;
  for (const sig of SIGNATURES) {
    const m = hay.match(sig.re);
    if (!m) continue;
    const owner = resolveField(sig.name, m);
    // A rule that resolves to a meaningless label is worse than no rule at all.
    if (!owner || BAD_NAMES.has(String(owner).toLowerCase())) continue;
    return {
      owner,
      kind: sig.kind,
      vendor: resolveField(sig.vendor, m),
      reattach: !!sig.reattach,
      serves: !!sig.serves,
      confidence: 'signature',
    };
  }
  return null;
}

/**
 * Look for a real project folder under the user's home directory.
 * Handles both Windows paths and the /mnt/c/... form that WSL commands use, so
 * `wsl.exe -- python /mnt/c/Users/you/MyBot/run.py` is attributed to MyBot
 * rather than to WSL itself.
 */
function matchProject(proc, homeDir) {
  const cmd = proc.cmd || proc.path || '';
  if (!cmd || !homeDir) return null;

  const user = homeDir.split(/[\\/]/).pop();
  const escHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Folder names routinely contain spaces ("task manager and terminal check"),
  // so consume up to the next separator or quote rather than the next space.
  const patterns = [
    new RegExp(`${escHome}[\\\\/]([^\\\\/"]+?)(?=[\\\\/"]|$)`, 'gi'),
    new RegExp(`/mnt/[a-z]/users/${user}/([^/"]+?)(?=[/"]|$)`, 'gi'),
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(cmd)) !== null) {
      const folder = m[1];
      if (NOT_A_PROJECT.has(folder.toLowerCase())) continue;
      if (/\.(exe|dll|txt|json|log|md)$/i.test(folder)) continue;
      return {
        owner: folder,
        kind: KIND.PROJECT,
        confidence: 'project-path',
        projectPath: `${homeDir}\\${folder}`,
        reattach: true,
      };
    }
  }
  return null;
}

/**
 * Attribute every process. Returns processes decorated with owner info plus
 * owner-level rollups. Memory is charged to the owner at the top of each
 * attributed subtree, so nothing is counted twice.
 */
function attribute(processes, opts = {}) {
  const homeDir = opts.homeDir || null;
  const byPid = new Map();
  for (const p of processes) byPid.set(p.pid, p);

  const direct = new Map(); // pid -> attribution matched on this process itself
  for (const p of processes) {
    const hit = matchSignature(p) || matchProject(p, homeDir);
    if (hit) direct.set(p.pid, hit);
  }

  // Resolve each process to an owner, inheriting from the nearest matched ancestor.
  const resolved = new Map();
  function resolve(pid, seen = new Set()) {
    if (resolved.has(pid)) return resolved.get(pid);
    if (seen.has(pid)) return null; // cycle guard
    seen.add(pid);

    const proc = byPid.get(pid);
    if (!proc) return null;

    let out;
    const own = direct.get(pid);
    if (own) {
      out = { ...own, ownerPid: pid, inherited: false, propagatable: 'always' };
    } else {
      const parent = byPid.get(proc.ppid);
      const fromParent = parent ? resolve(proc.ppid, seen) : null;
      // Inheritance rules — this is what fixes the v0.1 "explorer 14 GB" bug:
      //  - signature/project matches propagate to all descendants;
      //  - exe-name fallbacks propagate ONLY to same-named children (an
      //    app's own renderer processes), never across executables. explorer
      //    launches half the desktop; nothing should inherit it by fallback.
      const canInherit = fromParent && (
        fromParent.propagatable === 'always' ||
        (fromParent.propagatable === 'same-exe' && fromParent.srcName === proc.name)
      );
      if (canInherit) {
        out = { ...fromParent, inherited: true, confidence: 'inherited' };
      } else if (SYSTEM_PROCS.has(proc.name)) {
        out = { owner: 'Windows', kind: KIND.SYSTEM, ownerPid: pid, inherited: false, confidence: 'system', propagatable: false };
      } else if (SHELLS.has(proc.name)) {
        out = { owner: 'Loose shell', kind: KIND.SHELL, ownerPid: pid, inherited: false, confidence: 'shell', propagatable: false };
      } else {
        out = {
          owner: proc.name.replace(/\.exe$/i, ''), kind: KIND.APP, ownerPid: pid,
          inherited: false, confidence: 'exe-name',
          propagatable: 'same-exe', srcName: proc.name,
        };
      }
    }
    resolved.set(pid, out);
    return out;
  }

  const decorated = processes.map((p) => {
    const a = resolve(p.pid) || {};
    return {
      ...p,
      owner: a.owner || p.name,
      kind: a.kind || KIND.APP,
      vendor: a.vendor || null,
      ownerPid: a.ownerPid ?? p.pid,
      inherited: !!a.inherited,
      confidence: a.confidence || 'exe-name',
      reattach: !!a.reattach,
      projectPath: a.projectPath || null,
    };
  });

  // Roll up by owner.
  const groups = new Map();
  for (const p of decorated) {
    const key = `${p.kind}::${p.owner}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, owner: p.owner, kind: p.kind, vendor: p.vendor,
        procs: 0, memMB: 0, cpuSec: 0, pids: [],
        reattach: p.reattach, projectPath: p.projectPath, oldest: p.started,
      });
    }
    const g = groups.get(key);
    g.procs += 1;
    g.memMB += p.memMB;
    g.cpuSec += p.cpuSec;
    g.pids.push(p.pid);
    if (p.started && (!g.oldest || p.started < g.oldest)) g.oldest = p.started;
    if (p.reattach) g.reattach = true;
    if (p.projectPath && !g.projectPath) g.projectPath = p.projectPath;
  }

  // A root is a member whose PARENT is outside the group. Direct-match count
  // is the wrong definition: 16 sibling renderers all match the signature
  // directly, but they are one tree — and one tree is one root. Getting this
  // wrong is what produced the false "16 orphaned Claude instances" premise
  // that nearly took down a live session during the 07-29 cleanup.
  const owners = [...groups.values()]
    .map((g) => {
      const memberSet = new Set(g.pids);
      const rootPids = g.pids.filter((pid) => {
        const proc = byPid.get(pid);
        return !proc || !memberSet.has(proc.ppid);
      });
      return { ...g, memMB: Math.round(g.memMB * 10) / 10, rootPids };
    })
    .sort((a, b) => b.memMB - a.memMB);

  // Fan-out: the same owner started independently more than once.
  const fanout = owners
    .filter((g) => g.rootPids.length > 1 && g.kind !== KIND.SYSTEM)
    .map((g) => ({
      owner: g.owner, kind: g.kind, vendor: g.vendor,
      copies: g.rootPids.length, procs: g.procs, memMB: g.memMB,
      // Keeping one copy would return roughly what the extra copies hold.
      reclaimMB: Math.round((g.memMB * (g.rootPids.length - 1) / g.rootPids.length) * 10) / 10,
    }))
    .sort((a, b) => b.reclaimMB - a.reclaimMB);

  return { processes: decorated, owners, fanout };
}

// ---------------------------------------------------------------------------
// Origin tracing: link a running process back to the thing that launched it.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'the', 'and', 'for', 'gateway', 'service', 'update', 'updater', 'task', 'user',
  'auto', 'autostart', 'start', 'startup', 'launch', 'launcher', 'run', 'core',
  'helper', 'host', 'app', 'apps', 'exe', 'cmd', 'main', 'tool', 'tools', 'win',
  'windows', 'microsoft', 'system', 'machine', 'daily', 'metrics', 'reporting',
  // Path furniture. These live in nearly every command line on the box, so
  // matching on them made SignalRGB look like the origin of every MCP server.
  'users', 'appdata', 'local', 'roaming', 'program', 'programs', 'files',
  'common', 'data', 'temp', 'bin', 'scripts', 'dist', 'build', 'node_modules',
  'python', 'node', 'wscript', 'powershell', 'pwsh', 'conhost', 'installsource',
  'scheduler', 'background', 'silent', 'hidden', 'prefetch', 'checkinstall',
  'processstart', 'fromrunkey', 'session', 'startinstances', 'wake',
  // Generic English nouns that turn up in both entry names and unrelated argv.
  // "watchdog" matched chrome-devtools-mcp to a TAO task purely by coincidence.
  'watchdog', 'send', 'store', 'manager', 'sync', 'push', 'native', 'check',
  'scan', 'client', 'agent', 'desktop', 'mobile', 'player', 'viewer', 'editor',
  'studio', 'assistant', 'experience', 'platform', 'deployment', 'broker',
  'notification', 'install', 'installer', 'setup', 'config', 'default',
]);

// 5, not 4: four-letter fragments ("send", "note", "core") collide constantly.
const MIN_TOKEN = 5;

function tokens(str) {
  return [...new Set(
    String(str || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= MIN_TOKEN && !STOPWORDS.has(t) && !/^\d+$/.test(t))
  )];
}

// Runtimes that host somebody else's code. If an entry's target is one of
// these, "same executable" proves nothing — half the machine runs node.exe.
const GENERIC_RUNTIMES = new Set([
  'node.exe', 'python.exe', 'pythonw.exe', 'python3.exe', 'cmd.exe', 'wscript.exe',
  'cscript.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'uv.exe', 'uvx.exe',
  'wsl.exe', 'npx.cmd', 'npm.cmd', 'rundll32.exe', 'dllhost.exe',
]);

function norm(p) {
  return String(p || '').toLowerCase().replace(/\//g, '\\').replace(/^"|"$/g, '');
}

/**
 * Score how well a persistence entry explains a process, then keep the best
 * match per process. Path equality is strong evidence; distinctive name tokens
 * appearing in the command line are how we catch indirection like
 * "OpenClaw Gateway.cmd" -> gateway.cmd -> node.exe.
 */
function traceOrigins(decorated, entries) {
  if (!entries || !entries.length) return new Map();

  const prepared = entries.map((e) => ({
    entry: e,
    target: norm(e.target),
    targetLeaf: norm(e.target).split('\\').pop(),
    // Tokens come from the entry NAME and its target filename only — not the
    // full path, which is mostly shared directory names.
    toks: tokens(`${e.name} ${e.display || ''} ${norm(e.target).split('\\').pop() || ''}`),
  }));

  // Any token shared by several entries is describing the machine, not the
  // entry. Drop those rather than trying to guess a stopword list by hand.
  const df = new Map();
  for (const c of prepared) for (const t of c.toks) df.set(t, (df.get(t) || 0) + 1);
  const MAX_DF = Math.max(2, Math.floor(prepared.length * 0.1));
  for (const c of prepared) c.toks = c.toks.filter((t) => df.get(t) <= MAX_DF);

  // Entry-side rarity is not enough. A token can be unique among startup
  // entries yet appear in hundreds of command lines — "hermes" is a folder in
  // Claude's bundled toolchain, so every MCP server mentions it. Counting how
  // many PROCESSES contain a token is what separates identity from furniture.
  const haystacks = decorated.map((p) => `${norm(p.cmd)} ${norm(p.path)}`);
  const procDf = new Map();
  const allToks = new Set();
  for (const c of prepared) for (const t of c.toks) allToks.add(t);
  for (const t of allToks) {
    let n = 0;
    for (const h of haystacks) if (h.includes(t)) n++;
    procDf.set(t, n);
  }

  /** How much a token match is worth, given how many processes mention it. */
  function tokenWeight(t) {
    const n = procDf.get(t) || 0;
    if (n <= 3) return 8;   // near-unique: this token identifies the thing
    if (n <= 12) return 3;  // shared by a handful: a hint, not proof
    return 0;               // everywhere: says nothing
  }

  const out = new Map();
  for (const p of decorated) {
    if (p.inherited) continue; // only trace the root of each owner subtree
    const pPath = norm(p.path);
    const pCmd = norm(p.cmd);
    if (!pPath && !pCmd) continue;

    let best = null;
    for (const cand of prepared) {
      let score = 0;
      const why = [];
      const genericTarget = GENERIC_RUNTIMES.has(cand.targetLeaf);

      // A service that literally reports this PID is not a guess.
      if (cand.entry.kind === 'service' && cand.entry.svcPid && cand.entry.svcPid === p.pid) {
        score += 20; why.push('service reports this PID');
      }
      // Exact binary identity, but only when the binary means something.
      if (cand.target && pPath && cand.target === pPath && !genericTarget) {
        score += 12; why.push('exact binary path');
      } else if (cand.targetLeaf && !genericTarget && pPath.endsWith('\\' + cand.targetLeaf)) {
        score += 5; why.push('same executable');
      }
      // The launcher's own path appearing inside the command line is strong:
      // it is how indirection like Foo.cmd -> node foo/index.js shows up.
      if (cand.target && cand.target.length > 12 && pCmd.includes(cand.target)) {
        score += 10; why.push('launcher path in command line');
      }
      // Distinctive name tokens, now that generic ones are filtered out.
      // A token unique to one entry ("ollama", "openclaw") is nearly proof on
      // its own; a token shared by a handful of entries is only a hint.
      const hits = cand.toks
        .filter((t) => pCmd.includes(t) || pPath.includes(t))
        .filter((t) => tokenWeight(t) > 0);
      if (hits.length) {
        for (const t of hits) score += tokenWeight(t);
        why.push(`name match: ${hits.join(', ')}`);
      }

      // A path or PID signal is verifiable; a name match is inference. Say which
      // so a wrong guess is visible in the UI instead of reading as fact.
      const hard = why.some((w) => /binary path|command line|reports this PID|same executable/.test(w));
      if (score > 0 && (!best || score > best.score)) {
        best = { ...cand.entry, score, why, confidence: hard ? 'confirmed' : 'likely' };
      }
    }

    // One near-unique name token clears this; one weak generic signal does not.
    // Better to say "launched by hand" than to assert a wrong origin.
    if (best && best.score >= 8) out.set(p.pid, best);
  }
  return out;
}

module.exports = { attribute, traceOrigins, KIND, SIGNATURES };
