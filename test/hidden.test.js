'use strict';
/**
 * Regression: `hidden` must actually hide.
 *
 * Found 2026-08-15 while scripting a walkthrough recording. Every click in the
 * app was being intercepted by <div id="modal" class="modal-wrap" hidden>.
 *
 * The UA stylesheet hides [hidden] with `display: none`, but author styles beat
 * the user-agent origin, so any class declaring its own `display` silently wins.
 * Four elements did: .selbar, .persistbar, .modal-wrap and the confirm modal.
 * The Park dry-run modal therefore painted a full-screen scrim at z-index 80
 * from first load and swallowed every click. The app looked merely "dimmed" and
 * was completely unusable — present since the initial commit.
 *
 * The bug is invisible to the API tests and to the smoke job, both of which only
 * ever see 200s. It is a pure cascade problem, so it is checked in the cascade.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'apps', 'desktop', 'src');
const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

// Strip comments so prose about `display:` cannot satisfy or trip these checks.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('stylesheet neutralises [hidden] against class-level display', () => {
  const rule = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i.test(cssCode);
  assert.ok(rule,
    'style.css must contain `[hidden] { display: none !important; }` — without '
    + '!important it loses to any class that sets its own display.');
});

test('every element marked hidden in the markup is genuinely hidden', () => {
  // Elements the app toggles via the hidden attribute.
  const hiddenEls = [...html.matchAll(/<[^>]*\bhidden\b[^>]*>/g)]
    .map((m) => m[0])
    .map((tag) => {
      const cls = /class="([^"]+)"/.exec(tag);
      const id = /id="([^"]+)"/.exec(tag);
      return { id: id ? id[1] : null, classes: cls ? cls[1].split(/\s+/) : [] };
    })
    .filter((e) => e.id || e.classes.length);

  assert.ok(hiddenEls.length > 0, 'expected some [hidden] elements in index.html');

  // Any of those whose class sets an explicit display would beat the UA rule.
  const risky = [];
  for (const el of hiddenEls) {
    for (const c of el.classes) {
      const re = new RegExp(`\\.${c.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`, 'g');
      let m;
      while ((m = re.exec(cssCode)) !== null) {
        if (/(^|;)\s*display\s*:/.test(m[1])) risky.push(`${el.id || ''}.${c}`);
      }
    }
  }

  // Their existence is fine — the [hidden] override is what makes them safe.
  // This assertion documents that the override is load-bearing, not cosmetic.
  const override = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i.test(cssCode);
  assert.ok(override,
    `these classes set their own display and would defeat [hidden] without the `
    + `override: ${[...new Set(risky)].join(', ')}`);
});

test('the modal is not rendered over the app on load', () => {
  // The modal must carry the attribute in source; app.js removes it to open.
  const modal = /<div[^>]*id="modal"[^>]*>/.exec(html);
  assert.ok(modal, 'expected a #modal element');
  assert.match(modal[0], /\bhidden\b/,
    '#modal must start hidden, or the Park dry-run scrim covers the UI at boot');
});
