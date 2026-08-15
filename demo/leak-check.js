// Does the confirmation phrase reach the agent? Run against a live server.
const http = require('http');

const PORT = Number(process.argv[2]) || 7436;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port: PORT, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 300000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: PORT, path }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}

(async () => {
  const snap = await get('/api/snapshot');
  const owner = snap.owners.find((o) => o.kind === 'mcp' || o.kind === 'app');
  const pid = owner && owner.pids && owner.pids[0];
  if (!pid) { console.log('no candidate pid'); process.exit(1); }

  // 1. The HTTP endpoint SHOULD return the phrase — the browser needs it.
  const httpPlan = await post('/api/plan', { pids: [pid] });
  console.log('=== HTTP /api/plan (browser path) ===');
  console.log('  confirmPhrase present :', Object.prototype.hasOwnProperty.call(httpPlan, 'confirmPhrase'));
  console.log('  value                 :', JSON.stringify(httpPlan.confirmPhrase));

  // 2. The agent path must NOT.
  const chat = await post('/api/agent/chat', {
    model: { provider: 'ollama', id: 'qwen3.5:4b' },
    messages: [{ role: 'user', content: `Call plan_park for pid ${pid}. Report the result. Nothing else.` }],
  });

  const serialised = JSON.stringify(chat);
  const phraseRe = /PARK\s+\d+/;          // real \d this time
  const keyRe = /"confirmPhrase"/;

  console.log('');
  console.log('=== agent path ===');
  console.log('  plan_park ran         :', (chat.trace || []).some((t) => t.tool === 'plan_park'));
  console.log('  /PARK \\d+/ anywhere   :', phraseRe.test(serialised));
  console.log('  "confirmPhrase" key   :', keyRe.test(serialised));
  console.log('');
  console.log('  control — the regex works:', phraseRe.test('confirm: PARK 54'));
})().catch((e) => { console.error(e.message); process.exit(1); });
