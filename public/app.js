'use strict';
/* Hangar dashboard. Polls the local agent and renders four views. */

const REFRESH_MS = 5000;

const state = {
  snap: null,
  view: 'owners',
  expanded: new Set(),
  ownerSort: 'memMB',
  ownerKind: 'all',
  portFilter: 'all',
  originFilter: 'all',
  q: { owners: '', ports: '', origins: '', graveyard: '' },
  graveyard: null,
  graveFilter: 'all',
  loading: false,
  selected: new Set(),        // owner keys ticked for parking
  selectedEntries: new Set(), // persistence entry ids ticked for disabling
  manifests: [],
  plan: null,                 // process park plan
  persistPlan: null,          // persistence plan
};

/* ---------------- helpers ---------------- */
const $ = (sel) => document.querySelector(sel);

/* Everything interpolated into innerHTML below goes through esc(). This matters
   most for probe titles: those are <title> strings scraped from whatever is
   listening on a local port, i.e. genuinely untrusted third-party content. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Only ever emit a localhost URL we rebuilt ourselves from a numeric port. */
const safeUrl = (port) => `http://localhost:${Number(port) || 0}`;

const OWNER_HEADER = `<div class="row-h">
  <span></span><span>Owner</span><span class="num">Memory</span>
  <span class="num cpu-h">CPU now</span><span class="num">Procs</span><span class="origin-h">Origin</span>
</div>`;

/* Owners that must never be selectable for parking. The server-side guard in
   lib/guard.js is the real authority — this only keeps the UI honest so we
   never present a checkbox for something that would be refused anyway. */
const UNSELECTABLE_KINDS = new Set(['system']);
function selectable(o) {
  if (UNSELECTABLE_KINDS.has(o.kind)) return false;
  if (/^(Claude|Windows|explorer|Ollama|OneDrive|SignalRGB|Microsoft Defender|NVIDIA)$/i.test(o.owner)) return false;
  return true;
}

function mb(v) {
  if (v == null) return '—';
  return v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${Math.round(v)} MB`;
}
function ageFrom(iso) {
  if (!iso) return null;
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Number.isFinite(days) ? days : null;
}
function ageLabel(iso) {
  const d = ageFrom(iso);
  if (d == null) return '—';
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h`;
  if (d < 14) return `${Math.round(d)}d`;
  if (d < 90) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)}mo`;
}
function dateLabel(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function kindChip(kind) {
  return `<span class="chip k-${esc(kind)}">${esc(kind)}</span>`;
}
const MINE = new Set(['agent', 'project', 'ai-runtime', 'devtool']);

/* ---------------- data ---------------- */
async function poll() {
  state.loading = true;
  paintPulse();
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!res.ok) throw new Error(`agent returned ${res.status}`);
    state.snap = await res.json();
    renderAll();
  } catch (e) {
    $('#errors').innerHTML =
      `<div class="err">Could not reach the Hangar agent — ${esc(e.message)}. Is <span class="mono">node server.js</span> still running?</div>`;
  } finally {
    state.loading = false;
    paintPulse();
  }
}

function paintPulse() {
  const el = $('#pulse');
  el.classList.toggle('loading', state.loading);
  const s = state.snap;
  $('#pulse-txt').textContent = state.loading
    ? 'reading…'
    : s ? `updated ${new Date(s.ts).toLocaleTimeString()}` : 'no data';
}

/* ---------------- render ---------------- */
function renderAll() {
  const s = state.snap;
  if (!s) return;

  $('#errors').innerHTML = (s.errors && s.errors.length)
    ? `<div class="err">${s.errors.map((e) => esc(e.msg)).join('<br>')}</div>` : '';

  const badge = $('#mode-badge');
  badge.textContent = s.readOnly ? 'read-only' : `v${s.version || '0.2'} · guarded`;
  badge.style.borderColor = badge.style.color = s.readOnly ? 'var(--good)' : 'var(--signal)';

  renderGauges(s);
  $('#c-owners').textContent = s.counts.owners;
  $('#c-ports').textContent = s.counts.ports;
  $('#c-origins').textContent = s.counts.persistence;
  $('#c-fanout').textContent = s.fanout.length;

  renderOwners(s);
  renderPorts(s);
  renderOrigins(s);
  renderFanout(s);
  if (state.graveyard) renderGraveyard();
}

function renderGauges(s) {
  const sy = s.system;
  const memPct = Math.round((sy.usedGB / sy.totalGB) * 100);
  const topOwner = s.owners.find((o) => o.kind !== 'system') || s.owners[0];
  const g = [
    { n: sy.procCount, l: 'Processes', cls: sy.procCount > 500 ? 'hot' : sy.procCount > 300 ? 'warn' : '', pct: Math.min(100, sy.procCount / 8) },
    { n: `${sy.usedGB}<small>/${sy.totalGB} GB</small>`, l: 'Memory held', cls: memPct > 80 ? 'hot' : memPct > 60 ? 'warn' : '', pct: memPct },
    { n: s.counts.owners, l: 'Distinct owners', cls: '', pct: Math.min(100, s.counts.owners * 1.4) },
    { n: `${s.counts.browsable}<small>/${s.counts.ports}</small>`, l: 'Live local apps', cls: '', pct: (s.counts.browsable / Math.max(1, s.counts.ports)) * 100 },
    { n: s.fanout.length, l: 'Duplicated owners', cls: s.fanout.length > 5 ? 'warn' : '', pct: Math.min(100, s.fanout.length * 9) },
    { n: `${Math.floor(sy.uptimeMin / 60)}h ${sy.uptimeMin % 60}m`, l: 'Since boot', cls: '', pct: Math.min(100, sy.uptimeMin / 14.4) },
  ];

  // VRAM became the binding constraint on this machine once system RAM was
  // fixed — a local model needing ~6.6 GB OOMs below ~5 GB free. Untracked
  // memory is the exact problem Hangar exists to surface.
  if (s.vram) {
    const usedPct = (s.vram.usedMB / s.vram.totalMB) * 100;
    const freeGB = (s.vram.freeMB / 1024).toFixed(1);
    g.push({
      n: `${freeGB}<small>/${(s.vram.totalMB / 1024).toFixed(0)} GB</small>`,
      l: 'VRAM free',
      cls: s.vram.freeMB < 4096 ? 'hot' : s.vram.freeMB < 6656 ? 'warn' : '',
      pct: usedPct,
    });
  }
  $('#gauges').innerHTML = g.map((x) => `
    <div class="g ${x.cls}">
      <span class="n">${x.n}</span>
      <span class="l">${x.l}</span>
      <div class="bar"><i class="${x.cls === 'hot' ? 'crit' : ''}" style="width:${Math.min(100, x.pct)}%"></i></div>
    </div>`).join('') +
    (topOwner ? `<div class="g"><span class="n">${mb(topOwner.memMB).replace(/ (GB|MB)/, '<small>$1</small>')}</span>
      <span class="l">Top owner · ${esc(topOwner.owner).slice(0, 16)}</span>
      <div class="bar"><i style="width:${Math.min(100, (topOwner.memMB / 1024 / state.snap.system.totalGB) * 100)}%"></i></div></div>` : '');
}

function renderOwners(s) {
  const q = state.q.owners.toLowerCase();
  let list = s.owners.filter((o) => {
    if (state.ownerKind === 'mine' && !MINE.has(o.kind)) return false;
    if (state.ownerKind === 'mcp' && o.kind !== 'mcp') return false;
    if (state.ownerKind === 'system' && o.kind !== 'system') return false;
    if (!q) return true;
    return `${o.owner} ${o.vendor || ''} ${o.kind}`.toLowerCase().includes(q);
  });

  const key = state.ownerSort;
  list = list.slice().sort((a, b) =>
    key === 'owner' ? a.owner.localeCompare(b.owner) : (b[key] || 0) - (a[key] || 0));

  const max = Math.max(...list.map((o) => o.memMB), 1);

  if (!list.length) { $('#owners').innerHTML = OWNER_HEADER + '<div class="empty">Nothing matches that filter.</div>'; return; }

  $('#owners').innerHTML = OWNER_HEADER + list.map((o) => {
    const open = state.expanded.has(o.key);
    const org = o.origin;
    const old = org && ageFrom(org.added) > 14;
    return `
      <div class="row" data-key="${esc(o.key)}" aria-expanded="${open}" role="button" tabindex="0">
        ${selectable(o)
          ? `<input type="checkbox" class="row-check" data-sel="${esc(o.key)}" ${state.selected.has(o.key) ? 'checked' : ''} aria-label="Select ${esc(o.owner)} for parking">`
          : `<span class="dot" style="background:var(--k-${esc(o.kind)})" title="protected — cannot be parked"></span>`}
        <span class="name-cell">
          <span class="name">
            <span class="txt">${esc(o.owner)}</span>
            ${kindChip(o.kind)}
            ${o.ports.length ? `<span class="chip port">:${o.ports.slice(0, 2).join(' :')}</span>` : ''}
            ${o.reattach ? '<span class="chip solid">reattachable</span>' : ''}
          </span>
          <span class="sub">${o.vendor ? esc(o.vendor) + ' · ' : ''}${o.rootPids.length} root${o.rootPids.length > 1 ? 's' : ''} · pid ${o.rootPids.slice(0, 3).join(', ')}</span>
        </span>
        <span class="num big">${mb(o.memMB)}<span class="membar"><i style="width:${(o.memMB / max) * 100}%"></i></span></span>
        <span class="num cpu-cell">${o.cpuPct != null ? o.cpuPct.toFixed(1) + '%' : '—'}</span>
        <span class="num">${o.procs}</span>
        <span class="origin-cell ${org ? '' : 'none'}">
          ${org
            ? `<span class="o-name">${esc(org.name)}${org.confidence === 'likely' ? ' <span class="maybe">likely</span>' : ''}</span>
               <span class="o-date">${dateLabel(org.added)} · ${ageLabel(org.added)} ago${old ? ' ⚑' : ''}</span>`
            : 'launched by hand'}
        </span>
      </div>
      ${open ? detailHtml(o, s) : ''}`;
  }).join('');

  paintSelbar();
}

/* ---------------- selection + park ---------------- */
function selectedOwners() {
  if (!state.snap) return [];
  return state.snap.owners.filter((o) => state.selected.has(o.key));
}

function paintSelbar() {
  const sel = selectedOwners();
  const bar = $('#selbar');
  bar.hidden = sel.length === 0;
  if (!sel.length) return;
  const mb = sel.reduce((a, o) => a + o.memMB, 0);
  const procs = sel.reduce((a, o) => a + o.procs, 0);
  $('#sel-summary').textContent =
    `${sel.length} owner${sel.length > 1 ? 's' : ''} · ${procs} processes · ${mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB'}`;
}

async function openParkModal() {
  const sel = selectedOwners();
  if (!sel.length) return;
  const pids = sel.flatMap((o) => o.rootPids);

  $('#modal').hidden = false;
  $('#modal-confirm').hidden = true;
  $('#modal-body').innerHTML = '<div class="empty">Planning — nothing has been killed…</div>';
  $('#confirm-input').value = '';
  $('#btn-execute').disabled = true;

  try {
    const res = await fetch('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pids, includeTree: true }),
    });
    const plan = await res.json();
    if (!res.ok) throw new Error(plan.error || `plan failed (${res.status})`);
    state.plan = plan;
    renderPlan(plan);
  } catch (e) {
    $('#modal-body').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

function renderPlan(plan) {
  const row = (v, blocked) => `<div>
    <span class="r">${v.pid}</span>
    <span>${esc(v.name)}</span>
    <span class="r">${v.memMB != null ? mb(v.memMB) : '—'}</span>
    <span class="${blocked ? 'why' : 'cmd'}" title="${esc(blocked ? v.reason : (v.cmd || ''))}">${esc(blocked ? v.reason : (v.cmd || '').slice(0, 160))}</span>
  </div>`;

  $('#modal-body').innerHTML = `
    <div class="plan-total">This will stop <b>${plan.allowed.length} processes</b> and free roughly
      <b>${mb(plan.estimateMB)}</b>. A restore manifest is written before the first kill.</div>
    <div class="plan-sec">
      <h4 class="ok">Will be parked (${plan.allowed.length})</h4>
      <div class="plan-list">${plan.allowed.map((v) => row(v, false)).join('') || '<div><span class="cmd">nothing</span></div>'}</div>
    </div>
    ${plan.blocked.length ? `<div class="plan-sec">
      <h4 class="no">Blocked by the guard (${plan.blocked.length}) — these stay running</h4>
      <div class="plan-list">${plan.blocked.map((v) => row(v, true)).join('')}</div>
    </div>` : ''}`;

  if (plan.allowed.length) {
    $('#confirm-phrase').textContent = plan.confirmPhrase;
    $('#modal-confirm').hidden = false;
  }
}

async function executePlan() {
  if (!state.plan) return;
  $('#btn-execute').disabled = true;
  $('#btn-execute').textContent = 'Parking…';
  try {
    const res = await fetch('/api/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: state.plan.planId, confirm: $('#confirm-input').value }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `execute failed (${res.status})`);
    $('#modal-confirm').hidden = true;
    $('#modal-body').innerHTML = `<div class="exec-result">
      <div class="ok">Parked ${r.killed.length} processes · freed about ${mb(r.freedEstimateMB)}</div>
      ${r.failed.length ? `<div class="bad">${r.failed.length} could not be stopped: ${r.failed.map((f) => esc(f.name + ' (' + f.error + ')')).join(', ')}</div>` : ''}
      <div>Manifest <b>${esc(r.manifestId)}</b> saved — restore it any time from the Manifests tab.</div>
    </div>`;
    state.selected.clear();
    state.plan = null;
    await loadManifests();
    poll();
  } catch (e) {
    $('#modal-body').insertAdjacentHTML('beforeend', `<div class="err">${esc(e.message)}</div>`);
    $('#btn-execute').disabled = false;
  } finally {
    $('#btn-execute').textContent = 'Execute';
  }
}

/* ---------------- graveyard ---------------- */
async function loadGraveyard(refresh = false) {
  const el = $('#graveyard');
  el.innerHTML = `<div class="empty">${refresh ? 'Re-sweeping' : 'Sweeping your user folder and agent session stores'} — this takes a few seconds…</div>`;
  try {
    const res = await fetch(`/api/graveyard${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `sweep failed (${res.status})`);
    state.graveyard = r;
    renderGraveyard();
  } catch (e) {
    el.innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

function renderGraveyard() {
  const g = state.graveyard;
  if (!g) return;
  $('#c-graveyard').textContent = g.counts.total;

  const q = state.q.graveyard.toLowerCase();
  const f = state.graveFilter;
  const list = g.projects.filter((p) => {
    if (f === 'agent-sessions' && p.kind !== 'agent-sessions') return false;
    if (f !== 'all' && f !== 'agent-sessions' && p.state !== f) return false;
    if (!q) return true;
    return `${p.name} ${p.path} ${p.stack} ${p.agent || ''} ${p.subject || ''}`.toLowerCase().includes(q);
  });

  if (!list.length) { $('#graveyard').innerHTML = '<div class="empty">Nothing matches that filter.</div>'; return; }

  $('#graveyard').innerHTML = list.map((p) => {
    const age = p.daysDormant == null ? '—'
      : p.daysDormant < 1 ? 'today'
      : p.daysDormant < 60 ? `${Math.round(p.daysDormant)}d`
      : `${Math.round(p.daysDormant / 30)}mo`;
    return `<div class="grave ${p.state === 'live-forgotten' ? 'hot' : ''}">
      <span><span class="g-state ${esc(p.state)}">${esc(p.state.replace('-', ' '))}</span></span>
      <span>
        <span class="g-name">${esc(p.name)}${p.title ? ` — ${esc(p.title)}` : ''}</span>
        <span class="g-path" title="${esc(p.path)}">${esc(p.subject || p.path)}</span>
      </span>
      <span class="g-num">${age}<small>since touched</small></span>
      <span class="g-num">${p.kind === 'agent-sessions' ? p.sessionCount : (p.fileCount ?? '—')}<small>${p.kind === 'agent-sessions' ? 'sessions' : 'files'}</small></span>
      <span class="g-meta">
        <span>${esc(p.agent || p.stack)}</span>
        ${p.running ? `<span class="chip solid">running</span>` : ''}
        ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.url)} ↗</a>` : ''}
        ${p.gitBranch ? `<span style="color:var(--fg-3)">${esc(p.gitBranch)}</span>` : ''}
      </span>
    </div>`;
  }).join('');
}

async function loadManifests() {
  try {
    const res = await fetch('/api/manifests', { cache: 'no-store' });
    const r = await res.json();
    state.manifests = r.manifests || [];
    renderManifests();
  } catch { /* manifests are non-critical */ }
}

function renderManifests() {
  $('#c-manifests').textContent = state.manifests.length;
  if (!state.manifests.length) {
    $('#manifests').innerHTML = '<div class="empty">No manifests yet. Nothing has been parked.</div>';
    return;
  }
  $('#manifests').innerHTML = state.manifests.map((m) => {
    const total = m.victims.reduce((a, v) => a + (v.memMB || 0), 0);
    const done = m.restored;
    return `<div class="tl-row">
      <span class="tl-date"><b>${new Date(m.at).toLocaleDateString()}</b><span>${new Date(m.at).toLocaleTimeString()}</span></span>
      <span class="tl-marker ${done ? '' : 'running'}"></span>
      <span>
        <span class="tl-name">${m.victims.length} process${m.victims.length > 1 ? 'es' : ''} · ${mb(total)}</span>
        <span class="tl-cmd">${esc(m.victims.map((v) => v.name).slice(0, 6).join(', '))}${m.victims.length > 6 ? '…' : ''}</span>
      </span>
      <span class="tl-age">${done ? 'restored' : 'parked'}</span>
      <span>
        <button class="m-restore" data-restore="${esc(m.id)}" ${done ? 'disabled' : ''}>
          ${done ? 'Restored' : 'Restore'}
        </button>
      </span>
    </div>`;
  }).join('');
}

function detailHtml(o, s) {
  const org = o.origin;
  const procs = s.owners.find((x) => x.key === o.key) ? o.pids : [];
  const rows = procs.map((pid) => {
    const p = (s.processes || []).find((x) => x.pid === pid);
    return p;
  }).filter(Boolean);

  let trace;
  if (org) {
    trace = `<div class="trace">
      <div><span class="k">owner</span><span class="v">${esc(o.owner)}</span></div>
      ${o.ports.length ? `<div><span class="k">serving</span><span class="v hl">${o.ports.map((p) => `http://localhost:${p}`).join('  ')}</span></div>` : ''}
      ${o.projectPath ? `<div><span class="k">project</span><span class="v">${esc(o.projectPath)}</span></div>` : ''}
      <div><span class="k">launched by</span><span class="v">${esc(org.kind)} · ${esc(org.name)}</span>
        <span class="v" style="color:${org.confidence === 'confirmed' ? 'var(--good)' : 'var(--warn)'}">
          ${org.confidence === 'confirmed' ? '✓ confirmed by path' : '~ inferred from name — verify before acting'}</span></div>
      <div><span class="k">location</span><span class="v">${esc(org.location || '—')}</span></div>
      <div><span class="k">command</span><span class="v">${esc((org.command || '').slice(0, 180))}</span></div>
      <div><span class="k">added</span><span class="v hl">${dateLabel(org.added)}</span> <span class="v" style="color:var(--fg-3)">— ${ageLabel(org.added)} ago (${esc(org.addedSource || '')})</span></div>
      ${org.lastRun ? `<div><span class="k">last run</span><span class="v">${dateLabel(org.lastRun)}</span></div>` : ''}
      ${org.nextRun ? `<div><span class="k">next run</span><span class="v">${new Date(org.nextRun).toLocaleString()}</span></div>` : ''}
      <div><span class="k">matched on</span><span class="v" style="color:var(--fg-3)">${esc((org.why || []).join(' · '))}</span></div>
    </div>`;
  } else {
    trace = `<div class="trace"><div><span class="k">launched by</span><span class="v">No persistence entry matched — this was started by hand or by another process, and will not come back after a reboot.</span></div></div>`;
  }

  return `<div class="detail">
    <h4>Origin trace</h4>
    ${trace}
    <h4>Processes (${rows.length})</h4>
    <div class="plist">
      ${rows.slice(0, 40).map((p) => `<div>
        <span class="r">${p.pid}</span>
        <span>${esc(p.name)}</span>
        <span class="r">${mb(p.memMB)}</span>
        <span class="r">${p.cpuPct != null ? p.cpuPct.toFixed(1) + '%' : '—'}</span>
        <span class="cmd" title="${esc(p.cmd || '')}">${esc((p.cmd || p.path || '').slice(0, 240))}</span>
      </div>`).join('')}
      ${rows.length > 40 ? `<div><span class="cmd" style="grid-column:1/-1">…and ${rows.length - 40} more</span></div>` : ''}
    </div>
  </div>`;
}

function renderPorts(s) {
  const q = state.q.ports.toLowerCase();
  const list = s.ports.filter((p) => {
    if (state.portFilter === 'live' && !(p.probe && p.probe.http)) return false;
    if (state.portFilter === 'app' && p.port >= 50000) return false;
    if (!q) return true;
    return `${p.port} ${p.owner} ${p.process || ''} ${(p.probe && p.probe.title) || ''}`.toLowerCase().includes(q);
  });

  if (!list.length) { $('#ports').innerHTML = '<div class="empty">No ports match that filter.</div>'; return; }

  $('#ports').innerHTML = list.map((p) => {
    const pr = p.probe || {};
    const live = !!pr.http;
    const st = live ? `<span class="st ok">${pr.status} ${esc(pr.kind || '')}</span>`
      : pr.reason === 'skipped' ? '<span class="st no">not probed</span>'
      : `<span class="st no">no http</span>`;
    return `
      <div class="card ${live ? 'live' : 'dark-port'}">
        <div class="card-hd">
          <span class="p">${p.port}</span>
          ${st}
        </div>
        <div class="card-bd">
          <span class="card-title ${pr.title ? '' : 'dim'}">${esc(pr.title || (live ? 'Untitled response' : 'Not an HTTP server'))}</span>
          <span class="card-meta">
            ${p.kind ? kindChip(p.kind) : ''}
            <span>${esc(p.owner)}</span>
          </span>
          <span class="card-meta">pid ${p.pid} · ${esc(p.process || '?')} · ${mb(p.memMB)}</span>
        </div>
        <div class="card-ft">
          ${live
            ? `<a href="${safeUrl(p.port)}" target="_blank" rel="noopener noreferrer">${safeUrl(p.port)} ↗</a>`
            : `<span style="color:var(--fg-3)">${safeUrl(p.port)}</span>`}
          ${p.reattach ? '<span class="chip solid" style="margin-left:auto">agent</span>' : ''}
        </div>
      </div>`;
  }).join('');
}

function renderOrigins(s) {
  const q = state.q.origins.toLowerCase();
  const runningOwners = new Set(s.owners.filter((o) => o.origin).map((o) => `${o.origin.kind}::${o.origin.name}`));
  const withIds = s.entriesWithId || s.entries;
  let list = withIds.filter((e) => {
    if (state.originFilter !== 'all' && e.kind !== state.originFilter) return false;
    if (!q) return true;
    return `${e.name} ${e.command} ${e.kind}`.toLowerCase().includes(q);
  });

  // Oldest first — the whole point is surfacing what you set up and forgot.
  list = list.slice().sort((a, b) => {
    if (!a.added) return 1;
    if (!b.added) return -1;
    return new Date(a.added) - new Date(b.added);
  });

  if (!list.length) { $('#origins').innerHTML = '<div class="empty">No entries match that filter.</div>'; return; }

  $('#origins').innerHTML = list.map((e) => {
    const running = runningOwners.has(`${e.kind}::${e.name}`);
    const days = ageFrom(e.added);
    const id = e.id || `${e.kind}::${e.location || ''}::${e.name}`;
    return `<div class="tl-row ${e.disabled ? 'is-off' : ''}">
      <span class="tl-date"><b>${dateLabel(e.added)}</b><span>${esc((e.addedSource || '').slice(0, 26))}</span></span>
      <span class="tl-marker ${running ? 'running' : ''}" title="${running ? 'running now' : 'not currently running'}"></span>
      <span>
        <span class="tl-name">${esc(e.display || e.name)}${e.disabled ? ' <span class="off-chip">off</span>' : ''}</span>
        <span class="tl-cmd">${esc(e.kind)}${e.location ? ' · ' + esc(String(e.location).slice(0, 60)) : ''}</span>
      </span>
      <span class="tl-age ${days > 30 ? 'old' : ''}">${ageLabel(e.added)} ago</span>
      <span class="tl-cmd" title="${esc(e.command || '')}">${esc((e.command || '').slice(0, 160))}</span>
      <span>${e.disabled
        ? `<button class="m-restore" data-persist-on="${esc(id)}">Re-enable</button>`
        : `<input type="checkbox" class="row-check" data-psel="${esc(id)}" ${state.selectedEntries.has(id) ? 'checked' : ''} aria-label="Select ${esc(e.name)} to disable">`}</span>
    </div>`;
  }).join('');

  paintPersistBar();
}

function paintPersistBar() {
  const n = state.selectedEntries.size;
  const bar = $('#persistbar');
  bar.hidden = n === 0;
  if (n) $('#persist-summary').textContent = `${n} startup entr${n > 1 ? 'ies' : 'y'} selected`;
}

/** Dry run + typed confirmation for persistence changes, reusing the modal. */
async function openPersistModal(mode, ids) {
  $('#modal').hidden = false;
  $('#modal-confirm').hidden = true;
  $('#modal-title').textContent = mode === 'disable'
    ? 'Disable startup entries — dry run'
    : 'Re-enable startup entry — dry run';
  $('#modal-body').innerHTML = '<div class="empty">Planning — nothing has been changed…</div>';
  $('#confirm-input').value = '';
  $('#btn-execute').disabled = true;
  state.plan = null;

  try {
    const res = await fetch('/api/persist/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, mode }),
    });
    const plan = await res.json();
    if (!res.ok) throw new Error(plan.error || `plan failed (${res.status})`);
    state.persistPlan = plan;

    const row = (v, blocked) => `<div>
      <span class="r">${esc(v.kind || '')}</span>
      <span>${esc(v.name)}</span>
      <span class="r">${v.action?.needsAdmin ? 'admin' : ''}</span>
      <span class="${blocked ? 'why' : 'cmd'}" title="${esc(blocked ? v.reason : (v.action?.summary || ''))}">${esc(blocked ? v.reason : (v.action?.summary || ''))}</span>
    </div>`;

    $('#modal-body').innerHTML = `
      <div class="plan-total">${plan.allowed.length} entr${plan.allowed.length === 1 ? 'y' : 'ies'} will be
        <b>${mode === 'disable' ? 'disabled' : 're-enabled'}</b>. Nothing is deleted — startup files move to
        quarantine, registry values are recorded first, tasks and services keep their definitions.</div>
      ${plan.adminNote ? `<div class="err">${esc(plan.adminNote)}</div>` : ''}
      <div class="plan-sec">
        <h4 class="ok">Will change (${plan.allowed.length})</h4>
        <div class="plan-list">${plan.allowed.map((v) => row(v, false)).join('') || '<div><span class="cmd">nothing</span></div>'}</div>
      </div>
      ${plan.blocked.length ? `<div class="plan-sec">
        <h4 class="no">Blocked (${plan.blocked.length}) — these stay enabled</h4>
        <div class="plan-list">${plan.blocked.map((v) => row(v, true)).join('')}</div>
      </div>` : ''}`;

    if (plan.allowed.length) {
      $('#confirm-phrase').textContent = plan.confirmPhrase;
      $('#modal-confirm').hidden = false;
    }
  } catch (e) {
    $('#modal-body').innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

async function executePersistPlan() {
  const plan = state.persistPlan;
  if (!plan) return;
  $('#btn-execute').disabled = true;
  $('#btn-execute').textContent = 'Applying…';
  try {
    const res = await fetch('/api/persist/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: plan.planId, confirm: $('#confirm-input').value }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `execute failed (${res.status})`);
    $('#modal-confirm').hidden = true;
    $('#modal-body').innerHTML = `<div class="exec-result">
      <div class="ok">${r.applied.length} entr${r.applied.length === 1 ? 'y' : 'ies'} ${r.mode === 'disable' ? 'disabled' : 're-enabled'} — this survives a reboot.</div>
      ${r.failed.length ? `<div class="bad">${r.failed.length} failed: ${r.failed.map((f) => esc(f.id + ' — ' + f.error)).join('; ')}</div>` : ''}
      ${r.note ? `<div class="bad">${esc(r.note)}</div>` : ''}
      <div>Agent elevated: ${r.elevated ? 'yes' : 'no'}. Manifest <b>${esc(r.manifestId)}</b> saved.</div>
    </div>`;
    state.selectedEntries.clear();
    state.persistPlan = null;
    await loadManifests();
    poll();
  } catch (e) {
    $('#modal-body').insertAdjacentHTML('beforeend', `<div class="err">${esc(e.message)}</div>`);
    $('#btn-execute').disabled = false;
  } finally {
    $('#btn-execute').textContent = 'Execute';
  }
}

function renderFanout(s) {
  if (!s.fanout.length) { $('#fanout').innerHTML = '<div class="empty">No duplicated owners. Nice.</div>'; return; }
  const total = s.fanout.reduce((a, f) => a + f.reclaimMB, 0);
  $('#fanout').innerHTML =
    `<div style="background:var(--surface-2)">
      <span class="fname">Collapsing every duplicate to one copy</span>
      <span class="fnum"></span><span class="fnum"></span>
      <span class="fnum reclaim">${mb(total)}</span>
    </div>` +
    s.fanout.map((f) => `<div>
      <span class="fname">${esc(f.owner)} ${kindChip(f.kind)} ${f.vendor ? `<span class="sub">${esc(f.vendor)}</span>` : ''}</span>
      <span class="fnum">${f.copies}× copies</span>
      <span class="fnum">${f.procs} procs</span>
      <span class="fnum reclaim">${mb(f.reclaimMB)}</span>
    </div>`).join('');
}

/* ---------------- events ---------------- */
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  state.view = t.dataset.view;
  ['owners', 'ports', 'origins', 'fanout', 'graveyard', 'manifests'].forEach((v) => { $(`#view-${v}`).hidden = v !== state.view; });
  if (state.view === 'manifests') loadManifests();
  // The sweep costs seconds, so it runs on first open rather than at startup.
  if (state.view === 'graveyard' && !state.graveyard) loadGraveyard();
}));

$('#owners').addEventListener('click', (e) => {
  // A checkbox click selects for parking; it must not also expand the row.
  const box = e.target.closest('[data-sel]');
  if (box) {
    const k = box.dataset.sel;
    box.checked ? state.selected.add(k) : state.selected.delete(k);
    paintSelbar();
    e.stopPropagation();
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  const k = row.dataset.key;
  state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
  renderOwners(state.snap);
});

$('#owners').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.row');
  if (!row || e.target.matches('[data-sel]')) return;
  e.preventDefault();
  const k = row.dataset.key;
  state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
  renderOwners(state.snap);
});

$('#btn-park').addEventListener('click', openParkModal);
$('#btn-clear').addEventListener('click', () => { state.selected.clear(); renderOwners(state.snap); });
function closeModal() {
  $('#modal').hidden = true;
  state.plan = null;
  state.persistPlan = null;
  $('#modal-title').textContent = 'Park — dry run';
}
$('#btn-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

// The execute button unlocks only on an exact phrase match — no fuzzy compare.
$('#confirm-input').addEventListener('input', (e) => {
  const active = state.persistPlan || state.plan;
  $('#btn-execute').disabled = !active || e.target.value !== active.confirmPhrase;
});
$('#btn-execute').addEventListener('click', () => {
  // Whichever plan the modal is currently showing owns the button.
  if (state.persistPlan) return executePersistPlan();
  return executePlan();
});

/* ---- Origins tab: select entries, disable them, re-enable them ---- */
$('#origins').addEventListener('click', async (e) => {
  const box = e.target.closest('[data-psel]');
  if (box) {
    const id = box.dataset.psel;
    box.checked ? state.selectedEntries.add(id) : state.selectedEntries.delete(id);
    paintPersistBar();
    return;
  }
  const on = e.target.closest('[data-persist-on]');
  if (on) { openPersistModal('enable', [on.dataset.persistOn]); }
});

$('#btn-disable').addEventListener('click', () => {
  if (state.selectedEntries.size) openPersistModal('disable', [...state.selectedEntries]);
});
$('#btn-pclear').addEventListener('click', () => {
  state.selectedEntries.clear();
  renderOrigins(state.snap);
});

$('#manifests').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-restore]');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Restoring…';
  try {
    const res = await fetch('/api/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifestId: btn.dataset.restore }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'restore failed');
    await loadManifests();
    poll();
  } catch (err) {
    btn.textContent = 'Failed';
    $('#errors').innerHTML = `<div class="err">Restore failed — ${esc(err.message)}</div>`;
  }
});

function wireSeg(selector, apply) {
  document.querySelectorAll(selector).forEach((b) => b.addEventListener('click', () => {
    b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    apply(b);
    renderAll();
  }));
}
wireSeg('[data-sort]', (b) => { state.ownerSort = b.dataset.sort; });
wireSeg('[data-kind]', (b) => { state.ownerKind = b.dataset.kind; });
wireSeg('[data-pf]', (b) => { state.portFilter = b.dataset.pf; });
wireSeg('[data-of]', (b) => { state.originFilter = b.dataset.of; });
wireSeg('[data-gf]', (b) => { state.graveFilter = b.dataset.gf; });
$('#q-graveyard').addEventListener('input', (e) => { state.q.graveyard = e.target.value; renderGraveyard(); });
$('#btn-rescan').addEventListener('click', () => loadGraveyard(true));

$('#q-owners').addEventListener('input', (e) => { state.q.owners = e.target.value; renderOwners(state.snap); });
$('#q-ports').addEventListener('input', (e) => { state.q.ports = e.target.value; renderPorts(state.snap); });
$('#q-origins').addEventListener('input', (e) => { state.q.origins = e.target.value; renderOrigins(state.snap); });

$('#refresh').addEventListener('click', poll);
$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  next ? document.documentElement.setAttribute('data-theme', next)
       : document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('hangar-theme', next); } catch {}
});

try {
  const saved = localStorage.getItem('hangar-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch {}

poll();
loadManifests();
setInterval(poll, REFRESH_MS);
