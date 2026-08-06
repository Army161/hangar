'use strict';
/**
 * Transport shim.
 *
 * The dashboard was written against `fetch('/api/...')` on the Node build.
 * Rather than rewrite every call site — and risk touching the UI that
 * docs/PLAN.md §8 locks — this intercepts those requests and routes them over
 * Tauri IPC when running inside the desktop shell.
 *
 * In a browser it does nothing at all, so `node server.js` keeps working
 * unchanged for development.
 *
 * There is deliberately NO TCP listener in the desktop build. A tool that
 * reads your process table should not be reachable over a socket, even a
 * loopback one.
 */
(function () {
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
    return; // browser build — leave fetch alone
  }
  const invoke = tauri.core.invoke;

  /** Endpoints the Rust core implements today. */
  const ROUTES = {
    'GET /api/snapshot':        () => invoke('snapshot'),
    'GET /api/manifests':       () => invoke('manifests'),
    'GET /api/health':          () => invoke('health'),
    'POST /api/plan':           (b) => invoke('plan', { pids: b.pids, includeTree: b.includeTree !== false }),
    'POST /api/execute':        (b) => invoke('execute', { planId: b.planId, confirm: b.confirm }),
    'POST /api/persist/plan':   (b) => invoke('persistPlan', { ids: b.ids, mode: b.mode || 'disable' }),
    'POST /api/persist/execute':(b) => invoke('persistExecute', { planId: b.planId, confirm: b.confirm }),
    'POST /api/restore':        (b) => invoke('restore', { manifestId: b.manifestId }),
  };

  /**
   * Endpoints whose collectors have not been ported to Rust yet. Returning an
   * explicit, readable error beats a broken tab: the UI already renders
   * `{error}` from a non-OK response.
   */
  const NOT_YET = {
    'GET /api/graveyard':
      'The Graveyard sweep still runs on the Node collector and is not in the desktop build yet. '
      + 'Run `node server.js` and open http://localhost:7420 to use it.',
  };

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();

    // Anything that is not one of our API calls goes to the real fetch.
    if (!url || !url.includes('/api/')) return nativeFetch(input, init);

    const pathname = url.startsWith('http')
      ? new URL(url).pathname
      : url.split('?')[0];
    const key = `${method} ${pathname}`;

    if (NOT_YET[key]) return json({ error: NOT_YET[key] }, 501);

    const route = ROUTES[key];
    if (!route) return json({ error: `No IPC route for ${key}` }, 404);

    let body = {};
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { body = {}; }
    }

    try {
      return json(await route(body));
    } catch (e) {
      // Tauri rejects with the Err(String) the command returned. Surfacing it
      // verbatim keeps guard reasons and confirmation mismatches readable.
      return json({ error: typeof e === 'string' ? e : (e?.message || String(e)) }, 400);
    }
  };
})();
