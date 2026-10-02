// What the 320×240 screen says, decided from the door's own state.
//
// The screen is never the source of truth. It is a picture of two things the
// door already knows: `snap`, the snapshot terminal.js publishes, whose `last`
// is the verdict on the last thing presented; and `local`, a refusal the
// validator made before the door was asked (a clock it cannot trust, a scan
// that was not a Bhada code). Nothing here decides whether a ride is valid.
//
// Pure: no hardware, no clock of its own. render.mjs draws the model.

import { clockProblem } from '../hw/clock.mjs';

// How long a verdict stays up before the door goes back to waiting. A boarding
// pass stays longer: the passenger's phone has to read it off this screen.
export const HOLD_MS = { in: 12000, out: 9000, invalid: 3500, held: 5000 };

// What a passenger may be told about a refusal. Short, and never anything that
// helps somebody forge the next attempt.
const REASONS = {
  unreadable: 'Not a Bhada ride code',
  bad_signature: 'Code not signed by that phone',
  wrong_vehicle: 'Code is for another bus',
  replay: 'Code already used — refresh it',
  stale: 'Code expired — refresh it',
  no_tap: 'Show the ride code on your phone',
  unknown_card: 'Card not issued — see the booth',
  unpaired: 'Validator not paired to this bus',
  expired: 'Pass expired',
  clock_untrusted: 'Validator clock not set',
};

export function reasonText(result) {
  return REASONS[result?.reason] ?? 'Refused';
}

function kmText(metres) {
  return `${(Math.max(0, metres) / 1000).toFixed(2)} km`;
}

function base(snap) {
  const bus = snap?.bus ?? null;
  return {
    vehicleId: snap?.vehicleId ?? '',
    doorId: snap?.doorId ?? '',
    role: snap?.role ?? 'both',
    aboard: bus && Number.isFinite(bus.onboard) ? `${bus.onboard}/${bus.capacity}` : null,
    odometer: bus && Number.isFinite(bus.odometerM) ? `${(bus.odometerM / 1000).toFixed(1)} km` : null,
    link: snap?.link ?? 'detached',
  };
}

/*
  One screen.

  `now` is the caller's clock, used only to time a verdict out. `online` is
  whether the last backend sync reached anybody; it never affects a verdict.
*/
export function screenFor({ snap, local = null, clock = { trusted: true }, online = false, validating = false, now = Date.now() }) {
  const common = { ...base(snap), online };

  if (!snap?.paired) {
    return { ...common, kind: 'unpaired', tone: 'fault', title: 'NOT PAIRED', lines: ['Show the meter’s pairing code', 'to the scanner'] };
  }
  if (!clock?.trusted) {
    return { ...common, kind: 'clock', tone: 'fault', title: 'CLOCK NOT SET', lines: [clockProblem(clock?.reason), 'Ride codes cannot be checked'] };
  }
  if (snap.keyMismatch) {
    return { ...common, kind: 'fault', tone: 'fault', title: 'RE-PAIR', lines: ['Meter key changed', 'Scan the meter’s pairing code'] };
  }
  if (validating) {
    return { ...common, kind: 'validating', tone: 'busy', title: 'VALIDATING…', lines: [] };
  }

  // The newest of the door's verdict and the validator's own refusal.
  const doorLast = snap.last ?? null;
  const last = local && (!doorLast || local.at >= doorLast.at) ? local : doorLast;
  const age = last ? now - last.at : Infinity;

  if (last && last.reason === 'at_capacity' && age < HOLD_MS.held) {
    return {
      ...common,
      kind: 'held',
      tone: 'held',
      title: 'HELD',
      lines: [snap.bus ? `Bus full · ${snap.bus.onboard} of ${snap.bus.capacity}` : 'Bus full', 'Next bus please'],
    };
  }
  if (last && !last.ok && age < HOLD_MS.invalid) {
    return { ...common, kind: 'invalid', tone: 'bad', title: '✕ INVALID', lines: [reasonText(last)] };
  }
  if (last?.ok && last.action === 'in' && age < HOLD_MS.in) {
    return {
      ...common,
      kind: 'in',
      tone: 'good',
      title: '✓ VALID',
      subtitle: 'Boarded — nothing charged yet',
      lines: [`Ride ${last.legId}`, last.pass ? `From ${kmText(last.pass.boardOdoM)}` : ''].filter(Boolean),
      // The BO1 pass. On a bus where the doors cannot hear each other, this
      // copy on the passenger's phone is what lets them off again.
      qr: last.passQr ?? null,
      qrLabel: 'Scan to keep your pass',
    };
  }
  if (last?.ok && last.action === 'out' && age < HOLD_MS.out) {
    const leg = last.leg ?? {};
    return {
      ...common,
      kind: 'out',
      tone: 'good',
      title: '✓ VALID',
      subtitle: 'Ride closed',
      fare: `Rs ${last.price?.amount ?? leg.amount ?? 0}`,
      lines: [kmText(leg.distanceM ?? 0), leg.estimated ? 'estimated' : `by ${leg.distanceSource ?? 'odometer'}`],
      // The BM1 receipt, for the passenger's app to check against its own
      // odometer.
      qr: last.receipt ?? null,
      qrLabel: 'Scan for your receipt',
    };
  }

  // Waiting. A full bus shows at the boarding door before anybody taps, and
  // says the exit is open — the rule, not a courtesy.
  const full = snap.bus?.atCapacity && common.role !== 'alighting';
  return {
    ...common,
    kind: full ? 'held-idle' : 'idle',
    tone: 'idle',
    title: 'भाडा BHADA',
    lines: full ? ['BUS FULL', 'Getting off? Scan as usual'] : ['SCAN QR OR TAP CARD'],
    offline: !online,
  };
}
