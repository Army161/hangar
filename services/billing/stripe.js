'use strict';
/**
 * Stripe client and webhook verification.
 *
 * Raw HTTPS rather than the `stripe` npm package: this repo's first claim is
 * zero dependencies, and the two calls actually needed here — create a Checkout
 * Session, read an event — are a form POST and a JSON parse. The SDK would add
 * ~40 transitive packages to save about thirty lines.
 *
 * The security-critical function in this file is verifyWebhook. Getting it
 * wrong is the most common Stripe integration bug, and it is exploitable: an
 * unverified webhook endpoint lets anyone POST a fake
 * `checkout.session.completed` and mint themselves a paid licence.
 */

const https = require('https');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

const API = 'api.stripe.com';

/** Stripe takes form-encoded bodies, including for nested fields. */
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => form({ [i]: item }, key, out));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

function request(path, { method = 'POST', body, secretKey, idempotencyKey } = {}) {
  return new Promise((resolve) => {
    const payload = body ? form(body).toString() : '';
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'Stripe-Version': '2024-06-20',
    };
    // Stripe retries on network failure; without this a retry can create a
    // second Checkout Session for the same click.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const req = https.request({ hostname: API, path, method, headers, timeout: 20000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* fall through */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, status: res.statusCode, error: (data && data.error && data.error.message) || raw.slice(0, 300) });
        }
        resolve({ ok: true, data });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Stripe timed out' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(payload);
  });
}

/**
 * Create a Checkout Session for one tier.
 *
 * `client_reference_id` carries the tier through to the webhook. It is echoed
 * back on the completed event, so the licence is minted for the tier that was
 * actually paid for rather than one the client claimed.
 */
async function createCheckout({ secretKey, priceId, tier, successUrl, cancelUrl, email, idempotencyKey }) {
  return request('/v1/checkout/sessions', {
    secretKey,
    idempotencyKey,
    body: {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: tier,
      customer_email: email || undefined,
      allow_promotion_codes: true,
      // Surfaces the tier on the subscription itself, so a later
      // customer.subscription.updated knows what to re-issue without a lookup.
      subscription_data: { metadata: { hangar_tier: tier } },
    },
  });
}

async function getSubscription({ secretKey, subscriptionId }) {
  return request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'GET', secretKey });
}

// --- webhook verification ---------------------------------------------------

const DEFAULT_TOLERANCE_SEC = 300;

/**
 * Verify a Stripe webhook signature.
 *
 * Four things must all hold, and each guards a distinct attack:
 *
 *  1. The RAW body is used. Re-serialising parsed JSON changes bytes (key
 *     order, whitespace, unicode escaping) and the MAC will not match — the
 *     usual cause of "signature verification failed" on a genuine event.
 *  2. The signature is compared with timingSafeEqual. A byte-by-byte compare
 *     leaks how much of a forged signature was correct.
 *  3. The timestamp is checked. Without it a captured legitimate webhook can
 *     be replayed forever — and replaying checkout.session.completed mints
 *     licences.
 *  4. EVERY v1 signature is tried. Stripe sends several during secret
 *     rotation; taking only the first breaks the rollover.
 */
function verifyWebhook(rawBody, signatureHeader, webhookSecret, { toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() } = {}) {
  if (!rawBody || !signatureHeader || !webhookSecret) {
    return { ok: false, reason: 'missing body, signature, or secret' };
  }

  const parts = String(signatureHeader).split(',').map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));

  if (!timestamp || !signatures.length) return { ok: false, reason: 'malformed signature header' };

  const ageSec = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSec)) return { ok: false, reason: 'bad timestamp' };
  if (ageSec > toleranceSec) return { ok: false, reason: `timestamp outside tolerance (${Math.round(ageSec)}s)` };

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const matched = signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    // timingSafeEqual throws on length mismatch, which would itself be a
    // length oracle — check length first and return false, don't throw.
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });

  if (!matched) return { ok: false, reason: 'signature mismatch' };

  try { return { ok: true, event: JSON.parse(rawBody) }; }
  catch { return { ok: false, reason: 'body is not JSON' }; }
}

module.exports = { createCheckout, getSubscription, verifyWebhook, form, request, DEFAULT_TOLERANCE_SEC };
