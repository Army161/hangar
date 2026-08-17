#!/usr/bin/env node
'use strict';
/**
 * Generate the licence signing keypair. Run once.
 *
 *   node scripts/generate-keypair.js
 *
 * The private key is printed and never written to disk by this script — a
 * signing key sitting in the repo directory is the single worst place for it,
 * and `git add -A` has ended more than one product's key hygiene.
 */

const { generateKeypair } = require('../services/billing/licence');

const { publicKeyBase64, privateKeyPem } = generateKeypair();

const line = '─'.repeat(72);

process.stdout.write(`
${line}
PUBLIC KEY — ships in the Hangar build
${line}

Set this where the app is built and run:

  HANGAR_LICENCE_PUBKEY=${publicKeyBase64}

Safe to commit, safe to publish. It can only verify licences, never mint them.

${line}
PRIVATE KEY — the billing service only. Never ships. Never commits.
${line}

Set this on the billing service only:

  HANGAR_LICENCE_PRIVATE_KEY="$(cat <<'PEM'
${privateKeyPem.trim()}
PEM
)"

${line}

Anyone holding the private key can mint themselves a "max" licence for free,
forever, and you cannot revoke it — verification is offline by design, so there
is no server to tell "this one is void".

Store it in your host's secret manager (Fly secrets, Railway variables, AWS
Secrets Manager, 1Password). Do not paste it into a file in this repo, a
Dockerfile, or a CI log.

If it leaks: generate a new pair, ship a build carrying the new public key, and
re-issue licences to paying customers. Every licence signed with the old key
keeps working on every build that already shipped — which is why this is worth
getting right the first time.

`);
