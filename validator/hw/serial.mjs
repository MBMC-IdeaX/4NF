// A serial line, with nothing but Node.
//
// The scanner, the PN532 and the RS-485 adapter are all serial devices: the
// Pi's own UART (/dev/serial0), a USB-serial dongle (/dev/ttyUSB0) or a device
// that enumerates as USB CDC (/dev/ttyACM0, which is how a GM65 appears in its
// USB virtual-COM mode). `stty` sets the speed and raw mode once, then the
// device is an ordinary file descriptor. No native module means nothing to
// rebuild when the Pi's Node is upgraded.

import { openSync, writeSync, closeSync, createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import tty from 'node:tty';

export function openSerial(device, { baud = 9600 } = {}) {
  const configured = spawnSync('stty', ['-F', device, String(baud), 'raw', '-echo', '-echoe', '-echok', '-ixon', '-ixoff', '-crtscts', 'cs8', '-cstopb', '-parenb', 'clocal'], { encoding: 'utf8' });
  if (configured.status !== 0) {
    throw new Error(`Could not configure ${device}: ${(configured.stderr || configured.error?.message || '').trim()}`);
  }
  const fd = openSync(device, 'r+');
  // A tty stream uses libuv's non-blocking tty handle; a file stream would hold
  // one of the four threadpool threads for as long as the line is open.
  const stream = tty.isatty(fd) ? new tty.ReadStream(fd) : createReadStream(null, { fd, autoClose: false });
  const listeners = new Set();
  stream.on('data', (chunk) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const fn of listeners) fn(bytes);
  });
  return {
    device,
    write(bytes) {
      writeSync(fd, bytes);
    },
    onData(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      stream.destroy();
      try { closeSync(fd); } catch { /* already closed by the stream */ }
    },
  };
}
