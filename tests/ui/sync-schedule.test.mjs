import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSyncDecision, backoffMs } from '../../src/lib/sync-schedule.mjs';

const base = { online: true, waiting: 2, syncing: false, lastAttemptMs: 0, nowMs: 100_000, failures: 0, trigger: 'interval' };

test('offline never runs', () => {
  assert.deepEqual(nextSyncDecision({ ...base, online: false }), { run: false, reason: 'offline' });
});

test('nothing waiting never runs', () => {
  assert.deepEqual(nextSyncDecision({ ...base, waiting: 0 }), { run: false, reason: 'idle' });
});

test('one sync at a time', () => {
  assert.deepEqual(nextSyncDecision({ ...base, syncing: true }), { run: false, reason: 'busy' });
});

test('the interval waits 30 s since the last attempt', () => {
  assert.equal(nextSyncDecision({ ...base, lastAttemptMs: 80_000 }).run, false);
  assert.deepEqual(nextSyncDecision({ ...base, lastAttemptMs: 70_000 }), { run: true, reason: 'interval' });
});

test('coming back online or to the app runs after only 5 s', () => {
  assert.deepEqual(nextSyncDecision({ ...base, lastAttemptMs: 94_000, trigger: 'online' }), { run: true, reason: 'online' });
  assert.deepEqual(nextSyncDecision({ ...base, lastAttemptMs: 94_000, trigger: 'focus' }), { run: true, reason: 'focus' });
  assert.equal(nextSyncDecision({ ...base, lastAttemptMs: 97_000, trigger: 'online' }).run, false);
});

test('a manual tap always runs when online with work to do', () => {
  assert.deepEqual(nextSyncDecision({ ...base, lastAttemptMs: 99_999, failures: 3, trigger: 'manual' }), { run: true, reason: 'manual' });
});

test('after failures it backs off 30, 60, then 120 s at most', () => {
  assert.equal(backoffMs(0), 30_000);
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.equal(backoffMs(9), 120_000);
  assert.deepEqual(nextSyncDecision({ ...base, failures: 2, lastAttemptMs: 50_000 }), { run: false, reason: 'backoff' });
  assert.equal(nextSyncDecision({ ...base, failures: 2, lastAttemptMs: 39_000 }).run, true);
});

test('an online event does not skip a backoff', () => {
  assert.deepEqual(nextSyncDecision({ ...base, failures: 3, lastAttemptMs: 90_000, trigger: 'online' }), { run: false, reason: 'backoff' });
});
