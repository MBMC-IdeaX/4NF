// Where the distance comes from.
//
// A bus already has an odometer. When it can be read — off the meter box's
// heartbeat, off the instrument cluster, off a fleet tracker — the door should
// use that number rather than bolt a second GPS to the dashboard and argue with
// it. This file is the seam: every source is a `getVehicleOdometer()` that
// answers with a reading or with null, and nothing downstream knows which kind
// it is talking to.
//
//   reading = { metres, at, unitId, source }
//
// `unitId` matters more than it looks. terminal.js only subtracts two readings
// that came off the same unit (a pass stamped with one odometer and closed
// against another is priced from its endpoints instead), so every source names
// itself, and two doors on one bus reading the same odometer name it the same.
//
// No vehicle protocol is assumed. The adapters here are the meter heartbeat
// (which exists, protocol/frame.mjs), a manual one for tests, and a simulated
// drive for the bench. A CAN or J1939 reader is a new adapter with this shape
// once the actual bus and its documentation are in hand.

// How old a reading may be and still count. The door's own rule for a meter
// that has gone quiet is five seconds (terminal.js odometerSource()); this is
// the same number so the two never disagree about whether the bus is talking.
export const ODOMETER_FRESH_MS = 5000;

export function fresh(reading, now = Date.now()) {
  return Boolean(reading) && Number.isFinite(reading.metres) && now - reading.at <= ODOMETER_FRESH_MS;
}

// Set by hand. The proof uses it; so can a bench with a knob.
export function createManualOdometer({ unitId = 'ODO-MANUAL', metres = 0, now = () => Date.now() } = {}) {
  let reading = { metres, at: now(), unitId, source: 'manual' };
  return {
    getVehicleOdometer: async () => reading,
    set(next) {
      reading = { metres: Math.round(next), at: now(), unitId, source: 'manual' };
    },
    stale() {
      reading = { ...reading, at: 0 };
    },
  };
}

// A bus crawling through Kathmandu, for the bench: moves, stops, moves.
export function createSimulatedOdometer({ unitId = 'ODO-SIM', startMetres = 0, speedMps = 5, now = () => Date.now() } = {}) {
  const startedAt = now();
  return {
    getVehicleOdometer: async () => {
      const at = now();
      const elapsed = (at - startedAt) / 1000;
      // Forty seconds of driving, twenty stopped, around and around.
      const cycles = Math.floor(elapsed / 60);
      const inCycle = elapsed - cycles * 60;
      const moving = Math.min(inCycle, 40);
      return { metres: Math.round(startMetres + speedMps * (cycles * 40 + moving)), at, unitId, source: 'simulated' };
    },
  };
}

// The meter box's own odometer, as it arrives on the heartbeat. Fed by
// vehicle.mjs from the RS-485 line.
export function createFrameOdometer({ unitId = 'METER' } = {}) {
  let reading = null;
  return {
    getVehicleOdometer: async () => reading,
    onFrame(frame, at = Date.now()) {
      reading = { metres: frame.odometerMetres, at, unitId, source: 'meter' };
    },
  };
}
