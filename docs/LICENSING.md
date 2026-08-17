# HANGAR — licensing

How the paywall works, how to issue a licence, and what it deliberately cannot do.

Pricing rationale lives in [PRICING.md](PRICING.md). Tier definitions live in
[`lib/entitlements.js`](../lib/entitlements.js).

---

## The shape of it

A licence is an **Ed25519-signed token** the user pastes into Settings → Plan.
Hangar verifies it locally against a public key compiled into the build, then
caches it at `config/licence.json`.

There is **no phone-home**. Hangar never contacts a licence server — not at
launch, not on a timer, not at all. The token carries everything needed to
verify it.

```
header.payload.signature      # base64url, JWT-shaped, EdDSA only

payload = {
  "sub":   "user@example.com",   // who it was issued to
  "tier":  "pro",                // free | plus | pro | max
  "seats": 1,
  "iat":   1755300000,
  "exp":   1786836000
}
```

## Two properties that are enforced, not promised

**1. It cannot brick the app.** Every failure path — missing file, malformed
token, bad signature, unknown tier, expired, clock skew, no public key in the
build — resolves to the **free tier with Hangar fully working**. There is no code
path that returns "blocked".

[PLAN.md §5](PLAN.md): *"A licensing server that can brick the free tier is a
non-starter."*

**2. Safety cannot be sold.** `UNGATEABLE` in `lib/entitlements.js` lists the
capabilities no tier may gate, and `gate()` returns `allowed: true` for them as
its first branch — there is no path that can return false. It includes
`agent.execute`, because the typed confirmation is a safety boundary and
[PLAN.md §4](PLAN.md) says it has *"no exceptions, no setting to disable it."*
Pricing a tier that relaxes it would turn a safety property into a negotiation.

It also includes the local map (the reason anyone installs Hangar) and `byok`,
since Zed and Cursor both give unlimited bring-your-own-key away free — verified
2026-08-15, see [PRICING.md](PRICING.md).

`test/entitlements.test.js` asserts both properties, including that a validly
signed **max** licence still cannot gate `agent.execute`.

## Offline grace

A licence past `exp` keeps working for **14 days**, with the UI stating plainly
that it is in grace and how long is left. A laptop off the network for a
fortnight should not lose paid features mid-flight. Past that window it falls to
free — again, still fully working.

---

## Issuing licences

### 1. Generate the keypair — once

```bash
node -e "
const c=require('crypto');
const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');
console.log('PUBLIC  (ship this):');
console.log(publicKey.export({type:'spki',format:'der'}).toString('base64'));
console.log();
console.log('PRIVATE (never ship this):');
console.log(privateKey.export({type:'pkcs8',format:'pem'}));
"
```

The **public** key goes into the build as `HANGAR_LICENCE_PUBKEY`. The **private**
key signs licences on your issuing server and must never reach a client — anyone
holding it can mint a `max` licence for themselves.

With no public key configured, verification fails to free and paid tiers cannot
be activated. That is the correct default for a build that is not selling yet.

### 2. Sign a licence

```bash
node -e "
const c=require('crypto');
const key=c.createPrivateKey(require('fs').readFileSync('licence-private.pem'));
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const h=b64({alg:'EdDSA',typ:'JWT'});
const p=b64({
  sub:process.argv[1], tier:process.argv[2], seats:1,
  iat:Math.floor(Date.now()/1000),
  exp:Math.floor(Date.now()/1000)+31536000
});
console.log(h+'.'+p+'.'+c.sign(null,Buffer.from(h+'.'+p),key).toString('base64url'));
" user@example.com pro
```

### 3. Wire it to Stripe

Not built. The shape it should take:

1. Stripe Checkout → `checkout.session.completed` webhook
2. Webhook signs a licence for the customer's email at the purchased tier,
   `exp` = period end
3. Email it, and expose it in a customer portal for re-copying
4. `customer.subscription.updated` / `.deleted` → issue a replacement with a new
   `exp`, or let the current one lapse into grace and then to free

Because verification is offline, a cancelled subscription does not revoke
instantly — it lapses at `exp` plus grace. That is a deliberate trade: it is the
price of never phoning home. Keep `exp` short (monthly licences expire monthly)
and the exposure stays bounded.

---

## What is not built

- Stripe integration and the issuing server
- Machine-count enforcement (the limit is declared per tier and returned by the
  API; nothing counts machines yet — that needs sync, which is itself a Pro
  feature)
- Seat management for Max
- A customer portal

The gating layer, the tier ladder, verification, the settings UI, and the tests
are done. What remains is commerce plumbing, not product.
