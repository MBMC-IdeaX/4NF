// The browser's positioning helpers, on a Pi.
//
// The pure parts of src/device/positioning.js — turning a position into a fix,
// the trace recorder — are the right ones here too and are passed straight
// through. The parts that ask a browser for something are replaced: a Pi has no
// screen to keep awake and no Battery Status API. Vehicle power is watched by
// validator/hw/power.mjs, which feeds the same assessPower() the meter uses.

export { fixFromPosition, TRACE_VERSION, createRecorder } from '../../src/device/positioning.js';

export function holdScreenOn() {
  return () => {};
}

// No battery to read. The meter's power watcher reports "not supported", which
// is exactly what assessPower() treats as "say nothing".
export function watchPower(onChange = () => {}) {
  onChange({ supported: false, charging: null, level: null });
  return () => {};
}

export function downloadText() {
  throw new Error('Nothing to download to on a validator.');
}
