'use strict';
/**
 * VRAM fit and default selection.
 *
 * The case these exist for is the one PLAN §4 recorded on 2026-07-31: a 9B
 * model needs ~6.6 GB and OOMs reproducibly below ~5 GB free on an 8 GB card.
 * Defaulting the picker to that model on a machine that cannot run it is a
 * guaranteed failure the moment the user presses Send.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../lib/agent/models');

// The models actually present on this machine, from live discovery.
const LOCAL = [
  { provider: 'ollama', id: 'qwen3.5:0.8b', sizeGb: 1 },
  { provider: 'ollama', id: 'qwen3.5:2b', sizeGb: 2.7 },
  { provider: 'ollama', id: 'qwen3.5:4b', sizeGb: 3.4 },
  { provider: 'ollama', id: 'llama3.1:latest', sizeGb: 4.9 },
  { provider: 'ollama', id: 'qwen3.5:9b', sizeGb: 6.6 },
  { provider: 'ollama', id: 'gemma4:latest', sizeGb: 9.6 },
  { provider: 'ollama', id: 'qwen3.6:latest', sizeGb: 23.9 },
];
const CLOUD = [{ provider: 'anthropic', id: 'claude-opus-5' }];

// --- fit --------------------------------------------------------------------

test('a model larger than free VRAM does not fit', () => {
  assert.equal(m.fitsVram({ sizeGb: 9.6 }, 6.0), false);
  assert.equal(m.fitsVram({ sizeGb: 23.9 }, 6.0), false);
});

test('headroom is applied — weights are not the whole cost', () => {
  // 6.6 GB of weights against exactly 6.6 GB free must not be called a fit:
  // the KV cache, context, and runtime overhead sit alongside them.
  assert.equal(m.fitsVram({ sizeGb: 6.6 }, 6.6), false);
  assert.equal(m.fitsVram({ sizeGb: 6.6 }, 7.6), true);
  assert.ok(m.VRAM_HEADROOM > 1, 'headroom must actually reserve something');
});

test('the PLAN §4 case: 6.6 GB model against 6.0 GB free', () => {
  assert.equal(m.fitsVram({ sizeGb: 6.6 }, 6.0), false,
    'this is the exact OOM recorded on 2026-07-31');
});

test('fit is unanswerable, not false, when it does not apply', () => {
  assert.equal(m.fitsVram({ provider: 'anthropic', id: 'claude-opus-5' }, 6.0), null,
    'a cloud model has no local footprint');
  assert.equal(m.fitsVram({ sizeGb: 3.4 }, null), null,
    'no VRAM reading is not a reason to call a model unfit');
  assert.equal(m.fitsVram(null, 6.0), null);
});

// --- default selection ------------------------------------------------------

test('the default is the largest model that actually fits', () => {
  // 6.0 GB free: 4.9 GB fits with headroom (5.6), 6.6 GB does not.
  const pick = m.pickDefault(LOCAL, 6.0);
  assert.equal(pick.id, 'llama3.1:latest');
});

test('the default never selects a model that cannot load', () => {
  for (const freeGb of [0.5, 1.7, 3, 6, 8, 12, 30]) {
    const pick = m.pickDefault(LOCAL, freeGb);
    const fits = m.fitsVram(pick, freeGb);
    // Either it fits, or nothing did and we fell back to the smallest.
    if (fits === false) {
      const anyFits = LOCAL.some((x) => m.fitsVram(x, freeGb));
      assert.equal(anyFits, false, `at ${freeGb} GB something fit but ${pick.id} was chosen`);
      assert.equal(pick.id, 'qwen3.5:0.8b', 'fallback must be the smallest, not the largest');
    }
  }
});

test('the low-VRAM case picks the smallest rather than the biggest', () => {
  // 1.7 GB free — the reading taken while models were loaded. Nothing fits.
  const pick = m.pickDefault(LOCAL, 1.7);
  assert.equal(pick.id, 'qwen3.5:0.8b');
});

test('plenty of VRAM selects the largest', () => {
  assert.equal(m.pickDefault(LOCAL, 40).id, 'qwen3.6:latest');
});

test('with no VRAM reading, no local model is claimed to fit', () => {
  const pick = m.pickDefault(LOCAL, null);
  // fitsVram returns null throughout, so nothing is "fitting" — fall back to
  // the smallest rather than optimistically picking a 24 GB model.
  assert.equal(pick.id, 'qwen3.5:0.8b');
});

test('cloud-only falls back to the first available model', () => {
  assert.equal(m.pickDefault(CLOUD, 6.0).id, 'claude-opus-5');
});

test('an empty list returns null rather than throwing', () => {
  assert.equal(m.pickDefault([], 6.0), null);
});

// --- the advice string carries the number the UI needs ----------------------

test('recommendLocal exposes the raw free figure', () => {
  const r = m.recommendLocal(6.04);
  assert.equal(r.freeGb, 6.0, 'the UI needs the number, not just the prose');
  assert.equal(r.tier, 'medium');
  assert.equal(m.recommendLocal(null).freeGb, null);
});
