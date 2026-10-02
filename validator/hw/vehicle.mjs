// What the door hears from the bus, once a second.
//
// Two inputs, one output. The meter box's heartbeat over RS-485 carries the
// odometer, the count aboard, the capacity and the at-capacity flag. A bus
// with no meter box still has an odometer, and that alone is enough for the
// door to price rides by distance. Either way the door gets one `state`
// message a second, shaped like the ones a phone meter sends, and terminal.js
// does the rest.
//
// When the meter speaks, it wins: it is the unit whose count drives the
// interlock, and its odometer is the one both doors must measure against.

import { FLAG } from '../../protocol/frame.mjs';
import { fresh, ODOMETER_FRESH_MS } from './odometer.mjs';

export function createVehicleSource({ odometer = null, meterUnitId = 'METER', now = () => Date.now(), tickMs = 1000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const subscribers = new Set();
  let lastFrame = null;
  let lastFrameAt = 0;
  let timer = null;
  let counter = 0;

  const meterHeard = () => lastFrame !== null && now() - lastFrameAt <= ODOMETER_FRESH_MS;

  function emit(message) {
    for (const fn of subscribers) fn(message);
  }

  function id() {
    counter += 1;
    return `V${now().toString(36)}${counter.toString(36)}`;
  }

  // One heartbeat from the meter box, already decoded and CRC-checked.
  function onFrame(frame) {
    lastFrame = frame;
    lastFrameAt = now();
    const atCapacity = Boolean(frame.flags & FLAG.AT_CAPACITY);
    emit({
      id: id(),
      kind: 'state',
      at: lastFrameAt,
      unitId: meterUnitId,
      odometerM: frame.odometerMetres,
      onboard: frame.occupancy,
      capacity: frame.capacity,
      atCapacity,
      accrued: frame.accrued,
      openLegs: frame.openLegs,
      moving: Boolean(frame.flags & FLAG.MOVING),
      override: Boolean(frame.flags & FLAG.OVERRIDE),
      tamper: Boolean(frame.flags & FLAG.TAMPER),
      meterTime: frame.unixSeconds,
      doors: {
        A: frame.flags & FLAG.BOARDING_DOOR_OPEN ? 'open' : 'closed',
        B: frame.flags & FLAG.ALIGHTING_DOOR_OPEN ? 'open' : 'closed',
      },
      via: 'rs485',
    });
  }

  // No meter box: the vehicle odometer on its own. No count, no capacity — the
  // door says it does not know rather than guessing (terminal.js busState).
  async function tick() {
    if (meterHeard() || !odometer) return;
    let reading = null;
    try {
      reading = await odometer.getVehicleOdometer();
    } catch {
      reading = null;
    }
    if (!fresh(reading, now())) return;
    emit({
      id: id(),
      kind: 'state',
      at: reading.at,
      unitId: reading.unitId,
      odometerM: reading.metres,
      atCapacity: false,
      via: reading.source,
    });
  }

  return {
    onFrame,
    tick,
    meterHeard,
    meterUnitId: () => meterUnitId,
    lastFrame: () => lastFrame,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    start() {
      if (!timer) timer = setTimer(() => { tick().catch(() => {}); }, tickMs);
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
