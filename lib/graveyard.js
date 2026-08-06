'use strict';
/**
 * Graveyard Scanner — finds the projects you started and stopped touching.
 *
 * Pure logic only. The filesystem sweep lives in scripts/collect-graveyard.ps1;
 * everything here takes raw listings and returns classified, ranked data, so it
 * ports to Rust in M2 with its tests intact.
 *
 * Two hard problems this solves:
 *
 *   1. Repository and build noise. `.git/objects`, `node_modules`, `target/`
 *      and friends are rewritten by tooling with no human involved. Naively
 *      taking the newest mtime makes every abandoned project look like it was
 *      touched this morning, which would make the whole feature useless.
 *
 *   2. The join with live state. A folder untouched for two months whose server
 *      is still listening is not "dormant" — it is forgotten but live, and it
 *      is the single most valuable row the product can show.
 */

const path = require('path');

const DAY = 86400000;

/**
 * PowerShell's ConvertTo-Json collapses a single-element array to a bare
 * scalar, so a project with exactly one marker arrives as `"package.json"`
 * rather than `["package.json"]`. Every list crossing that boundary has to be
 * normalised or the first single-marker project throws.
 */
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Paths written by tooling rather than by a person. */
const NOISE = [
  /[\\/]\.git[\\/](?!.*[\\/]workflows[\\/])/i,   // .git internals, but keep .github/workflows
  /[\\/]node_modules[\\/]/i,
  /[\\/]target[\\/](debug|release)[\\/]/i,
  /[\\/]\.venv[\\/]/i,
  /[\\/]venv[\\/]/i,
  /[\\/]__pycache__[\\/]/i,
  /[\\/]dist[\\/]/i,
  /[\\/]build[\\/]/i,
  /[\\/]\.next[\\/]/i,
  /[\\/]\.nuxt[\\/]/i,
  /[\\/]\.cache[\\/]/i,
  /[\\/]\.turbo[\\/]/i,
  /[\\/]coverage[\\/]/i,
  /[\\/]\.pytest_cache[\\/]/i,
  /[\\/]\.mypy_cache[\\/]/i,
  /\.(log|tmp|lock|pyc|pdb|obj)$/i,
];

function isNoisePath(p) {
  const s = String(p || '').replace(/\//g, '\\');
  // .github is real work even though it starts with a dot
  if (/[\\/]\.github[\\/]/i.test(s)) return false;
  return NOISE.some((re) => re.test(s));
}

/** Newest file that a human plausibly touched, or null if there is none. */
function newestSignificant(files) {
  let best = null;
  for (const f of asArray(files)) {
    if (!f || !f.mtime || isNoisePath(f.path)) continue;
    if (!best || Date.parse(f.mtime) > Date.parse(best.mtime)) best = f;
  }
  return best;
}

function dormancyState(days) {
  if (days == null || Number.isNaN(days)) return 'unknown';
  if (days < 7) return 'active';
  if (days < 30) return 'cooling';
  if (days < 90) return 'dormant';
  return 'abandoned';
}

/** Marker files → a human-readable stack label. First match wins. */
const STACKS = [
  { m: /^Cargo\.toml$/i, label: 'Rust' },
  { m: /^package\.json$/i, label: 'Node' },
  { m: /^(requirements\.txt|pyproject\.toml|Pipfile)$/i, label: 'Python' },
  { m: /^go\.mod$/i, label: 'Go' },
  { m: /^(pom\.xml|build\.gradle)$/i, label: 'JVM' },
  { m: /^Gemfile$/i, label: 'Ruby' },
  { m: /^composer\.json$/i, label: 'PHP' },
  { m: /^docker-compose\.ya?ml$/i, label: 'Docker Compose' },
  { m: /^Dockerfile$/i, label: 'Docker' },
  { m: /\.sln$/i, label: '.NET' },
  { m: /^bat$/i, label: 'Batch scripts' },
];

function stackFrom(markers) {
  const list = asArray(markers);
  for (const s of STACKS) {
    if (list.some((m) => s.m.test(m))) return s.label;
  }
  return list.includes('.git') ? 'Git repo' : 'Unknown';
}

/**
 * Turn a raw scanned folder into a classified project.
 * @param {object} raw  { path, files[], markers[], kind?, sessionCount?, sizeMB?, git? }
 * @param {number} nowMs
 */
function classifyProject(raw, nowMs = Date.now()) {
  const files = asArray(raw.files);
  const markers = asArray(raw.markers);
  const newest = newestSignificant(files);
  const lastTouched = newest ? newest.mtime : (raw.gitLastCommit || null);
  const daysDormant = lastTouched ? (nowMs - Date.parse(lastTouched)) / DAY : null;

  const evidence = [];
  if (newest) evidence.push({ source: 'file', detail: path.basename(newest.path), at: newest.mtime });
  if (raw.gitLastCommit) evidence.push({ source: 'git', detail: raw.gitBranch || 'HEAD', at: raw.gitLastCommit });
  if (raw.sessionCount) evidence.push({ source: 'sessions', detail: `${raw.sessionCount} session(s)`, at: lastTouched });

  return {
    name: path.basename(raw.path),
    path: raw.path,
    kind: raw.kind || 'project',
    stack: stackFrom(markers),
    markers,
    lastTouched,
    daysDormant: daysDormant == null ? null : Math.round(daysDormant * 10) / 10,
    state: dormancyState(daysDormant),
    sizeMB: raw.sizeMB ?? null,
    fileCount: files.filter((f) => f && !isNoisePath(f.path)).length,
    sessionCount: raw.sessionCount || 0,
    gitBranch: raw.gitBranch || null,
    gitLastCommit: raw.gitLastCommit || null,
    evidence,
    running: false,
    ports: [],
    url: null,
    owner: null,
  };
}

function normPath(p) {
  return String(p || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}

/**
 * Join scanned projects with what is running right now.
 *
 * A dormant folder whose process is alive gets its own state — `live-forgotten`
 * — because that combination is the product's headline finding, not an edge
 * case. It is how Kortix and OpenClaw surfaced on this machine.
 */
function mergeWithLive(projects, owners, ports) {
  const portByNumber = new Map(asArray(ports).map((p) => [p.port, p]));

  return asArray(projects).map((proj) => {
    const key = normPath(proj.path);
    const owner = asArray(owners).find((o) => {
      const op = normPath(o.projectPath);
      return op && (op === key || op.startsWith(key + '\\') || key.startsWith(op + '\\'));
    });
    if (!owner) return proj;

    const ownPorts = asArray(owner.ports);
    const live = ownPorts.map((n) => portByNumber.get(n)).filter(Boolean);
    const browsable = live.find((p) => p.probe && p.probe.http);

    return {
      ...proj,
      running: true,
      owner: owner.owner,
      memMB: owner.memMB ?? null,
      ports: ownPorts,
      url: browsable ? browsable.url : (ownPorts.length ? `http://localhost:${ownPorts[0]}` : null),
      title: browsable && browsable.probe.title ? browsable.probe.title : null,
      // Running code in a folder nobody has edited in a month is the find.
      state: proj.daysDormant != null && proj.daysDormant >= 30 ? 'live-forgotten' : 'active',
    };
  });
}

/**
 * Order by how much the user probably wants to see it:
 * still-serving-but-forgotten first, then by dormancy weighted by evidence.
 */
function rankGraveyard(projects) {
  const score = (p) => {
    let s = 0;
    if (p.state === 'live-forgotten') s += 10_000;
    else if (p.running) s -= 5_000;                  // actively worked: least interesting
    s += Math.min(p.daysDormant || 0, 365) * 5;      // older ranks higher, capped
    s += asArray(p.ports).length * 200;               // something was served here
    s += Math.min(p.sessionCount || 0, 100) * 10;    // conversations happened here
    return s;
  };
  return [...asArray(projects)]
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))      // stable on ties
    .map((x) => x.p);
}

module.exports = {
  asArray, dormancyState, isNoisePath, newestSignificant, stackFrom,
  classifyProject, mergeWithLive, rankGraveyard,
};
