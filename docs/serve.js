#!/usr/bin/env node
'use strict';
/**
 * Static server for the docs site and the component gallery.
 *
 *   node docs/serve.js            ->  http://localhost:7500
 *   node docs/serve.js --port 80
 *
 * Zero dependencies, like the agent itself.
 *
 * On boot it copies the live app stylesheet and icon into docs/assets. The
 * gallery therefore renders against the real CSS rather than a transcription of
 * it, which is the usual way a component library drifts from the product it
 * documents. The same copy runs in the Pages workflow, so local and deployed
 * builds are byte-identical.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const REPO = path.join(ROOT, '..');
const ASSETS = path.join(ROOT, 'assets');

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || Number(process.env.PORT) || 7500;

const COPY = [
  [path.join(REPO, 'apps', 'desktop', 'src', 'style.css'), path.join(ASSETS, 'style.css')],
  [path.join(REPO, 'apps', 'desktop', 'src-tauri', 'icons', 'icon.png'), path.join(ASSETS, 'icon.png')],
];

function syncAssets() {
  fs.mkdirSync(ASSETS, { recursive: true });
  for (const [from, to] of COPY) {
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Re-copy per request so editing style.css shows up on reload.
  syncAssets();

  const url = new URL(req.url, `http://localhost:${PORT}`);
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) {
      // Directory without a trailing slash is the common case here.
      const alt = path.join(file, 'index.html');
      return fs.readFile(alt, (e2, b2) => {
        if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(b2);
      });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  syncAssets();
  process.stdout.write(`\n  Hangar docs\n  ───────────────────────────\n`);
  process.stdout.write(`  Site      http://localhost:${PORT}/\n`);
  process.stdout.write(`  Gallery   http://localhost:${PORT}/storybook/\n\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(`\n  Port ${PORT} is in use. Try: node docs/serve.js --port 7501\n\n`);
    process.exit(1);
  }
  throw e;
});
