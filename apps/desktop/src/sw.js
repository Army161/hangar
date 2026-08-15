/**
 * Hangar service worker — app shell only.
 *
 * SAFETY, and the reason this file is deliberately small:
 *
 * Hangar kills processes. A cached process table is not a stale UI, it is a
 * loaded gun — parking "pid 8814" against a snapshot from four hours ago targets
 * whatever recycled into that pid since. So:
 *
 *   - /api/* is NEVER cached and NEVER served from cache. Network only.
 *   - Non-GET is never intercepted at all. A replayed POST /api/execute would
 *     re-run a kill; the plan/confirm gates live on the server and cannot
 *     defend against a client that replays its own request.
 *   - Only same-origin shell assets are cached.
 *
 * The offline story is therefore honest: you get the interface and a clear
 * "agent unreachable" state, never fabricated data.
 */

const VERSION = 'hangar-v0.4.0';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/icons/icon-128.png',
  '/icons/icon-256.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll fails the whole install if any single entry 404s; ipc.js exists
      // only in the Tauri build, so entries are added individually and tolerated.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;

  // Never touch writes, and never touch anything that is not a plain GET.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live state is never cached. If the agent is down the caller sees the
  // failure, rather than a snapshot that is quietly hours old.
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Refresh in the background so the next load is current.
        e.waitUntil(
          fetch(request)
            .then((res) => {
              if (res && res.ok) return caches.open(VERSION).then((c) => c.put(request, res));
            })
            .catch(() => {})
        );
        return hit;
      }

      return fetch(request)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});

// Lets the page trigger an immediate update instead of waiting for a reload.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
