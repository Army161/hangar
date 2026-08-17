/**
 * End-to-end proof of the purchase chain, without a real Stripe account.
 *
 * Stripe's side of a completed purchase is a signed webhook. That is
 * reproducible locally with just the webhook secret, so everything after the
 * card form can be exercised for real:
 *
 *   signed webhook -> billing service -> minted licence -> Hangar activation
 *
 * What this does NOT cover: the Stripe-hosted card page and the API calls that
 * create a Checkout Session. Those need live credentials.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');

const { generateKeypair } = require('../services/billing/licence');

const BILLING_PORT = 8799;
const WEBHOOK_SECRET = 'whsec_local_e2e_secret';
const keys = generateKeypair();

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      method: 'POST', hostname: '127.0.0.1', port, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('1. keypair generated');
  console.log(`   public key: ${keys.publicKeyBase64.slice(0, 32)}…`);

  const svc = spawn(process.execPath, ['services/billing/server.js'], {
    env: {
      ...process.env,
      PORT: String(BILLING_PORT),
      STRIPE_SECRET_KEY: 'sk_test_fake_for_local_e2e',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      HANGAR_LICENCE_PRIVATE_KEY: keys.privateKeyPem,
      HANGAR_PRICE_PRO_MONTHLY: 'price_fake_pro_monthly',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  svc.stdout.on('data', (c) => { out += c; });
  svc.stderr.on('data', (c) => { out += c; });
  await wait(1200);
  console.log('2. billing service up');

  // Stripe's completed-purchase event, signed exactly as Stripe signs it.
  const event = JSON.stringify({
    id: `evt_${crypto.randomBytes(6).toString('hex')}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        client_reference_id: 'pro',
        customer_email: 'buyer@example.com',
        customer_details: { email: 'buyer@example.com' },
        subscription: null,
      },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${event}`).digest('hex');

  const ok = await post(BILLING_PORT, '/webhook', event, { 'stripe-signature': `t=${ts},v1=${sig}` });
  console.log(`3. signed webhook  -> ${ok.status} ${ok.raw}`);

  // An attacker POSTing the same event without a valid signature.
  const forged = await post(BILLING_PORT, '/webhook', event.replace('"pro"', '"max"'),
    { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` });
  console.log(`4. forged webhook  -> ${forged.status} ${forged.raw}`);

  // Replay of the genuine one.
  const replay = await post(BILLING_PORT, '/webhook', event, { 'stripe-signature': `t=${ts},v1=${sig}` });
  console.log(`5. replayed        -> ${replay.status} ${replay.raw}`);

  await wait(400);
  svc.kill();

  const token = (out.match(/\[licence\] ([\w-]+\.[\w-]+\.[\w-]+)/) || [])[1];
  if (!token) { console.error('\nNo licence minted.\n' + out); process.exit(1); }
  console.log(`6. licence minted  -> ${token.slice(0, 40)}…`);

  // The client verifier, using the public half.
  process.env.HANGAR_LICENCE_PUBKEY = keys.publicKeyBase64;
  delete require.cache[require.resolve('../lib/entitlements')];
  const ent = require('../lib/entitlements');
  const v = ent.verify(token);
  console.log(`7. Hangar verifies -> ok=${v.ok} tier=${v.ok ? v.payload.tier : v.reason}`);

  const g = ent.gate('sync', { tier: ent.TIERS[v.payload.tier], valid: true });
  console.log(`8. Pro unlocks sync-> allowed=${g.allowed}`);
  const f = ent.gate('fleet', { tier: ent.TIERS[v.payload.tier], valid: true });
  console.log(`   Pro !== Max     -> fleet allowed=${f.allowed} (requires ${f.requires})`);
})().catch((e) => { console.error(e); process.exit(1); });
