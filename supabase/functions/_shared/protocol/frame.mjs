// The heartbeat the box puts on the wire: 32 bytes, once a second.
//
// A bus in Nepal is not on wifi. It is on a 2G GPRS SIM that costs by the
// kilobyte and drops under every underpass, or — where the operator has paid
// for it — a LoRa gateway with a duty cycle measured in seconds per hour. JSON
// telemetry at one hertz is roughly 200 bytes a tick; this is 32, fixed layout,
// no field names on the wire, and it fits inside a single LoRa SF9 payload.
//
// Fixed-width and self-checking on purpose. A control centre that receives half
// a frame must be able to tell, and a frame that survives a bad radio must
// decode to exactly what was sent or not decode at all.
//
//   offset  size  field
//   0       u8    version
//   1       u8    flags
//   2       u16   occupancy
//   4       u16   capacity
//   6       u32   odometer, metres
//   10      i32   latitude, microdegrees
//   14      i32   longitude, microdegrees
//   18      u16   speed, cm/s
//   20      u32   unix seconds
//   24      u16   open legs
//   26      u16   accrued fare, whole currency units
//   28      u32   CRC-32 of bytes 0..27

import { toBase64url, fromBase64url } from './base64url.mjs';

export const FRAME_VERSION = 1;
export const FRAME_BYTES = 32;

export const FLAG = {
  BOARDING_DOOR_OPEN: 1 << 0,
  ALIGHTING_DOOR_OPEN: 1 << 1,
  MOVING: 1 << 2,
  FIX_VALID: 1 << 3,
  AT_CAPACITY: 1 << 4,
  OVERRIDE: 1 << 5,
  OFFLINE_QUEUE: 1 << 6, // the box has unsent legs. the reason to keep listening
  TAMPER: 1 << 7,        // enclosure opened or odometer input lost
};

// CRC-32 (IEEE 802.3), table generated once. The same polynomial an ESP32's
// hardware unit uses, so the firmware and this agree without a port.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, length = bytes.length) {
  let crc = 0xffffffff;
  for (let i = 0; i < length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function clampU(value, max) {
  const n = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(max, n));
}

export function encodeFrame({
  flags = 0,
  occupancy = 0,
  capacity = 0,
  odometerMetres = 0,
  latMicro = 0,
  lonMicro = 0,
  speedCmS = 0,
  unixSeconds = 0,
  openLegs = 0,
  accrued = 0,
}) {
  const bytes = new Uint8Array(FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, clampU(flags, 0xff));
  view.setUint16(2, clampU(occupancy, 0xffff));
  view.setUint16(4, clampU(capacity, 0xffff));
  view.setUint32(6, clampU(odometerMetres, 0xffffffff));
  view.setInt32(10, Math.round(latMicro) | 0);
  view.setInt32(14, Math.round(lonMicro) | 0);
  view.setUint16(18, clampU(speedCmS, 0xffff));
  view.setUint32(20, clampU(unixSeconds, 0xffffffff));
  view.setUint16(24, clampU(openLegs, 0xffff));
  view.setUint16(26, clampU(accrued, 0xffff));
  view.setUint32(28, crc32(bytes, 28));
  return bytes;
}

export function decodeFrame(bytes) {
  if (!bytes || bytes.length !== FRAME_BYTES) throw new Error(`frame must be ${FRAME_BYTES} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stated = view.getUint32(28);
  const actual = crc32(bytes, 28);
  if (stated !== actual) throw new Error('frame failed CRC — radio corrupted it');
  const version = view.getUint8(0);
  if (version !== FRAME_VERSION) throw new Error(`unknown frame version ${version}`);
  const flags = view.getUint8(1);
  return {
    version,
    flags,
    occupancy: view.getUint16(2),
    capacity: view.getUint16(4),
    odometerMetres: view.getUint32(6),
    latMicro: view.getInt32(10),
    lonMicro: view.getInt32(14),
    speedCmS: view.getUint16(18),
    unixSeconds: view.getUint32(20),
    openLegs: view.getUint16(24),
    accrued: view.getUint16(26),
    flagNames: Object.entries(FLAG).filter(([, bit]) => flags & bit).map(([name]) => name),
  };
}

export function frameToBase64url(bytes) {
  return toBase64url(bytes);
}

export function frameFromBase64url(text) {
  return decodeFrame(fromBase64url(text));
}

// What the console prints. Hex because that is what anyone debugging a radio
// link is already looking at on the other end.
export function frameToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
    if (i % 4 === 3 && i !== bytes.length - 1) out += ' ';
  }
  return out;
}
