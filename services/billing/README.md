# Hangar billing service

Turns a Stripe purchase into a signed licence. Deploy separately from the
Hangar app: Stripe must reach the webhook, and the app binds to loopback.

Zero dependencies — raw HTTPS to Stripe's REST API.

---

## Why it is a separate service

The app cannot talk to Stripe directly. That needs a secret key, and a secret
key on every customer's machine is a secret key that has leaked. So:

```
Hangar app (localhost)                 Billing service (public)        Stripe
  │                                        │                             │
  ├── POST /api/billing/checkout ────────► │ ── create session ────────► │
  │   ◄── { url } ──────────────────────── │                             │
  │                                        │                             │
  │   user completes purchase in browser ──┼───────────────────────────► │
  │                                        │ ◄── signed webhook ──────── │
  │                                        │    mints licence            │
  │   user pastes licence into Settings    │                             │
```

The app holds only the **public** key and verifies offline. It never phones
home, never sees a card, and works with the network unplugged.

---

## Setup

### 1. Keypair — once

```bash
node scripts/generate-keypair.js
```

Prints both halves and writes neither to disk. The **public** key goes into the
Hangar build as `HANGAR_LICENCE_PUBKEY`; the **private** key goes into this
service's secret store and nowhere else.

> Anyone with the private key can mint themselves a `max` licence for free,
> forever, and you cannot revoke it — verification is offline, so there is no
> server to tell "this one is void".

### 2. Stripe products

Create one product per paid tier, each with a monthly and an annual price:

| Tier | Monthly | Annual |
|---|---|---|
| Plus | $6 | $60 |
| Pro | $12 | $120 |
| Max | $29 per seat | $290 per seat |

Copy the six `price_…` ids.

### 3. Environment

```bash
STRIPE_SECRET_KEY=sk_live_…            # sk_test_… while you are testing
STRIPE_WEBHOOK_SECRET=whsec_…          # from the webhook endpoint you create
HANGAR_LICENCE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----…"

HANGAR_PRICE_PLUS_MONTHLY=price_…
HANGAR_PRICE_PLUS_ANNUAL=price_…
HANGAR_PRICE_PRO_MONTHLY=price_…
HANGAR_PRICE_PRO_ANNUAL=price_…
HANGAR_PRICE_MAX_MONTHLY=price_…
HANGAR_PRICE_MAX_ANNUAL=price_…

HANGAR_SUCCESS_URL=https://…/thanks
HANGAR_CANCEL_URL=https://…/
```

`GET /health` lists anything missing and reports whether the key is live or
test. `/checkout` refuses until the required set is present, rather than
failing on a customer's first click.

### 4. Webhook endpoint

Point Stripe at `https://your-host/webhook` and subscribe to:

- `checkout.session.completed` — mints the first licence
- `invoice.paid` — re-issues on renewal
- `customer.subscription.updated` — re-issues on plan change

### 5. Point the app at it

```bash
HANGAR_BILLING_URL=https://your-host
```

Without it the Plan card shows **Not yet on sale** instead of an Upgrade button
that 503s.

---

## Delivery is deliberately unwired

A minted licence is written to the log. Wire it to email, a dashboard, or copy
it by hand during a soft launch — but that is your choice to make, and a mail
provider is a credential this service does not otherwise need.

The obvious next step is a `POST` to your mailer inside the
`checkout.session.completed` branch of `server.js`.

---

## What is enforced

**Webhook signatures are verified properly.** The raw body is used (re-serialised
JSON changes bytes and never matches), the comparison is timing-safe, the
timestamp is checked against a 5-minute tolerance so a captured webhook cannot
be replayed, and every `v1` signature is tried so secret rotation works.

An unverified endpoint would let anyone POST a fake
`checkout.session.completed` and mint themselves a paid licence. Verified in
`demo/billing-e2e.js`: a genuine webhook mints a Pro licence, the same payload
edited to `max` is refused with `signature mismatch`, and a replay is a no-op.

**Licence expiry follows the billing period**, plus two days so a renewal never
races a lapse. A year-long licence on a monthly plan would be a year of free
service after cancellation, because offline verification cannot revoke.

**Tier comes from the price id**, mapped by config — never inferred from the
amount, so a discount code cannot change what a customer is entitled to.

**Cancellation is a no-op by design.** The licence lapses at `exp` plus the
client's 14-day grace. That is the cost of never phoning home, which
[PLAN §5](../../docs/PLAN.md) chose deliberately. Keep `exp` short and the
exposure stays bounded.

---

## Testing without live keys

```bash
node demo/billing-e2e.js
```

Runs the whole chain — signed webhook → licence → verification → gating — with
a generated keypair and a fake secret key. Covers everything except Stripe's
hosted card page.

For the real thing, use `sk_test_…` keys and `stripe listen --forward-to
localhost:8787/webhook`.
