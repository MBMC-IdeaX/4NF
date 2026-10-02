// The meter's heartbeat, off an RS-485 line.
//
// protocol/frame.mjs is the frame: 32 bytes, version first, CRC-32 last, once a
// second. It was written for a radio, where a packet arrives whole or not at
// all. A serial line has no packets — it is a stream, and a door that powers up
// half way through a frame starts reading in the middle of one. The frame has
// no sync word and this does not add one: it slides a 32-byte window along the
// stream until the version byte and the CRC agree, which a random 32 bytes do
// about once in four billion tries. Once in step it stays in step, and a byte
// lost on the wire costs one frame, not the line.
//
// Nothing about the frame is changed here. decodeFrame() is the only parser.

import { encodeFrame, decodeFrame, FRAME_BYTES, FRAME_VERSION, crc32 } from '../../protocol/frame.mjs';

export function createFrameSync({ onFrame, onError } = {}) {
  let buffer = new Uint8Array(0);
  let skipped = 0;

  function aligned(at) {
    if (buffer[at] !== FRAME_VERSION) return false;
    const view = new DataView(buffer.buffer, buffer.byteOffset + at, FRAME_BYTES);
    return view.getUint32(28) === crc32(buffer.subarray(at, at + FRAME_BYTES), 28);
  }

  function push(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const joined = new Uint8Array(buffer.length + bytes.length);
    joined.set(buffer, 0);
    joined.set(bytes, buffer.length);
    buffer = joined;

    let at = 0;
    while (buffer.length - at >= FRAME_BYTES) {
      if (!aligned(at)) {
        at += 1;
        skipped += 1;
        continue;
      }
      const frame = buffer.slice(at, at + FRAME_BYTES);
      at += FRAME_BYTES;
      try {
        onFrame?.(decodeFrame(frame), frame);
      } catch (error) {
        onError?.(error);
      }
    }
    buffer = buffer.slice(at);
  }

  return { push, skipped: () => skipped, pending: () => buffer.length };
}

// The meter side, for the bench and for the proof. A real meter box writes the
// same bytes from its own firmware.
export function heartbeat(fields) {
  return encodeFrame(fields);
}
