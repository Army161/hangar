/**
 * Hangar settings view.
 *
 * Loads on first visit to the tab rather than at boot — settings are not needed
 * to render the process table, and the agent is busy enough at startup.
 *
 * The API key field is write-only from this page's point of view: the server
 * sends a mask (••••last4), and the save path ignores any value that still
 * looks like one. So opening Settings and pressing Save cannot silently replace
 * a real key with dots.
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const MASK = '••••';

  let loaded = false;
  let current = null;
  let endpoints = [];

  function stat(el, msg, kind) {
    const n = $(el);
    if (!n) return;
    n.textContent = msg;
    n.className = `set-stat${kind ? ` ${kind}` : ''}`;
    if (msg) setTimeout(() => { if (n.textContent === msg) n.textContent = ''; }, 6000);
  }

  async function load() {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    if (!res.ok) throw new Error(`settings ${res.status}`);
    const data = await res.json();
    current = data.settings;
    endpoints = (current.integrations.agents.endpoints || []).slice();

    $('#s-theme').value = current.appearance.theme;
    $('#s-density').value = current.appearance.density;
    $('#s-fast').value = current.collection.fastTtlMs;
    $('#s-slow').value = current.collection.slowTtlMs;
    $('#s-probe').checked = current.collection.probePorts;

    $('#s-amp-on').checked = current.integrations.amplitude.enabled;
    $('#s-amp-zone').value = current.integrations.amplitude.serverZone;
    $('#s-amp-key').value = current.integrations.amplitude.apiKey || '';
    $('#s-amp-key').placeholder = current.integrations.amplitude.configured
      ? 'key stored — type to replace' : 'paste key';

    $('#s-agents-on').checked = current.integrations.agents.enabled;
    renderEndpoints();

    $('#s-names').value = (data.protected.names || []).join('\n');
    $('#s-projects').value = (data.protected.projects || []).join('\n');

    const r = data.runtime;
    $('#s-runtime').innerHTML = [
      ['Version', r.version],
      ['Mode', r.readOnly ? 'read-only' : 'guarded writes'],
      ['Binding', `${r.host}:${r.port}`],
      ['Remote', r.remote ? 'on — token required' : 'off — loopback only'],
    ].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');

    // Read-only means read-only, preferences included. Say so rather than
    // letting a save fail with a 403 after the user has typed.
    if (r.readOnly) {
      document.querySelectorAll('#view-settings button, #view-settings input, #view-settings select, #view-settings textarea')
        .forEach((el) => { el.disabled = true; });
      stat('#s-stat', 'Read-only mode (HANGAR_READONLY=1) — settings cannot be changed.', 'bad');
    }

    loaded = true;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderEndpoints() {
    const host = $('#s-agents-list');
    if (!endpoints.length) {
      host.innerHTML = '<div class="empty" style="padding:8px 0;font-size:12.5px">No connectors yet.</div>';
      return;
    }
    host.innerHTML = endpoints.map((e, i) => `
      <div class="ep">
        <b>${esc(e.label)}</b>
        <code>${esc(e.url)}</code>
        <button data-i="${i}" aria-label="Remove ${esc(e.label)}">Remove</button>
      </div>`).join('');
    host.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { endpoints.splice(Number(b.dataset.i), 1); renderEndpoints(); };
    });
  }

  function isLocalHttp(u) {
    try {
      const p = new URL(u);
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
      return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(p.hostname);
    } catch { return false; }
  }

  async function save() {
    const key = $('#s-amp-key').value;
    const patch = {
      appearance: { theme: $('#s-theme').value, density: $('#s-density').value },
      collection: {
        fastTtlMs: Number($('#s-fast').value),
        slowTtlMs: Number($('#s-slow').value),
        probePorts: $('#s-probe').checked,
      },
      integrations: {
        amplitude: {
          enabled: $('#s-amp-on').checked,
          serverZone: $('#s-amp-zone').value,
        },
        agents: { enabled: $('#s-agents-on').checked, endpoints },
      },
    };
    // Only send the key when it is genuinely new.
    if (key && !key.startsWith(MASK)) patch.integrations.amplitude.apiKey = key;

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const out = await res.json();
    if (!res.ok) { stat('#s-stat', out.error || `save failed (${res.status})`, 'bad'); return; }

    // The server reports what it refused; surfacing it beats a silent no-op.
    if (out.rejected && out.rejected.length) {
      stat('#s-stat', `Saved, but refused: ${out.rejected.join(', ')}`, 'bad');
    } else {
      stat('#s-stat', `Saved ${out.applied.length} setting${out.applied.length === 1 ? '' : 's'}.`, 'ok');
    }

    applyAppearance(patch.appearance);
    await load();
  }

  function applyAppearance(a) {
    const root = document.documentElement;
    if (a.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', a.theme);
    try { localStorage.setItem('hangar-theme', a.theme); } catch {}
    root.classList.toggle('compact', a.density === 'compact');
  }

  async function saveProtected() {
    const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
    const res = await fetch('/api/protected', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: lines('#s-names'), projects: lines('#s-projects') }),
    });
    const out = await res.json();
    if (!res.ok) { stat('#s-protected-stat', out.error || 'save failed', 'bad'); return; }
    const n = out.protected.names.length + out.protected.projects.length;
    stat('#s-protected-stat', `Saved — ${n} entries protected.`, 'ok');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#s-save').onclick = () => save().catch((e) => stat('#s-stat', e.message, 'bad'));
    $('#s-save-protected').onclick = () => saveProtected().catch((e) => stat('#s-protected-stat', e.message, 'bad'));

    $('#s-agent-add').onclick = () => {
      const label = $('#s-agent-label').value.trim();
      const url = $('#s-agent-url').value.trim();
      if (!label || !url) return stat('#s-stat', 'Connector needs a label and a URL.', 'bad');
      if (!isLocalHttp(url)) {
        return stat('#s-stat', 'Connector URLs must be loopback (localhost or 127.0.0.1).', 'bad');
      }
      if (endpoints.length >= 20) return stat('#s-stat', 'Maximum 20 connectors.', 'bad');
      endpoints.push({ id: `ep${Date.now()}`, label, url, transport: 'http' });
      $('#s-agent-label').value = '';
      $('#s-agent-url').value = '';
      renderEndpoints();
      stat('#s-stat', 'Added — press Save settings to persist.', 'ok');
    };

    // Lazy-load when the tab is first opened.
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        if (t.dataset.view === 'settings' && !loaded) {
          load().catch((e) => stat('#s-stat', e.message, 'bad'));
        }
      });
    });
  });

  window.__hangarSettings = { load, applyAppearance };
})();
