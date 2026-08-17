#!/usr/bin/env node
'use strict';
/**
 * Hangar billing service.
 *
 * A separate deployable from the Hangar agent, because Stripe must be able to
 * reach the webhook and the agent binds to loopback. It is deliberately small:
 * create a Checkout Session, receive a webhook, mint a licence.
 *
 * It holds the licence private key, which makes it the one component in the
 * system worth attacking — anyone who can forge a webhook or read that key can
 * mint themselves a `max` licence. Everything defensive here follows from that.
 *
 * Environment:
 *   STRIPE_SECRET_KEY              sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET          whsec_…
 *   HANGAR_LICENCE_PRIVATE_KEY     PEM, from `node scripts/generate-keypair.js`
 *   HANGAR_PRICE_PLUS_MONTHLY      price_…      (and _ANNUAL, and PRO/MAX)
 *   HANGAR_SUCCESS_URL             where Stripe returns on success
 *   HANGAR_CANCEL_URL
 *   PORT                           default 8787
 */

const http = require('http');
const crypto = require('crypto');
const stripe = require('./stripe');
const licence = require('./licence');

const PORT = Number(process.env.PORT) || 8787;
const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRIVATE_KEY = process.env.HANGAR_LICENCE_PRIVATE_KEY || '';

const PRICES = {
  plus: [process.env.HANGAR_PRICE_PLUS_MONTHLY, process.env.HANGAR_PRICE_PLUS_ANNUAL].filter(Boolean),
  pro: [process.env.HANGAR_PRICE_PRO_MONTHLY, process.env.HANGAR_PRICE_PRO_ANNUAL].filter(Boolean),
  max: [process.env.HANGAR_PRICE_MAX_MONTHLY, process.env.HANGAR_PRICE_MAX_ANNUAL].filter(Boolean),
};

// Stripe retries webhooks, and a retried checkout.session.completed would mint
// a second licence. Event ids are remembered so a replay is a no-op. In-memory
// is adequate for a single instance; a second instance needs shared storage.
const seenEvents = new Map();
const EVENT_TTL_MS = 86400000;

function remember(id) {
  const now = Date.now();
  for (const [k, t] of seenEvents) if (now - t > EVENT_TTL_MS) seenEvents.delete(k);
  if (seenEvents.has(id)) return false;
  seenEvents.set(id, now);
  return true;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** Read the body as raw bytes — the webhook signature is over these exact bytes. */
function readRaw(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('body too large')); return; }
      raw += c;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/** What the operator forgot to set. Reported at boot, not on first customer. */
function configProblems() {
  const missing = [];
  if (!SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
  if (!WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!PRIVATE_KEY) missing.push('HANGAR_LICENCE_PRIVATE_KEY');
  if (!PRICES.pro.length) missing.push('HANGAR_PRICE_PRO_MONTHLY');
  return missing;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    const missing = configProblems();
    return json(res, missing.length ? 503 : 200, {
      ok: !missing.length,
      missingConfig: missing,
      mode: SECRET_KEY.startsWith('sk_live_') ? 'live' : SECRET_KEY ? 'test' : 'unconfigured',
    });
  }

  // --- start a purchase ------------------------------------------------------
  if (url.pathname === '/checkout' && req.method === 'POST') {
    const missing = configProblems();
    if (missing.length) return json(res, 503, { error: `Billing is not configured: ${missing.join(', ')}` });

    try {
      const body = JSON.parse(await readRaw(req) || '{}');
      const tier = String(body.tier || '');
      const cycle = body.cycle === 'annual' ? 'annual' : 'monthly';

      if (!['plus', 'pro', 'max'].includes(tier)) return json(res, 400, { error: 'tier must be plus, pro, or max' });

      const priceId = cycle === 'annual'
        ? process.env[`HANGAR_PRICE_${tier.toUpperCase()}_ANNUAL`]
        : process.env[`HANGAR_PRICE_${tier.toUpperCase()}_MONTHLY`];
      if (!priceId) return json(res, 503, { error: `No price configured for ${tier} ${cycle}.` });

      const out = await stripe.createCheckout({
        secretKey: SECRET_KEY,
        priceId,
        tier,
        email: typeof body.email === 'string' ? body.email.slice(0, 200) : undefined,
        successUrl: process.env.HANGAR_SUCCESS_URL || 'https://army161.github.io/hangar/thanks.html',
        cancelUrl: process.env.HANGAR_CANCEL_URL || 'https://army161.github.io/hangar/',
        idempotencyKey: crypto.randomUUID(),
      });

      if (!out.ok) return json(res, 502, { error: out.error });
      return json(res, 200, { url: out.data.url, sessionId: out.data.id });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // --- Stripe calls us -------------------------------------------------------
  if (url.pathname === '/webhook' && req.method === 'POST') {
    let raw;
    try { raw = await readRaw(req); } catch (e) { return json(res, 413, { error: e.message }); }

    const check = stripe.verifyWebhook(raw, req.headers['stripe-signature'], WEBHOOK_SECRET);
    if (!check.ok) {
      // 400, never 200: a 2xx tells Stripe the event was handled and it stops
      // retrying — masking a real misconfiguration as success.
      console.error(`[webhook] rejected: ${check.reason}`);
      return json(res, 400, { error: check.reason });
    }

    const event = check.event;
    if (!remember(event.id)) {
      // Already processed. 200 so Stripe stops retrying.
      return json(res, 200, { ok: true, duplicate: true });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        // The tier comes from the session Stripe signed, never from anything a
        // client sent us.
        const tier = session.client_reference_id;
        const sub = session.customer_details?.email || session.customer_email || session.customer;

        let periodEnd = null;
        if (session.subscription) {
          const s = await stripe.getSubscription({ secretKey: SECRET_KEY, subscriptionId: session.subscription });
          if (s.ok) periodEnd = s.data.current_period_end;
        }

        const minted = licence.mint({ privateKeyPem: PRIVATE_KEY, sub, tier, periodEndSec: periodEnd });
        // Delivery is the operator's choice — email, dashboard, or a log to
        // copy from during a soft launch. Deliberately not wired to a mail
        // provider here: that is a credential this service does not need.
        console.log(`[licence] ${tier} for ${sub}, exp ${new Date(minted.exp * 1000).toISOString()}`);
        console.log(`[licence] ${minted.token}`);
      }

      if (event.type === 'customer.subscription.updated' || event.type === 'invoice.paid') {
        const obj = event.data.object;
        const tier = obj.metadata?.hangar_tier;
        const periodEnd = obj.current_period_end || obj.lines?.data?.[0]?.period?.end;
        if (tier && periodEnd) {
          const minted = licence.mint({
            privateKeyPem: PRIVATE_KEY,
            sub: obj.customer_email || obj.customer,
            tier,
            periodEndSec: periodEnd,
          });
          console.log(`[licence] renewed ${tier}, exp ${new Date(minted.exp * 1000).toISOString()}`);
          console.log(`[licence] ${minted.token}`);
        }
      }

      // Cancellation is intentionally a no-op. Verification is offline, so
      // there is nothing to revoke — the licence simply lapses at exp plus the
      // client's grace. That is the cost of never phoning home (PLAN §5).
      if (event.type === 'customer.subscription.deleted') {
        console.log(`[licence] subscription cancelled; existing licence lapses at its own exp`);
      }

      return json(res, 200, { ok: true });
    } catch (e) {
      console.error(`[webhook] handler failed: ${e.message}`);
      // 500 so Stripe retries — a transient failure should not silently drop a
      // paid customer's licence.
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: 'not found' });
});

if (require.main === module) {
  const missing = configProblems();
  server.listen(PORT, () => {
    console.log(`\n  Hangar billing  ·  port ${PORT}`);
    console.log(`  Mode        ${SECRET_KEY.startsWith('sk_live_') ? 'LIVE — real charges' : SECRET_KEY ? 'test' : 'UNCONFIGURED'}`);
    if (missing.length) {
      console.log(`\n  Not ready. Missing: ${missing.join(', ')}`);
      console.log('  /checkout will refuse until these are set.\n');
    } else {
      console.log('  Ready.\n');
    }
  });
}

module.exports = { server, configProblems };
