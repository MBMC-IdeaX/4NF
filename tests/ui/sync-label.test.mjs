import test from 'node:test';
import assert from 'node:assert/strict';
import { syncLabel } from '../../src/lib/sync-label.mjs';

const now = 1_000_000_000;

test('offline says so, with what is waiting', () => {
  assert.deepEqual(syncLabel({ online: false, waiting: 3, nowMs: now }), { tone: 'offline', ne: 'अफलाइन · ३ बाँकी', en: 'Offline · 3 waiting' });
  assert.deepEqual(syncLabel({ online: false, waiting: 0, nowMs: now }), { tone: 'offline', ne: 'अफलाइन', en: 'Offline' });
});

test('syncing wins over everything online', () => {
  assert.equal(syncLabel({ online: true, syncing: true, waiting: 2, nowMs: now }).en, 'Sending 2');
});

test('waiting with an error shows the error tone', () => {
  assert.equal(syncLabel({ online: true, waiting: 1, error: 'x', nowMs: now }).tone, 'error');
  assert.equal(syncLabel({ online: true, waiting: 1, error: 'x', nowMs: now }).en, '1 waiting · will retry');
});

test('synced shows how long ago in words a person reads', () => {
  assert.equal(syncLabel({ online: true, waiting: 0, lastSyncedAt: now - 20_000, nowMs: now }).en, 'Synced just now');
  assert.equal(syncLabel({ online: true, waiting: 0, lastSyncedAt: now - 5 * 60_000, nowMs: now }).en, 'Synced 5 min ago');
  assert.equal(syncLabel({ online: true, waiting: 0, lastSyncedAt: now - 3 * 3_600_000, nowMs: now }).en, 'Synced 3 h ago');
  assert.equal(syncLabel({ online: true, waiting: 0, lastSyncedAt: now - 3 * 86_400_000, nowMs: now }).en, 'Synced 3 days ago');
  assert.equal(syncLabel({ online: true, waiting: 0, lastSyncedAt: null, nowMs: now }).en, 'Up to date');
});

test('Nepali uses Devanagari digits', () => {
  assert.equal(syncLabel({ online: true, waiting: 0, lastSyncedAt: now - 12 * 60_000, nowMs: now }).ne, '१२ मिनेट अघि');
});
