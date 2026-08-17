'use strict';
/**
 * Hangar entitlements — tiers, feature gating, licence verification.
 *
 * Two rules are enforced structurally here rather than by convention, because
 * both are the kind of thing that erodes under commercial pressure:
 *
 *   1. UNGATEABLE (below) can never be sold. gate() refuses to gate anything in
 *      it, and a test asserts the set is non-empty and contains the safety
 *      boundary. PLAN §4: the typed execute confirmation has "no exceptions, no
 *      setting to disable it" — so it must not be possible to ship a tier that
 *      relaxes it, even by mistake.
 *
 *   2. Verification FAILS TO FREE, never to blocked. A corrupt licence, an
 *      expired one, a missing file, a clock skew, a bad signature — every path
 *      lands on the free tier with the app fully working. PLAN §5: "A licensing
 *      server that can brick the free tier is a non-starter."
 *
 * There is no phone-home. A licence is a signed token the user pastes in; it is
 * verified locally against an embedded public key and cached. The network is
 * never required to start, run, or keep running.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const LICENCE_FILE = path.join(CONFIG_DIR, 'licence.json');

/**
 * Capabilities that are free forever, on every tier, offline.
 *
 * Two distinct reasons live in this list and both matter:
 *
 *   - The wedge. The local map is why anyone installs Hangar. Gating it would
 *     trade the entire acquisition engine for a rounding error in revenue.
 *   - BYOK. Zed and Cursor both give unlimited bring-your-own-key away on their
 *     free tiers (verified 2026-08-15). Charging for it would be charging for
 *     something two better-funded competitors hand out.
 *   - Safety. agent.execute is gated by a typed human confirmation, not by
 *     money. Selling permission creates pressure to loosen the gate.
 */
const UNGATEABLE = Object.freeze([
  'map',            // owners, attribution, fan-out
  'ports',          // port wall
  'origins',        // origin traces
  'park',           // park + restore
  'persistence',    // reversible startup control
  'manifests',      // undo history for parks
  'localModels',    // Ollama and anything else on-device
  'byok',           // user-supplied cloud API keys
  'agent.chat',
  'agent.plan',
  'agent.execute',  // gated by the confirmation phrase, never by tier
]);

const TIERS = Object.freeze({
  free: {
    rank: 0,
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    priceAnnual: 0,
    machines: 1,
    historyDays: 0,
    features: [],
    blurb: 'Everything on one machine, offline, no account.',
  },
  plus: {
    rank: 1,
    id: 'plus',
    name: 'Plus',
    priceMonthly: 6,
    priceAnnual: 60,
    machines: 3,
    historyDays: 30,
    features: ['history', 'graveyard'],
    blurb: 'History and the Graveyard Scanner, up to three machines.',
  },
  pro: {
    rank: 2,
    id: 'pro',
    name: 'Pro',
    priceMonthly: 12,
    priceAnnual: 120,
    machines: 10,
    historyDays: Infinity,
    features: ['history', 'graveyard', 'sync', 'secretAudit', 'scheduledSweeps', 'prioritySupport'],
    blurb: 'Unlimited history, sync across machines, secret audit, scheduled sweeps.',
  },
  max: {
    rank: 3,
    id: 'max',
    name: 'Max',
    priceMonthly: 29,
    priceAnnual: 290,
    perSeat: true,
    machines: Infinity,
    historyDays: Infinity,
    features: ['history', 'graveyard', 'sync', 'secretAudit', 'scheduledSweeps',
               'prioritySupport', 'fleet', 'sharedPolicy', 'sso', 'auditLog'],
    blurb: 'Fleet view, shared protect policies, SSO and an audit log.',
  },
});

const ORDER = ['free', 'plus', 'pro', 'max'];

// Ed25519 public key for licence verification. The matching private key signs
// licences on the issuing server and must never ship in the client.
//
// Placeholder until the real keypair is generated — see docs/LICENSING.md.
// With no key configured, verification fails to free, which is the safe default
// and keeps the app fully usable.
const LICENCE_PUBLIC_KEY = process.env.HANGAR_LICENCE_PUBKEY || '';

const OFFLINE_GRACE_DAYS = 14;

// --- verification -----------------------------------------------------------

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify a licence token. Returns a reason on every failure path so the UI can
 * explain itself rather than silently downgrading — a user who paid deserves to
 * know *why* their licence did not take.
 */
function verify(token, now = Date.now()) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'no-licence' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  if (!LICENCE_PUBLIC_KEY) return { ok: false, reason: 'no-public-key' };

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch { return { ok: false, reason: 'malformed' }; }

  let signatureOk = false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(LICENCE_PUBLIC_KEY, 'base64'),
      format: 'der',
      type: 'spki',
    });
    signatureOk = crypto.verify(
      null,                                   // Ed25519 takes no separate digest
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      b64urlDecode(parts[2]),
    );
  } catch { return { ok: false, reason: 'bad-signature' }; }

  if (!signatureOk) return { ok: false, reason: 'bad-signature' };
  if (!TIERS[payload.tier]) return { ok: false, reason: 'unknown-tier' };

  // Expiry, with grace. The grace window exists so a laptop that has been off
  // the network for a fortnight does not lose paid features mid-flight.
  const expMs = Number(payload.exp) * 1000;
  if (Number.isFinite(expMs) && now > expMs) {
    const graceMs = OFFLINE_GRACE_DAYS * 86400000;
    if (now > expMs + graceMs) return { ok: false, reason: 'expired', payload };
    return { ok: true, payload, grace: true, graceEndsMs: expMs + graceMs };
  }

  return { ok: true, payload, grace: false };
}

// --- state ------------------------------------------------------------------

function readLicenceFile() {
  try { return JSON.parse(fs.readFileSync(LICENCE_FILE, 'utf8')); } catch { return null; }
}

/**
 * The current entitlement. Never throws, never blocks — the worst case is free.
 */
function current(now = Date.now()) {
  const stored = readLicenceFile();
  const res = verify(stored && stored.token, now);

  if (!res.ok) {
    return {
      tier: TIERS.free,
      valid: false,
      reason: res.reason,
      // A licence that was valid and lapsed should say so, not pretend to be new.
      lapsed: res.reason === 'expired',
      grace: false,
      seats: 1,
    };
  }

  return {
    tier: TIERS[res.payload.tier],
    valid: true,
    reason: null,
    lapsed: false,
    grace: Boolean(res.grace),
    graceEndsMs: res.graceEndsMs || null,
    seats: Number(res.payload.seats) || 1,
    subject: res.payload.sub || null,
    expMs: Number(res.payload.exp) * 1000 || null,
  };
}

function save(token) {
  const res = verify(token);
  if (!res.ok) return { ok: false, reason: res.reason };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${LICENCE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, LICENCE_FILE);
  return { ok: true, entitlement: current() };
}

function clear() {
  try { fs.unlinkSync(LICENCE_FILE); } catch {}
  return current();
}

// --- gating -----------------------------------------------------------------

/**
 * Is `capability` available?
 *
 * Anything in UNGATEABLE is always true. That is not a policy check that could
 * be reordered away — it is the first branch, and gate() has no path that can
 * return false for those capabilities.
 */
function gate(capability, ent = current()) {
  if (UNGATEABLE.includes(capability)) return { allowed: true, ungateable: true };

  const allowed = ent.tier.features.includes(capability);
  return {
    allowed,
    ungateable: false,
    tier: ent.tier.id,
    // The cheapest tier that would unlock it — the UI should say "Plus", not "upgrade".
    requires: allowed ? null : ORDER.find((t) => TIERS[t].features.includes(capability)) || null,
  };
}

function machineLimit(ent = current()) { return ent.tier.machines; }
function historyDays(ent = current()) { return ent.tier.historyDays; }

/** Everything the settings UI needs, with no secrets in it. */
function describe(ent = current()) {
  return {
    tier: {
      id: ent.tier.id,
      name: ent.tier.name,
      blurb: ent.tier.blurb,
      priceMonthly: ent.tier.priceMonthly,
      priceAnnual: ent.tier.priceAnnual,
      perSeat: Boolean(ent.tier.perSeat),
      machines: ent.tier.machines === Infinity ? 'unlimited' : ent.tier.machines,
      historyDays: ent.tier.historyDays === Infinity ? 'unlimited' : ent.tier.historyDays,
    },
    valid: ent.valid,
    reason: ent.reason,
    lapsed: ent.lapsed,
    grace: ent.grace,
    graceEndsMs: ent.graceEndsMs || null,
    seats: ent.seats,
    subject: ent.subject || null,
    expMs: ent.expMs || null,
    ungateable: UNGATEABLE,
    catalogue: ORDER.map((id) => ({
      id,
      name: TIERS[id].name,
      blurb: TIERS[id].blurb,
      priceMonthly: TIERS[id].priceMonthly,
      priceAnnual: TIERS[id].priceAnnual,
      perSeat: Boolean(TIERS[id].perSeat),
      machines: TIERS[id].machines === Infinity ? 'unlimited' : TIERS[id].machines,
      historyDays: TIERS[id].historyDays === Infinity ? 'unlimited' : TIERS[id].historyDays,
      features: TIERS[id].features,
    })),
  };
}

module.exports = {
  TIERS, ORDER, UNGATEABLE, OFFLINE_GRACE_DAYS,
  verify, current, save, clear, gate, machineLimit, historyDays, describe,
  _paths: { LICENCE_FILE },
};
