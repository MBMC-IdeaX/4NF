// The vehicle bus, on a Pi.
//
// Stands in for src/device/link.js. On a phone the door hears the meter over a
// BroadcastChannel or Supabase Realtime; on the bus it hears it over RS-485, as
// the 32-byte heartbeat in protocol/frame.mjs, or — on a bus with no meter box —
// hears only the vehicle's own odometer. Both reach the door the same way a
// phone meter's messages do: as `state` messages with the odometer, the count
// aboard and whether the bus is at capacity. terminal.js already knows what to
// do with those, so it is not changed.
//
// What this does not carry yet is the other direction. A phone door tells the
// meter `boarded` and `alighted`, and that is how the meter counts heads for the
// interlock; the heartbeat has no field for it and there is no agreed uplink on
// the wire. Those messages are handed to `onSend` listeners (the bench logs
// them) and the link says `local`, never more, so nothing pretends the meter
// heard a door it did not. See validator/README.md, "Door to meter".

import { LINK } from '../../src/device/link.js';

export { LINK };

let source = null;
const sendListeners = new Set();

// main.mjs attaches the vehicle source (validator/hw/vehicle.mjs) before the
// door boots. Anything with subscribe(fn) → unsubscribe and state() will do.
export function attachVehicleSource(next) {
  source = next;
}

export function onSend(fn) {
  sendListeners.add(fn);
  return () => sendListeners.delete(fn);
}

let counter = 0;
function messageId() {
  counter = (counter + 1) % 1e9;
  return `P${Date.now().toString(36)}${counter.toString(36)}`;
}

export function openLink(vehicleId, onMessage, { unitId = null } = {}) {
  let closed = false;
  const stop = source ? source.subscribe((message) => {
    if (!closed) onMessage?.(message);
  }) : () => {};

  return {
    send(kind, body = {}) {
      const message = { id: messageId(), kind, at: Date.now(), unitId, vehicleId, ...body };
      for (const fn of sendListeners) {
        try { fn(message); } catch { /* a listener failing must not fail a tap */ }
      }
      return message;
    },
    // `local` while a meter box is being heard over RS-485, otherwise the door
    // is on its own. A vehicle odometer alone is not another unit.
    state: () => (source?.meterHeard?.() ? LINK.LOCAL : LINK.DETACHED),
    peers: () => (source?.meterHeard?.() ? [source.meterUnitId?.() ?? 'meter'] : []),
    close() {
      closed = true;
      stop();
    },
  };
}
