// The QR scanner: a GM65, GM805 or anything else that reads phone screens and
// writes what it read to a serial line.
//
// Set up once with the vendor's configuration codes: serial output (TTL-232 on
// the UART, or USB virtual COM), 9600 8N1, CR suffix, continuous or induction
// mode, and "read codes on screens" on. The adapter copes with LF, CRLF or no
// terminator at all, so a scanner reset to factory settings still works.
//
// It only ever hands on text that has the shape of a Bhada code, once per
// presentation. Whether the code is any good is decided by the door.

import { createScanAssembler, createRepeatFilter, screenCode } from '../../src/lib/scan-input.js';

export function createScanner({ port, onCode, onReject, repeatWindowMs = 3000, now = () => Date.now(), setTimer, clearTimer } = {}) {
  const freshCode = createRepeatFilter({ windowMs: repeatWindowMs, now });
  const counts = { reads: 0, passed: 0, rejected: 0, repeats: 0 };

  const assembler = createScanAssembler({
    setTimer,
    clearTimer,
    onScan(raw) {
      counts.reads += 1;
      const screened = screenCode(raw);
      if (!screened.ok) {
        if (screened.reason === 'empty') return;
        counts.rejected += 1;
        onReject?.(screened, raw);
        return;
      }
      if (!freshCode(screened.code)) {
        counts.repeats += 1;
        return;
      }
      counts.passed += 1;
      onCode?.(screened.code);
    },
  });

  const stop = port ? port.onData((bytes) => assembler.push(bytes)) : () => {};
  return {
    push: (chunk) => assembler.push(chunk),
    flush: () => assembler.flush(),
    counts: () => ({ ...counts }),
    stop,
  };
}
