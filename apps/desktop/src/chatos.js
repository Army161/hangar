/**
 * ChatOS — the agent panel.
 *
 * Two rules shape the rendering, and both come from what the agent is allowed
 * to do rather than from taste:
 *
 *  - Tool calls render as manifest rows, never raw JSON. The user should be
 *    able to see what the agent looked at without reading a transcript.
 *  - Agent output is escaped and rendered through a deliberately tiny markdown
 *    subset. The agent relays text from command lines it was told to treat as
 *    data; if that text could inject markup here, the fencing upstream would
 *    have been for nothing.
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const LS_MODEL = 'hangar-agent-model';
  const LS_WIDTH = 'hangar-agent-width';

  let history = [];
  let busy = false;
  let loaded = false;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // --- open / close / resize -------------------------------------------------

  function open() {
    $('#chatos').hidden = false;
    document.body.classList.add('chatos-open');
    $('#chatos-open').setAttribute('aria-expanded', 'true');
    $('#chatos-text').focus();
    if (!loaded) { loaded = true; loadModels().catch(showLoadError); }
  }

  function close() {
    $('#chatos').hidden = true;
    document.body.classList.remove('chatos-open');
    $('#chatos-open').setAttribute('aria-expanded', 'false');
  }

  function initResize() {
    const handle = $('#chatos-resize');
    const apply = (px) => {
      const w = Math.max(320, Math.min(px, Math.round(window.innerWidth * 0.7)));
      document.documentElement.style.setProperty('--chatos-w', `${w}px`);
      try { localStorage.setItem(LS_WIDTH, String(w)); } catch {}
    };
    const saved = Number(localStorage.getItem(LS_WIDTH));
    if (saved) apply(saved);

    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true; handle.setPointerCapture(e.pointerId);
      // Suppress selection while dragging, or the table text highlights.
      document.body.style.userSelect = 'none';
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragging) apply(window.innerWidth - e.clientX);
    });
    handle.addEventListener('pointerup', (e) => {
      dragging = false; handle.releasePointerCapture(e.pointerId);
      document.body.style.userSelect = '';
    });
    // Keyboard-resizable: a pointer-only handle is unusable without a mouse.
    handle.addEventListener('keydown', (e) => {
      const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chatos-w'), 10) || 420;
      if (e.key === 'ArrowLeft') { apply(cur + 24); e.preventDefault(); }
      if (e.key === 'ArrowRight') { apply(cur - 24); e.preventDefault(); }
    });
  }

  // --- models ----------------------------------------------------------------

  async function loadModels() {
    const res = await fetch('/api/agent/models', { cache: 'no-store' });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const data = await res.json();

    const sel = $('#chatos-model');
    const groups = new Map();
    const add = (m) => {
      const p = data.providers[m.provider] || { label: m.provider };
      if (!groups.has(m.provider)) groups.set(m.provider, { label: p.label, free: p.free, items: [] });
      groups.get(m.provider).items.push(m);
    };
    // Discovered first — those are the models actually runnable right now.
    data.discovered.forEach(add);
    data.curated.filter((c) => !data.discovered.some((d) => d.id === c.id)).forEach(add);

    sel.innerHTML = [...groups.entries()].map(([id, g]) => {
      const tag = g.free === true ? ' · free' : g.free === 'tier' ? ' · free tier' : '';
      const opts = g.items.map((m) => {
        const needsKey = data.providers[m.provider]?.needsKey && !data.configured.includes(m.provider);
        const size = m.sizeGb ? ` (${m.sizeGb} GB)` : '';
        return `<option value="${esc(m.provider)}|${esc(m.id)}"${needsKey ? ' disabled' : ''}>`
             + `${esc(m.label || m.id)}${size}${needsKey ? ' — needs API key' : ''}</option>`;
      }).join('');
      return `<optgroup label="${esc(g.label)}${tag}">${opts}</optgroup>`;
    }).join('');

    const saved = localStorage.getItem(LS_MODEL);
    if (saved && [...sel.options].some((o) => o.value === saved && !o.disabled)) sel.value = saved;
    sel.onchange = () => { try { localStorage.setItem(LS_MODEL, sel.value); } catch {} };

    // Say the VRAM constraint before a model is picked, not after it OOMs.
    if (data.vram && data.vram.tier !== 'unknown' && data.vram.tier !== 'large') {
      const v = $('#chatos-vram');
      v.textContent = data.vram.advice;
      v.hidden = false;
    }
  }

  function showLoadError(e) {
    $('#chatos-model').innerHTML = '<option disabled selected>could not load models</option>';
    render({ kind: 'err', text: `Model discovery failed: ${e.message}` });
  }

  // --- rendering -------------------------------------------------------------

  /**
   * A deliberately small markdown subset: fenced code, inline code, bold,
   * and pipe tables. Everything is escaped first, so nothing the agent relays
   * from a command line can become markup.
   */
  function mini(md) {
    let s = esc(md);
    s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code.trim()}</pre>`);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

    const lines = s.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        const rows = [];
        const head = lines[i];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        i--;
        const cells = (r, tag) => '<tr>' + r.trim().replace(/^\||\|$/g, '').split('|')
          .map((c) => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
        out.push(`<table>${cells(head, 'th')}${rows.map((r) => cells(r, 'td')).join('')}</table>`);
      } else out.push(lines[i]);
    }
    return out.join('\n').replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
  }

  function render(item) {
    const log = $('#chatos-log');
    const empty = log.querySelector('.chatos-empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    if (item.kind === 'you') {
      el.className = 'msg msg-you';
      el.innerHTML = `<b>You</b>${esc(item.text)}`;
    } else if (item.kind === 'agent') {
      el.className = 'msg msg-agent';
      el.innerHTML = mini(item.text);
    } else if (item.kind === 'tool') {
      el.className = `msg-tool${item.state === 'err' ? ' err' : ''}`;
      el.innerHTML = `<i class="t-dot"></i><span>${esc(item.name)}</span>`
        + (item.flagged ? `<span class="t-flag">${item.flagged} injection attempt${item.flagged === 1 ? '' : 's'} in output</span>` : '');
    } else if (item.kind === 'gate') {
      el.className = 'msg-gate';
      el.innerHTML = `<b>Waiting for you</b>The agent prepared plan <code>${esc(item.planId)}</code>. `
        + 'It cannot execute — open the plan and type the confirmation phrase to proceed.';
    } else {
      el.className = 'msg-err';
      el.textContent = item.text;
    }
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  // --- send ------------------------------------------------------------------

  async function send(text) {
    if (busy || !text.trim()) return;
    const sel = $('#chatos-model');
    if (!sel.value) return render({ kind: 'err', text: 'Pick a model first.' });
    const [provider, id] = sel.value.split('|');

    busy = true;
    $('#chatos-send').disabled = true;
    render({ kind: 'you', text });
    history.push({ role: 'user', content: text });

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: { provider, id }, messages: history }),
      });
      const out = await res.json();

      // Show what it looked at, in order, before the answer.
      for (const e of out.events || []) {
        if (e.type === 'tool-start') render({ kind: 'tool', name: e.name });
        if (e.type === 'tool-error') render({ kind: 'tool', name: e.name, state: 'err' });
        if (e.type === 'injection-flagged') {
          render({ kind: 'tool', name: `${e.name} — output`, flagged: e.fields.length });
        }
      }

      if (!out.ok) { render({ kind: 'err', text: out.error || 'The agent failed.' }); return; }
      if (out.awaitingConfirmation) render({ kind: 'gate', planId: out.planId });
      if (out.text) { render({ kind: 'agent', text: out.text }); history.push({ role: 'assistant', content: out.text }); }
      if (out.hitStepLimit) render({ kind: 'err', text: 'Stopped at the step limit. Ask a narrower question.' });
    } catch (e) {
      render({ kind: 'err', text: e.message });
    } finally {
      busy = false;
      $('#chatos-send').disabled = false;
      $('#chatos-text').focus();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#chatos-open').onclick = () => (document.body.classList.contains('chatos-open') ? close() : open());
    $('#chatos-close').onclick = close;
    initResize();

    $('#chatos-form').onsubmit = (e) => {
      e.preventDefault();
      const t = $('#chatos-text');
      const text = t.value;
      t.value = '';
      send(text);
    };
    // Enter sends, Shift+Enter newlines — the convention for this control.
    $('#chatos-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatos-form').requestSubmit(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('chatos-open')) close();
    });
  });

  window.__hangarChatOS = { open, close, send };
})();
