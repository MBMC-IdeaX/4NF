import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadPolicy, JSQR_OPTIONS } from '../../src/lib/qr-read.mjs';

test('native reader is used only when it reports qr_code', () => {
  assert.equal(createReadPolicy({ nativeFormats: ['ean_13'] }).useNative, false);
  assert.equal(createReadPolicy({ nativeFormats: ['qr_code'] }).useNative, true);
  assert.equal(createReadPolicy({ nativeFormats: null }).useNative, false);
});

test('jsQR still runs every third frame while native finds nothing', () => {
  const policy = createReadPolicy({ nativeFormats: ['qr_code'] });
  const runs = [1, 2, 3, 4, 5, 6].filter((tick) => policy.tryFallback(tick, false));
  assert.deepEqual(runs, [3, 6]);
  assert.equal(policy.tryFallback(3, true), false);
});

test('without native, jsQR runs every frame', () => {
  const policy = createReadPolicy({ nativeFormats: null });
  assert.equal(policy.tryFallback(1, false), true);
});

test('dark-mode codes are decoded', () => {
  assert.equal(JSQR_OPTIONS.inversionAttempts, 'attemptBoth');
});
