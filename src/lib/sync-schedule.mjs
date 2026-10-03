// When a device should try to sync, as a pure rule.
//
// Nobody on a bus should have to press "send". A phone with work queued tries
// on its own: when the network comes back, when the app comes back to the
// front, and every 30 seconds while it is online. A manual tap always goes.
// After repeated failures it backs off — 30 s, 60 s, then two minutes at most —
// so a backend that is down is not hammered by every phone in the valley.

export const INTERVAL_MS = 30_000;
export const QUICK_MS = 5_000;
const BACKOFF_CAP_MS = 120_000;

export function backoffMs(failures) {
  if (failures <= 1) return INTERVAL_MS;
  return Math.min(BACKOFF_CAP_MS, INTERVAL_MS * 2 ** (failures - 1));
}

export function nextSyncDecision({ online, waiting, syncing, lastAttemptMs = 0, nowMs, failures = 0, trigger = 'interval' }) {
  if (!online) return { run: false, reason: 'offline' };
  if (!waiting) return { run: false, reason: 'idle' };
  if (syncing) return { run: false, reason: 'busy' };
  if (trigger === 'manual') return { run: true, reason: 'manual' };

  const quick = trigger === 'online' || trigger === 'focus';
  let gap = quick ? QUICK_MS : INTERVAL_MS;
  const backingOff = failures >= 2;
  if (backingOff) gap = Math.max(gap, backoffMs(failures));
  if (nowMs - lastAttemptMs < gap) return { run: false, reason: backingOff ? 'backoff' : 'wait' };
  return { run: true, reason: quick ? trigger : 'interval' };
}
