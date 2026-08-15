/**
 * Hangar PWA glue — install prompt, update prompt, connection state.
 *
 * Loaded by both front ends but active in neither Tauri nor insecure contexts:
 * the desktop build already IS an installed app and has no TCP origin to cache
 * against, so registering a worker there would be noise at best.
 */
(() => {
  'use strict';

  const isTauri = typeof window.__TAURI__ !== 'undefined'
    || typeof window.__TAURI_INTERNALS__ !== 'undefined';

  // Service workers need a secure context. localhost counts; a bare LAN IP over
  // plain http does not, so a phone pointed at http://192.168.x.x gets the app
  // without offline caching. That is a browser rule, not something to work around.
  const secure = window.isSecureContext;

  if (isTauri || !('serviceWorker' in navigator) || !secure) {
    window.__hangarPWA = { supported: false, reason: isTauri ? 'tauri' : (!secure ? 'insecure-context' : 'unsupported') };
    return;
  }

  let deferredPrompt = null;

  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // An existing controller means this is an update, not a first install.
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showBanner('A new version of Hangar is ready.', 'Reload', () => {
              sw.postMessage('skip-waiting');
            });
          }
        });
      });
    })
    .catch((err) => console.warn('[hangar] service worker registration failed:', err));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showBanner('Install Hangar for quick access.', 'Install', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    });
  });

  window.addEventListener('appinstalled', () => { deferredPrompt = null; });

  // --- minimal banner, styled from the existing token set -------------------
  function showBanner(text, actionLabel, onAction) {
    if (document.getElementById('pwa-banner')) return;

    const bar = document.createElement('div');
    bar.id = 'pwa-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:18px',
      'z-index:9999', 'display:flex', 'align-items:center', 'gap:14px',
      'padding:11px 16px', 'border-radius:10px',
      'background:var(--surface,#12363D)', 'color:var(--fg,#E8EDEC)',
      'border:1px solid var(--line,rgba(232,237,236,.16))',
      'box-shadow:0 8px 28px rgba(0,0,0,.28)',
      'font:14px var(--body,system-ui)', 'max-width:min(92vw,460px)',
    ].join(';');

    const span = document.createElement('span');
    span.textContent = text;
    span.style.flex = '1';

    const act = document.createElement('button');
    act.textContent = actionLabel;
    act.style.cssText = 'background:var(--signal,#E5A50A);color:#231802;border:0;'
      + 'border-radius:6px;padding:7px 14px;font:inherit;font-weight:600;cursor:pointer';
    act.onclick = () => { bar.remove(); onAction(); };

    const dismiss = document.createElement('button');
    dismiss.textContent = '✕';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.style.cssText = 'background:transparent;border:0;color:var(--fg-2,#8CA3A6);'
      + 'font:inherit;cursor:pointer;padding:4px';
    dismiss.onclick = () => bar.remove();

    bar.append(span, act, dismiss);
    document.body.appendChild(bar);
  }

  window.__hangarPWA = { supported: true, showBanner };
})();
