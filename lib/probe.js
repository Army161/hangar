'use strict';
/**
 * Port prober for the Port Wall.
 *
 * Sends one gentle HTTP GET per local port to find out whether something
 * browsable is listening, and what it calls itself. Results are cached so we
 * are not hammering your own dev servers on every UI refresh.
 */

const http = require('http');

// RPC / SMB / NetBIOS and other ports where an HTTP GET is pointless or rude.
const SKIP = new Set([135, 139, 445, 5040, 7680]);

const cache = new Map(); // port -> { at, result }
const TTL_OK = 60_000;   // re-check live servers every minute
const TTL_BAD = 300_000; // things that aren't HTTP change rarely

function probeOne(port, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout, headers: { 'User-Agent': 'Hangar/0.1 (local probe)' } },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes < 65536) chunks.push(c);
          else res.destroy(); // enough to find a <title>
        });
        res.on('end', () => finish(Buffer.concat(chunks).toString('utf8'), res));
        res.on('close', () => finish(Buffer.concat(chunks).toString('utf8'), res));
      }
    );

    let done = false;
    function finish(body, res) {
      if (done) return;
      done = true;
      const ct = String(res.headers['content-type'] || '');
      const titleMatch = body.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
      const isHtml = /text\/html/i.test(ct) || /<html/i.test(body);
      resolve({
        http: true,
        status: res.statusCode,
        contentType: ct.split(';')[0] || null,
        title: titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : null,
        browsable: isHtml,
        kind: isHtml ? 'web' : /json/i.test(ct) ? 'api' : 'other',
      });
    }

    req.on('timeout', () => { req.destroy(); if (!done) { done = true; resolve({ http: false, reason: 'timeout' }); } });
    req.on('error', (e) => { if (!done) { done = true; resolve({ http: false, reason: e.code || 'error' }); } });
  });
}

async function probePorts(ports, { concurrency = 8 } = {}) {
  const now = Date.now();
  const todo = [];
  const results = new Map();

  for (const port of ports) {
    if (SKIP.has(port)) { results.set(port, { http: false, reason: 'skipped' }); continue; }
    const hit = cache.get(port);
    if (hit && now - hit.at < (hit.result.http ? TTL_OK : TTL_BAD)) { results.set(port, hit.result); continue; }
    todo.push(port);
  }

  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const port = todo[cursor++];
      const result = await probeOne(port);
      cache.set(port, { at: Date.now(), result });
      results.set(port, result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  return results;
}

module.exports = { probePorts };
