'use strict';
/**
 * Licence minting.
 *
 * The counterpart to lib/entitlements.js. That file verifies with a public key
 * shipped in the client; this one signs with a private key that must never
 * leave the billing service — anyone holding it can mint themselves a `max`
 * licence, so it is the single most sensitive value in the system.
 *
 * The key is read from the environment, never a file in the repo and never a
 * request parameter.
 */

const crypto = require('crypto');

const TIERS = ['free', 'plus', 'pro', 'max'];

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * Mint a signed licence.
 *
 * `exp` is deliberately short — one billing period plus a small margin. Because
 * verification is offline, a cancelled subscription cannot be revoked
 * instantly; it lapses at exp plus the client's 14-day grace. Short expiries
 * are what bound that exposure, so a "1 year" licence for a monthly plan would
 * be a year of free service after cancellation.
 */
function mint({ privateKeyPem, sub, tier, seats = 1, periodEndSec, now = Date.now() }) {
  if (!privateKeyPem) throw new Error('HANGAR_LICENCE_PRIVATE_KEY is not set — cannot sign licences.');
  if (!TIERS.includes(tier)) throw new Error(`Unknown tier "${tier}".`);
  if (!sub) throw new Error('A licence needs a subject (the customer email or id).');

  const iat = Math.floor(now / 1000);
  // Period end plus two days, so a licence never expires before Stripe has had
  // a chance to renew it and issue the replacement.
  const exp = periodEndSec ? Math.floor(periodEndSec) + 172800 : iat + 2678400;

  const header = b64url({ alg: 'EdDSA', typ: 'JWT' });
  const payload = b64url({ sub, tier, seats: Number(seats) || 1, iat, exp });

  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`), key).toString('base64url');

  return { token: `${header}.${payload}.${sig}`, exp, tier, sub, seats };
}

/** Generate a keypair. The private half is printed once and never stored here. */
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/**
 * Map a Stripe price id to a tier.
 *
 * Driven by config rather than inferred from the amount: reading the tier off
 * the price would mean a discount code or a currency change could silently
 * change what a customer is entitled to.
 */
function tierForPrice(priceId, priceMap) {
  for (const [tier, ids] of Object.entries(priceMap || {})) {
    if (Array.isArray(ids) ? ids.includes(priceId) : ids === priceId) return tier;
  }
  return null;
}

module.exports = { mint, generateKeypair, tierForPrice, TIERS };
