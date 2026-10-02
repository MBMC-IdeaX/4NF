// A PN532 on the Pi's UART, reading rider-card serials.
//
// The PN532 speaks the same framing on UART (HSU), I2C and SPI; UART is used
// here because Node can drive it with nothing but a file descriptor, where I2C
// and SPI need ioctl calls Node does not have without a native module. Set the
// board's mode switches to HSU (both off on the common red and blue boards).
//
// Only one thing is asked of the chip: is there an ISO 14443A card in the field,
// and what is its serial? That is InListPassiveTarget. The serial goes to the
// door exactly as a phone's Web NFC would report it, and the door maps it to a
// rider card it has enrolled — or refuses it.
//
// Frame (PN532 User Manual §6.2.1):
//   00 00 FF LEN LCS TFI PD0..PDn DCS 00
//   LEN = bytes in TFI + data, LCS = -LEN, DCS = -(TFI + data), all mod 256
//   TFI = D4 host → PN532, D5 PN532 → host. ACK is 00 00 FF 00 FF 00.

export const ACK = Uint8Array.from([0x00, 0x00, 0xff, 0x00, 0xff, 0x00]);
// A PN532 asleep on HSU needs a long run of 0x55 before it will listen (§7.2.11).
export const WAKEUP = Uint8Array.from([0x55, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

export const CMD = {
  GET_FIRMWARE_VERSION: 0x02,
  SAM_CONFIGURATION: 0x14,
  IN_LIST_PASSIVE_TARGET: 0x4a,
  IN_RELEASE: 0x52,
};

export function buildFrame(command, params = []) {
  const data = [0xd4, command, ...params];
  const len = data.length;
  const sum = data.reduce((a, b) => a + b, 0);
  return Uint8Array.from([0x00, 0x00, 0xff, len, (0x100 - len) & 0xff, ...data, (0x100 - (sum & 0xff)) & 0xff, 0x00]);
}

/*
  Pull every complete ACK and response frame out of a byte buffer.

  Returns what it found and what is left over, so a caller can keep appending
  serial chunks and calling this again. A frame with a bad length or data
  checksum is dropped whole: the chip will be asked again on the next poll, and
  a card read off a corrupted frame is a card read wrong.
*/
export function parseFrames(buffer) {
  const frames = [];
  let at = 0;
  while (at + 6 <= buffer.length) {
    if (!(buffer[at] === 0x00 && buffer[at + 1] === 0x00 && buffer[at + 2] === 0xff)) {
      at += 1;
      continue;
    }
    const len = buffer[at + 3];
    const lcs = buffer[at + 4];
    if (len === 0x00 && lcs === 0xff) {
      frames.push({ ack: true });
      at += 6;
      continue;
    }
    if (len === 0xff && lcs === 0x00) {
      frames.push({ nack: true });
      at += 6;
      continue;
    }
    if (((len + lcs) & 0xff) !== 0) {
      at += 1;
      continue;
    }
    const end = at + 5 + len + 2;
    if (end > buffer.length) break;
    const data = buffer.subarray(at + 5, at + 5 + len);
    const dcs = buffer[at + 5 + len];
    const sum = data.reduce((a, b) => a + b, 0);
    if (((sum + dcs) & 0xff) === 0 && data[0] === 0xd5) {
      frames.push({ response: data[1], data: Uint8Array.from(data.subarray(2)) });
    }
    at = end;
  }
  return { frames, rest: Uint8Array.from(buffer.subarray(at)) };
}

// InListPassiveTarget's answer, for one ISO 14443A target (§7.3.5):
//   NbTg, then per target: Tg, SENS_RES(2), SEL_RES(1), NFCIDLength, NFCID...
export function parseTargets(data) {
  if (!data || data.length < 1 || data[0] === 0) return [];
  const count = data[0];
  const targets = [];
  let at = 1;
  for (let i = 0; i < count && at + 5 <= data.length; i += 1) {
    const idLength = data[at + 4];
    const uid = data.subarray(at + 5, at + 5 + idLength);
    if (uid.length !== idLength) break;
    targets.push({ target: data[at], sensRes: (data[at + 1] << 8) | data[at + 2], selRes: data[at + 3], uid: Uint8Array.from(uid) });
    at += 5 + idLength;
    // ATS follows for ISO 14443-4 cards; its length byte includes itself.
    if (data[at] && (targets.at(-1).selRes & 0x20)) at += data[at];
  }
  return targets;
}

/*
  The reader, polling.

  `port` is { write(bytes), onData(fn) → stop } — a serial line on the bus, a
  fake in the proof. A card held to the reader is reported once; the same card
  is reported again only after it has been taken away (a poll that finds no
  card), so a rider resting a card on the reader does not tap in and out.
*/
export function createPn532({ port, pollMs = 150, responseMs = 400, setTimer = setTimeout, clearTimer = clearTimeout, onError } = {}) {
  let buffer = new Uint8Array(0);
  let waiting = null;
  let running = false;
  let present = null;
  const listeners = new Set();

  const stopData = port.onData((chunk) => {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    const { frames, rest } = parseFrames(joined);
    buffer = rest;
    for (const frame of frames) {
      if (frame.response !== undefined && waiting && frame.response === waiting.command + 1) {
        const done = waiting;
        waiting = null;
        clearTimer(done.timer);
        done.resolve(frame.data);
      }
    }
  });

  function command(code, params = []) {
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        waiting = null;
        // Abort whatever the chip is still waiting on, so the next command is
        // heard (§6.2.1.3: an ACK from the host cancels).
        port.write(ACK);
        reject(Object.assign(new Error('PN532 did not answer'), { code: 'TIMEOUT' }));
      }, responseMs);
      waiting = { command: code, resolve, timer };
      port.write(buildFrame(code, params));
    });
  }

  async function init() {
    port.write(WAKEUP);
    // Normal mode, no virtual card, IRQ on — the configuration every PN532
    // library sends first.
    await command(CMD.SAM_CONFIGURATION, [0x01, 0x14, 0x01]);
    const version = await command(CMD.GET_FIRMWARE_VERSION);
    return { ic: version[0], version: version[1], revision: version[2], support: version[3] };
  }

  async function pollOnce() {
    let targets = [];
    try {
      // One target, 106 kbps type A: every NTAG and MIFARE rider card.
      targets = parseTargets(await command(CMD.IN_LIST_PASSIVE_TARGET, [0x01, 0x00]));
    } catch (error) {
      if (error.code !== 'TIMEOUT') throw error;
    }
    const uid = targets[0]?.uid ?? null;
    const key = uid ? Array.from(uid).join(',') : null;
    if (key && key !== present) {
      for (const fn of listeners) fn(uid);
    }
    present = key;
    return uid;
  }

  async function loop() {
    while (running) {
      try {
        await pollOnce();
      } catch (error) {
        onError?.(error);
      }
      await new Promise((resolve) => setTimer(resolve, pollMs));
    }
  }

  return {
    init,
    pollOnce,
    start() {
      if (running) return;
      running = true;
      loop();
    },
    stop() {
      running = false;
      stopData?.();
    },
    onCard(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// The door's name for readNfcCard(): one card, or null if none is held there.
export async function readNfcCard(reader) {
  return reader.pollOnce();
}
