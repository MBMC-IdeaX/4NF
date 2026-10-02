// Turning a hardware scanner's output into codes.
//
// A dedicated 2D scanner (GM65, GM805 and their kind) reads a phone screen in a
// fifth of a second where a phone camera takes one and a half to six, and at a
// seventy-centimetre door with twenty-five people behind it that is the whole
// difference. It hands over what it read in one of two ways: typed, as a USB
// keyboard, into whatever has focus; or as bytes on a serial line. Either way the
// output is a run of characters and a terminator, and nothing else about it can
// be trusted — a scanner will read a bus timetable, a Wi-Fi sticker or half of a
// code that slid out of view as happily as a ride code.
//
// So this file does exactly two things. It finds where one scan ends, and it
// throws away anything that is plainly not a Bhada code before it reaches a door.
// It never decides that a code is good: a string that has the right shape is
// handed to verifyTap() or verifyPass(), which check the signature, the vehicle,
// the nonce and the clock. Shape is a filter, not a verdict.
//
// Platform-free on purpose: the phone door uses it for a USB scanner on OTG, and
// the Pi validator uses the same code for the UART.

// The codes a door acts on. Anything else a scanner hands over is dropped here.
// BG1 is a family's codes in one QR (protocol/leg.mjs, buildGroup).
export const DOOR_CODE_PREFIXES = ['BT1|', 'BO1|', 'BG1~'];

// Longest code a door will look at. A BO1 pass is under 300 characters; this
// leaves room for longer vehicle ids without letting a scanner that has been
// pointed at a dense document fill memory.
export const MAX_CODE_LENGTH = 1200;

// Signed codes are base64url, decimal and '|' separated. Nothing else belongs.
const CODE_CHARS = /^[A-Za-z0-9_\-|.:~]+$/;

/*
  Is this worth handing to the verifier?

  Returns the trimmed code, or null with a reason. `unreadable` is also what
  verifyTap() says about a mangled code, so a door refusing here and a door
  refusing after verification show the passenger the same thing.
*/
export function screenCode(raw) {
  const text = String(raw ?? '').replace(/[\r\n\t]+/g, '').trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_CODE_LENGTH) return { ok: false, reason: 'unreadable', detail: 'too long' };
  if (!DOOR_CODE_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return { ok: false, reason: 'unreadable', detail: 'not a Bhada ride code' };
  }
  if (!CODE_CHARS.test(text)) return { ok: false, reason: 'unreadable', detail: 'characters a signed code never has' };
  return { ok: true, code: text };
}

/*
  Where one scan ends.

  A scanner ends a read with CR, LF or both, depending on how it was set up.
  Some are set up with no terminator at all, and then the only end is silence:
  a GM65 sends a whole code in well under 50 ms at 9600 baud, so a gap longer
  than `idleMs` closes the scan. Both rules are on at once, because a scanner
  that was reconfigured in the depot should not stop a door working.

  `onScan(text)` gets each complete read exactly as it arrived, before any
  screening, so the caller can count what the scanner saw as well as what it
  let through.
*/
export function createScanAssembler({ onScan, idleMs = 80, maxLength = MAX_CODE_LENGTH * 2, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let buffer = '';
  let timer = null;

  function flush() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const text = buffer;
    buffer = '';
    if (text.trim().length > 0) onScan?.(text);
  }

  function push(chunk) {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        flush();
        continue;
      }
      buffer += ch;
      // A line that never ends is a scanner in a mode nobody asked for. Drop it
      // rather than let it grow.
      if (buffer.length > maxLength) buffer = '';
    }
    if (timer !== null) clearTimer(timer);
    timer = buffer.length > 0 ? setTimer(flush, idleMs) : null;
  }

  return { push, flush, pending: () => buffer };
}

/*
  One code, once.

  A scanner in continuous mode reads the same screen five times a second for as
  long as the passenger holds it up. The first read boards them and spends the
  nonce; the second would be refused as a replay and flash red at somebody who
  did nothing wrong. So an identical string inside `windowMs` is swallowed here.

  This is courtesy, not security. The nonce check in verifyTap() is what stops a
  code being used twice, and it still runs on every read that gets through —
  the same code held up again after the window is refused as `replay`, exactly
  as it should be.
*/
export function createRepeatFilter({ windowMs = 3000, now = () => Date.now() } = {}) {
  let last = null;
  let lastAt = 0;
  return function fresh(code) {
    const at = now();
    if (code === last && at - lastAt < windowMs) {
      lastAt = at;
      return false;
    }
    last = code;
    lastAt = at;
    return true;
  };
}

/*
  A USB scanner on a phone, typing.

  In keyboard mode a scanner is indistinguishable from a person typing, except
  that it types a whole code in a few milliseconds per key and a person does
  not. `maxGapMs` is the line: keys further apart than that start a fresh
  buffer, so a crew member typing on a Bluetooth keyboard never triggers a scan
  by accident. Keys aimed at a text field are left alone entirely.

  Returns a keydown handler. The caller attaches it to the window.
*/
export function createKeyboardWedge({ onScan, maxGapMs = 60, minLength = 16, now = () => Date.now() } = {}) {
  let buffer = '';
  let lastAt = 0;
  return function onKeyDown(event) {
    const target = event.target;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const at = now();
    if (at - lastAt > maxGapMs) buffer = '';
    lastAt = at;

    if (event.key === 'Enter' || event.key === 'Tab') {
      const text = buffer;
      buffer = '';
      if (text.length >= minLength) {
        event.preventDefault?.();
        onScan?.(text);
      }
      return;
    }
    if (typeof event.key === 'string' && event.key.length === 1) {
      buffer += event.key;
      if (buffer.length > MAX_CODE_LENGTH * 2) buffer = '';
    }
  };
}
