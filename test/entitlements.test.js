'use strict';
/**
 * Entitlement tests.
 *
 * The interesting ones here are not "does Pro include sync". They are the two
 * properties that protect the product from its own pricing:
 *
 *   - a safety boundary cannot become a paid feature
 *   - a broken licence cannot break the app
 *
 * Both are the kind of thing that survives review and dies quietly in a refactor
 * eighteen months later, so they are asserted rather than documented.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ent = require('../lib/entitlements');

// --- the safety boundary is not for sale ------------------------------------

test('agent.execute can never be gated by tier', () => {
  assert.ok(ent.UNGATEABLE.includes('agent.execute'),
    'PLAN §4: the typed confirmation has no exceptions. Selling permission '
    + 'creates pressure to loosen it.');

  for (const id of ent.ORDER) {
    const g = ent.gate('agent.execute', { tier: ent.TIERS[id], valid: true });
    assert.equal(g.allowed, true, `agent.execute must be allowed on ${id}`);
    assert.equal(g.ungateable, true);
  }
});

test('every ungateable capability is allowed on the free tier', () => {
  const free = { tier: ent.TIERS.free, valid: false };
  for (const cap of ent.UNGATEABLE) {
    assert.equal(ent.gate(cap, free).allowed, true, `${cap} must be free`);
  }
});

test('the wedge and BYOK are ungateable', () => {
  // The local map is why anyone installs this. BYOK is given away by Zed and
  // Cursor, so charging for it would be charging for a competitor's freebie.
  for (const cap of ['map', 'ports', 'origins', 'park', 'persistence', 'byok', 'localModels']) {
    assert.ok(ent.UNGATEABLE.includes(cap), `${cap} must be in UNGATEABLE`);
  }
});

test('no tier lists an ungateable capability as a paid feature', () => {
  // A capability appearing in both places is a contradiction: it would read as
  // sellable in the pricing table while gate() ignores the tier.
  for (const id of ent.ORDER) {
    for (const f of ent.TIERS[id].features) {
      assert.ok(!ent.UNGATEABLE.includes(f),
        `${id} lists "${f}" as a paid feature, but it is ungateable`);
    }
  }
});

// --- a broken licence must never break the app ------------------------------

test('every malformed licence falls back to free, never to blocked', () => {
  const junk = [null, undefined, '', 'not-a-token', 'a.b', 'a.b.c.d',
    '....', '{}', 'eyJhbGciOiJub25lIn0..', Buffer.from('x').toString('base64')];

  for (const t of junk) {
    const res = ent.verify(t);
    assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(t)}`);
    assert.ok(typeof res.reason === 'string' && res.reason.length,
      'a rejection must carry a reason the UI can explain');
  }
});

test('an unsigned "alg: none" token is rejected', () => {
  // The classic JWT hole: a token that declares no algorithm and carries no
  // signature. Ed25519 verification cannot be skipped by anything in the token.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ tier: 'max', exp: 4102444800 })}.`;
  assert.equal(ent.verify(forged).ok, false, 'alg:none must not authenticate');
});

test('a forged max-tier payload without a valid signature is rejected', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forged = `${b64({ alg: 'EdDSA' })}.${b64({ tier: 'max', seats: 999, exp: 4102444800 })}.${Buffer.from('nope').toString('base64url')}`;
  const res = ent.verify(forged);
  assert.equal(res.ok, false);
  assert.ok(['bad-signature', 'no-public-key'].includes(res.reason), `got ${res.reason}`);
});

test('current() always returns a usable entitlement', () => {
  const e = ent.current();
  assert.ok(e.tier, 'there is always a tier');
  assert.ok(ent.ORDER.includes(e.tier.id));
  // With no licence and no public key configured, that tier is free — and the
  // app is fully functional on it.
  assert.equal(ent.gate('map', e).allowed, true);
  assert.equal(ent.gate('agent.execute', e).allowed, true);
});

// --- the ladder itself ------------------------------------------------------

test('features accumulate monotonically up the ladder', () => {
  for (let i = 1; i < ent.ORDER.length; i++) {
    const lower = ent.TIERS[ent.ORDER[i - 1]];
    const higher = ent.TIERS[ent.ORDER[i]];
    for (const f of lower.features) {
      assert.ok(higher.features.includes(f),
        `${higher.id} must include everything ${lower.id} has, missing "${f}"`);
    }
    assert.ok(higher.machines >= lower.machines, `${higher.id} machines must not decrease`);
    assert.ok(higher.priceMonthly > lower.priceMonthly, `${higher.id} must cost more`);
  }
});

test('annual is cheaper than twelve months of monthly', () => {
  for (const id of ent.ORDER) {
    const t = ent.TIERS[id];
    if (!t.priceMonthly) continue;
    assert.ok(t.priceAnnual < t.priceMonthly * 12,
      `${id}: annual ${t.priceAnnual} must beat monthly x12 ${t.priceMonthly * 12}`);
  }
});

test('gate() names the cheapest tier that unlocks a feature', () => {
  const free = { tier: ent.TIERS.free, valid: false };
  assert.equal(ent.gate('graveyard', free).requires, 'plus');
  assert.equal(ent.gate('sync', free).requires, 'pro');
  assert.equal(ent.gate('fleet', free).requires, 'max');
});

test('describe() leaks no licence token', () => {
  const d = JSON.stringify(ent.describe());
  assert.ok(!d.includes('token'), 'describe() must not carry the raw licence');
  assert.ok(Array.isArray(d && ent.describe().catalogue));
  assert.equal(ent.describe().catalogue.length, 4);
});

// --- expiry -----------------------------------------------------------------

test('grace window is a fortnight and is bounded', () => {
  assert.equal(ent.OFFLINE_GRACE_DAYS, 14);
  // A licence expired beyond grace must not be honoured indefinitely.
  const res = ent.verify('x.y.z', Date.now() + 10 * 365 * 86400000);
  assert.equal(res.ok, false);
});

// --- the happy path, against a real keypair ---------------------------------
//
// Everything above proves the verifier says no. These prove it says yes to the
// right thing, and only to the right thing — a verifier that rejects everything
// would pass every test before this point.

const crypto = require('node:crypto');

function withKeypair(fn) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  const prev = process.env.HANGAR_LICENCE_PUBKEY;
  process.env.HANGAR_LICENCE_PUBKEY = pub;
  delete require.cache[require.resolve('../lib/entitlements')];
  const mod = require('../lib/entitlements');

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload) => {
    const h = b64({ alg: 'EdDSA', typ: 'JWT' });
    const p = b64(payload);
    const s = crypto.sign(null, Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    return { token: `${h}.${p}.${s}`, header: h, payload: p, sig: s };
  };

  try { fn(mod, sign, b64); }
  finally {
    if (prev === undefined) delete process.env.HANGAR_LICENCE_PUBKEY;
    else process.env.HANGAR_LICENCE_PUBKEY = prev;
    delete require.cache[require.resolve('../lib/entitlements')];
  }
}

const YEAR = () => Math.floor(Date.now() / 1000) + 31536000;

test('a correctly signed licence verifies and grants its tier', () => {
  withKeypair((mod, sign) => {
    const { token } = sign({ sub: 'a@b.c', tier: 'pro', seats: 1, exp: YEAR() });
    const res = mod.verify(token);
    assert.equal(res.ok, true, `expected valid, got ${res.reason}`);
    assert.equal(res.payload.tier, 'pro');
    assert.equal(res.grace, false);
  });
});

test('editing the payload to a higher tier invalidates the signature', () => {
  withKeypair((mod, sign, b64) => {
    const { header, sig } = sign({ sub: 'a@b.c', tier: 'plus', exp: YEAR() });
    const forged = `${header}.${b64({ sub: 'a@b.c', tier: 'max', seats: 999, exp: YEAR() })}.${sig}`;
    const res = mod.verify(forged);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad-signature',
      'a self-upgraded payload must not authenticate');
  });
});

test('a licence expired within the grace window still works, and says so', () => {
  withKeypair((mod, sign) => {
    const { token } = sign({ sub: 'a@b.c', tier: 'pro', exp: Math.floor(Date.now() / 1000) - 3 * 86400 });
    const res = mod.verify(token);
    assert.equal(res.ok, true, 'three days past expiry is inside the fortnight');
    assert.equal(res.grace, true, 'the UI must be able to warn');
  });
});

test('a licence expired beyond the grace window stops working', () => {
  withKeypair((mod, sign) => {
    const { token } = sign({ sub: 'a@b.c', tier: 'pro', exp: Math.floor(Date.now() / 1000) - 20 * 86400 });
    const res = mod.verify(token);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
  });
});

test('a signature from a different keypair is rejected', () => {
  withKeypair((mod, sign, b64) => {
    const other = crypto.generateKeyPairSync('ed25519');
    const h = b64({ alg: 'EdDSA', typ: 'JWT' });
    const p = b64({ sub: 'a@b.c', tier: 'max', exp: YEAR() });
    const s = crypto.sign(null, Buffer.from(`${h}.${p}`), other.privateKey).toString('base64url');
    assert.equal(mod.verify(`${h}.${p}.${s}`).ok, false,
      'only the issuing key may mint licences');
  });
});

test('even a valid max licence cannot gate a safety capability', () => {
  withKeypair((mod, sign) => {
    const { token } = sign({ sub: 'a@b.c', tier: 'max', exp: YEAR() });
    const res = mod.verify(token);
    const e = { tier: mod.TIERS[res.payload.tier], valid: true };
    // Not that max grants it — that the concept does not apply.
    assert.equal(mod.gate('agent.execute', e).ungateable, true);
  });
});
