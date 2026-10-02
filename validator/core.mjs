// The validator: the phone's door, with a scanner, a card reader, a clock it
// checks, a light, a buzzer and a small screen around it.
//
// Every verdict comes from the door (src/device/terminal.js, run unchanged).
// This adds only what a box on a doorframe needs and a phone in a conductor's
// hand did not:
//
//   - A clock gate. A phone's clock is set by its network; a Pi's is set by
//     the DS3231 or it is not set at all, and a door that does not know the
//     time cannot apply the 300-second tap window. It refuses until it does.
//   - A pairing lock. A phone is paired by the crew through its own screen. A
//     validator's scanner is pointed at the public, so the vehicle key can be
//     loaded through it only while the validator has none — otherwise a
//     stranger with a QR code could re-key the door and strand every fare.
//   - Feedback and the screen, both drawn from the door's own state.
//
// Nothing here is reached from protocol/ and nothing here decides a fare.

import { screenFor, HOLD_MS } from './ui/screens.mjs';
import { doorActionFor } from './hw/signals.mjs';

export function patternFor(result) {
  if (!result) return 'idle';
  if (result.reason === 'at_capacity') return 'held';
  if (!result.ok) return 'invalid';
  if (result.action === 'out') return 'out';
  if (result.action === 'in') return 'in';
  return 'idle';
}

export function createValidator({ door, clock, signals = null, display = null, online = () => false, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
  let snap = door.snapshot();
  let local = null;
  let validating = false;
  let lastSeenAt = snap.last?.at ?? null;
  let expiry = null;
  const results = [];

  function refresh() {
    const model = screenFor({ snap, local, clock: clock.status(), online: online(), validating, now: now() });
    display?.show(model);
    // Come back when the verdict on screen runs out, so the door returns to
    // waiting without anybody touching it.
    if (expiry) clearTimer(expiry);
    expiry = null;
    const newest = [snap.last, local].filter(Boolean).sort((a, b) => b.at - a.at)[0];
    if (newest && !validating) {
      const hold = HOLD_MS[patternFor(newest) === 'held' ? 'held' : newest.ok ? newest.action ?? 'invalid' : 'invalid'] ?? HOLD_MS.invalid;
      const left = newest.at + hold - now();
      if (left > 0) expiry = setTimer(refresh, left + 20);
    }
    return model;
  }

  function react(result, source) {
    results.push(result);
    signals?.show(patternFor(result));
    const action = doorActionFor(result, snap.role);
    if (action) log(`door ${snap.doorId}: ${action.action} (${action.why}) via ${source}`);
  }

  const stop = door.subscribe((next) => {
    snap = next;
    // A new verdict from the door — from the scanner or from a card, it does
    // not matter which — is what the light and buzzer answer to.
    if (next.last && next.last.at !== lastSeenAt) {
      lastSeenAt = next.last.at;
      if (!validating) react(next.last, 'door');
    }
    refresh();
  });

  function refuseLocally(result) {
    local = { ...result, at: now() };
    react(local, 'validator');
    refresh();
    return local;
  }

  function clockOk() {
    const status = clock.status();
    if (status.trusted) return true;
    refuseLocally({ ok: false, reason: 'clock_untrusted', message: `Clock not trusted (${status.reason}).` });
    return false;
  }

  // A code the scanner has already screened for shape. The door verifies it.
  async function present(code) {
    if (!snap.paired) return refuseLocally({ ok: false, reason: 'unpaired', message: 'Not paired to a vehicle.' });
    if (!clockOk()) return local;
    validating = true;
    refresh();
    const before = door.snapshot().last;
    let result;
    try {
      result = await door.present({ text: code });
    } finally {
      validating = false;
    }
    snap = door.snapshot();
    lastSeenAt = snap.last?.at ?? lastSeenAt;
    // A refusal the door returns without keeping it as its last verdict (a
    // code it would not even look at) is still shown.
    if (!result.ok && snap.last === before) local = { ...result, at: now() };
    react(result, 'scanner');
    refresh();
    return result;
  }

  // What the scanner read that was not a ride code. The one thing worth doing
  // with it is loading the vehicle key into a validator that has none.
  async function unrecognised(raw) {
    const text = String(raw ?? '').trim();
    if (text.startsWith('{') && !snap.paired) {
      const paired = await door.pair(text);
      snap = door.snapshot();
      if (!paired.ok) return refuseLocally({ ok: false, reason: 'unreadable', message: paired.message });
      local = null;
      log(`paired: ${paired.message}`);
      refresh();
      return paired;
    }
    return refuseLocally({ ok: false, reason: 'unreadable', message: 'Not a Bhada ride code.' });
  }

  // A rider card, by serial. Gated on the clock like everything else: the
  // tap the door signs for the card carries the time, and so does the receipt.
  function cardReader(reader) {
    return {
      onCard(fn) {
        return reader.onCard((uid) => {
          if (!snap.paired) {
            refuseLocally({ ok: false, reason: 'unpaired' });
            return;
          }
          if (!clockOk()) return;
          fn(uid);
        });
      },
    };
  }

  return {
    present,
    unrecognised,
    cardReader,
    refresh,
    results: () => results,
    screen: () => screenFor({ snap, local, clock: clock.status(), online: online(), validating, now: now() }),
    stop() {
      stop();
      if (expiry) clearTimer(expiry);
    },
  };
}
