// Sync that happens by itself, and a status a person can read.
//
// Each app hands in two functions: how many things are waiting, and how to send
// them. This hook decides when (see sync-schedule.mjs), runs at most one at a
// time, and reports online, waiting, syncing, last synced and the last error.
// The decision is re-checked every 5 seconds, on the `online` event, and when
// the app comes back to the front.

import { useCallback, useEffect, useRef, useState } from 'react';
import { nextSyncDecision } from './sync-schedule.mjs';

const CHECK_MS = 5_000;

function readStamp(key) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStamp(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private mode: the pill shows "not yet" instead of a time. Nothing breaks.
  }
}

export function useSyncStatus({ name, pending, run, enabled = true }) {
  const stampKey = `bhada.synced.${name}`;
  const [online, setOnline] = useState(() => navigator.onLine);
  const [waiting, setWaiting] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => readStamp(stampKey));
  const [error, setError] = useState(null);

  const state = useRef({ syncing: false, lastAttemptMs: 0, failures: 0, waiting: 0 });
  const fns = useRef({ pending, run });
  fns.current = { pending, run };

  const count = useCallback(async () => {
    try {
      const n = await fns.current.pending();
      state.current.waiting = n;
      setWaiting(n);
      return n;
    } catch {
      return state.current.waiting;
    }
  }, []);

  const attempt = useCallback(async (trigger) => {
    if (!enabled) return;
    // The lock is taken before the first await. Taken after, two triggers that
    // land together (StrictMode's double effect, focus + online) both read
    // "not syncing" and send the same batch twice.
    if (state.current.syncing) return;
    state.current.syncing = true;
    const waitingNow = await count();
    const decision = nextSyncDecision({
      online: navigator.onLine,
      waiting: waitingNow,
      syncing: false,
      lastAttemptMs: state.current.lastAttemptMs,
      nowMs: Date.now(),
      failures: state.current.failures,
      trigger,
    });
    if (!decision.run) {
      state.current.syncing = false;
      return;
    }
    state.current.lastAttemptMs = Date.now();
    setSyncing(true);
    try {
      await fns.current.run();
      state.current.failures = 0;
      const now = Date.now();
      writeStamp(stampKey, now);
      setLastSyncedAt(now);
      setError(null);
    } catch (problem) {
      // A failure while the radio is off is not the backend's fault and must
      // not push the next attempt back.
      if (navigator.onLine) state.current.failures += 1;
      setError(problem?.message ?? 'Sync failed.');
    } finally {
      state.current.syncing = false;
      setSyncing(false);
      await count();
    }
  }, [count, enabled, stampKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    count();
    const onOnline = () => { setOnline(true); attempt('online'); };
    const onOffline = () => setOnline(false);
    const onVisible = () => { if (document.visibilityState === 'visible') attempt('focus'); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => attempt('interval'), CHECK_MS);
    attempt('focus');
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [attempt, count, enabled]);

  const syncNow = useCallback(() => attempt('manual'), [attempt]);
  // Screens that write to an outbox call this so the count updates at once.
  const refresh = useCallback(() => count(), [count]);

  return { online, waiting, syncing, lastSyncedAt, error, syncNow, refresh };
}
