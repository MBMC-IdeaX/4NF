// Web NFC, on a PN532.
//
// Stands in for src/device/nfc.js. The door calls readNfc() once at boot and
// expects onCard(serial) for every card held to it — the same call a phone makes
// from Chrome's NDEFReader. Here the serial comes from whatever card reader
// main.mjs attached (validator/hw/pn532.mjs on the bus, a fake in the proof).
//
// The serial is formatted exactly as Chrome formats it, colon-separated hex,
// then upper-cased as nfc.js does, so a card enrolled at a phone door is the
// same card at a Pi door. That mapping is the only card semantics there are: a
// rider card is a serial that the door maps to a key it holds for the rider
// (terminal.js, enrol()). A card is never an identity on its own and an unknown
// serial is refused, not enrolled.
//
// Phones are not read here. A PN532 can only read a phone that runs a native
// card-emulation app, and iPhones mostly cannot do that at all; passengers with
// phones show their BT1 to the QR scanner.

let reader = null;
const listeners = new Set();

export function formatSerial(uidBytes) {
  return Array.from(uidBytes, (byte) => byte.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

// Called by main.mjs with anything that has onCard(fn) → unsubscribe.
export function attachCardReader(next) {
  reader = next;
  for (const entry of listeners) entry.stop = reader.onCard(entry.onCard);
}

export function nfcSupported() {
  return reader !== null;
}

export function readNfc({ onCard, onError } = {}) {
  const entry = {
    onCard: (uid) => {
      try {
        onCard?.(typeof uid === 'string' ? uid.toUpperCase() : formatSerial(uid));
      } catch (error) {
        onError?.(error);
      }
    },
    stop: () => {},
  };
  listeners.add(entry);
  if (reader) entry.stop = reader.onCard(entry.onCard);
  return () => {
    entry.stop?.();
    listeners.delete(entry);
  };
}

export async function writeNfc() {
  throw new Error('This validator reads rider cards; it does not write tags.');
}
