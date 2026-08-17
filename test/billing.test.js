'use strict';
/**
 * Billing tests.
 *
 * The interesting surface here is webhook verification. An unverified endpoint
 * lets anyone POST a fake checkout.session.completed and mint themselves a
 * `max` licence, so most of these are attacks rather than happy paths.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const stripe = require('../services/billing/stripe');
const licence = require('../services/billing/licence');

const SECRET = 'whsec_test_secret_value';

function sign(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

// --- webhook verification ---------------------------------------------------

test('a correctly signed webhook verifies', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const out = stripe.verifyWebhook(body, sign(body), SECRET);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.event.id, 'evt_1');
});

test('a forged signature is rejected', () => {
  const body = JSON.stringify({ id: 'evt_2', type: 'checkout.session.completed' });
  const forged = `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`;
  assert.equal(stripe.verifyWebhook(body, forged, SECRET).ok, false);
});

test('a signature made with the wrong secret is rejected', () => {
  const body = JSON.stringify({ id: 'evt_3' });
  const out = stripe.verifyWebhook(body, sign(body, { secret: 'whsec_attacker' }), SECRET);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'signature mismatch');
});

test('tampering with the body after signing is caught', () => {
  // The exact attack: sign a `plus` purchase, then edit it to `max`.
  const real = JSON.stringify({ id: 'evt_4', data: { object: { client_reference_id: 'plus' } } });
  const header = sign(real);
  const tampered = real.replace('"plus"', '"max"');
  assert.equal(stripe.verifyWebhook(tampered, header, SECRET).ok, false,
    'an edited payload must not authenticate');
});

test('a replayed old webhook is rejected', () => {
  const body = JSON.stringify({ id: 'evt_5' });
  const old = sign(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const out = stripe.verifyWebhook(body, old, SECRET);
  assert.equal(out.ok, false);
  assert.match(out.reason, /tolerance/, 'replay must be refused on age, not signature');
});

test('a future-dated timestamp is also outside tolerance', () => {
  const body = JSON.stringify({ id: 'evt_6' });
  const future = sign(body, { timestamp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(stripe.verifyWebhook(body, future, SECRET).ok, false);
});

test('all v1 signatures are tried, so secret rotation works', () => {
  const body = JSON.stringify({ id: 'evt_7' });
  const ts = Math.floor(Date.now() / 1000);
  const good = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  // Stripe sends both during rollover, old secret first.
  const header = `t=${ts},v1=${'b'.repeat(64)},v1=${good}`;
  assert.equal(stripe.verifyWebhook(body, header, SECRET).ok, true,
    'taking only the first v1 would break rotation');
});

test('malformed and missing inputs are refused with a reason', () => {
  const body = '{}';
  for (const [sig, secret] of [[null, SECRET], ['garbage', SECRET], [sign(body), null], ['t=1', SECRET]]) {
    const out = stripe.verifyWebhook(body, sig, secret);
    assert.equal(out.ok, false);
    assert.ok(out.reason && out.reason.length, 'every rejection carries a reason');
  }
});

test('a signature of the wrong length does not throw', () => {
  // timingSafeEqual throws on length mismatch — that must be handled, not
  // allowed to crash the endpoint (a crash is a denial-of-service vector).
  const body = JSON.stringify({ id: 'evt_8' });
  const short = `t=${Math.floor(Date.now() / 1000)},v1=abc`;
  assert.doesNotThrow(() => stripe.verifyWebhook(body, short, SECRET));
  assert.equal(stripe.verifyWebhook(body, short, SECRET).ok, false);
});

test('a valid signature over non-JSON is still refused', () => {
  const body = 'not json at all';
  const out = stripe.verifyWebhook(body, sign(body), SECRET);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'body is not JSON');
});

// --- licence minting --------------------------------------------------------

const KEYS = licence.generateKeypair();

test('a minted licence verifies against the client verifier', () => {
  const { token } = licence.mint({
    privateKeyPem: KEYS.privateKeyPem,
    sub: 'a@b.c', tier: 'pro',
    periodEndSec: Math.floor(Date.now() / 1000) + 2592000,
  });

  const prev = process.env.HANGAR_LICENCE_PUBKEY;
  process.env.HANGAR_LICENCE_PUBKEY = KEYS.publicKeyBase64;
  delete require.cache[require.resolve('../lib/entitlements')];
  const ent = require('../lib/entitlements');

  try {
    const res = ent.verify(token);
    assert.equal(res.ok, true, `minting and verification must agree — got ${res.reason}`);
    assert.equal(res.payload.tier, 'pro');
  } finally {
    if (prev === undefined) delete process.env.HANGAR_LICENCE_PUBKEY;
    else process.env.HANGAR_LICENCE_PUBKEY = prev;
    delete require.cache[require.resolve('../lib/entitlements')];
  }
});

test('expiry follows the billing period, not a fixed year', () => {
  const periodEnd = Math.floor(Date.now() / 1000) + 2592000; // ~30 days
  const { exp } = licence.mint({ privateKeyPem: KEYS.privateKeyPem, sub: 'a@b.c', tier: 'pro', periodEndSec: periodEnd });
  const overshootDays = (exp - periodEnd) / 86400;
  assert.ok(overshootDays > 0 && overshootDays <= 3,
    `licence should outlast the period by a small margin, got ${overshootDays} days`);
  // A year-long licence on a monthly plan would be a year of free service
  // after cancellation, because offline verification cannot revoke.
  assert.ok(exp - Math.floor(Date.now() / 1000) < 40 * 86400, 'must not mint a long licence for a short period');
});

test('minting refuses without a key or with an unknown tier', () => {
  assert.throws(() => licence.mint({ sub: 'a@b.c', tier: 'pro' }), /PRIVATE_KEY/);
  assert.throws(() => licence.mint({ privateKeyPem: KEYS.privateKeyPem, sub: 'a@b.c', tier: 'enterprise' }), /Unknown tier/);
  assert.throws(() => licence.mint({ privateKeyPem: KEYS.privateKeyPem, tier: 'pro' }), /subject/);
});

test('tier comes from configured price ids, never inferred from amount', () => {
  const map = { plus: ['price_a'], pro: ['price_b', 'price_c'], max: 'price_d' };
  assert.equal(licence.tierForPrice('price_c', map), 'pro');
  assert.equal(licence.tierForPrice('price_d', map), 'max');
  assert.equal(licence.tierForPrice('price_unknown', map), null,
    'an unrecognised price must not resolve to a tier');
});

// --- service refuses to operate unconfigured --------------------------------

test('the service reports missing configuration rather than half-working', () => {
  const { configProblems } = require('../services/billing/server');
  const missing = configProblems();
  assert.ok(Array.isArray(missing));
  // In a test environment nothing is set, so every required var should appear.
  assert.ok(missing.includes('STRIPE_SECRET_KEY'));
  assert.ok(missing.includes('HANGAR_LICENCE_PRIVATE_KEY'));
});
