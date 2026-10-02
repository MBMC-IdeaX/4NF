// The RGB LED and the buzzer, and the simulated door.
//
// The prototype never touches a door actuator. What it shows is the decision:
// a colour, a sound, and a line on the console saying what a door would have
// done. That is enough to demonstrate the interlock and it cannot trap anybody's
// hand. The rule that the exit is never held is the door's (terminal.js never
// refuses an alighting passenger for capacity); this file only reports it.
//
// Pins are driven with `pinctrl`, which ships with Raspberry Pi OS Bookworm and
// needs no daemon. Spawning it costs a few milliseconds, which is nothing next
// to a 90 ms beep.

import { spawn } from 'node:child_process';

// BCM numbering. Chosen to stay clear of UART (14/15), I2C (2/3) and SPI0
// (7–11) used by the scanner, the PN532, the DS3231 and the display, and of the
// display's DC and reset lines (24/25).
export const PINS = { red: 5, green: 6, blue: 13, buzzer: 12, feedSense: 26 };

export function createPinctrl({ run = (args) => spawn('pinctrl', args, { stdio: 'ignore' }).on('error', () => {}) } = {}) {
  return {
    write(pin, on) { run(['set', String(pin), 'op', on ? 'dh' : 'dl']); },
    input(pin) { run(['set', String(pin), 'ip', 'pd']); },
  };
}

// For a laptop or a test: remembers every write.
export function createRecordingGpio() {
  const writes = [];
  return { writes, write(pin, on) { writes.push({ pin, on }); }, input() {} };
}

const COLOURS = {
  off: [0, 0, 0],
  green: [0, 1, 0],
  red: [1, 0, 0],
  amber: [1, 1, 0],
  blue: [0, 0, 1],
};

// What each outcome looks and sounds like. Beeps are [on ms, off ms] pairs.
export const PATTERNS = {
  idle: { colour: 'off', beeps: [] },
  validating: { colour: 'blue', beeps: [] },
  in: { colour: 'green', beeps: [[90, 0]] },
  out: { colour: 'green', beeps: [[90, 70], [90, 0]] },
  invalid: { colour: 'red', beeps: [[60, 60], [60, 60], [60, 0]] },
  held: { colour: 'amber', beeps: [[450, 0]] },
  fault: { colour: 'red', beeps: [] },
};

export function createSignals({ gpio, pins = PINS, setTimer = setTimeout, clearTimer = clearTimeout, holdMs = 2500 } = {}) {
  let timers = [];
  function cancel() {
    for (const t of timers) clearTimer(t);
    timers = [];
  }
  function colour(name) {
    const [r, g, b] = COLOURS[name] ?? COLOURS.off;
    gpio.write(pins.red, r);
    gpio.write(pins.green, g);
    gpio.write(pins.blue, b);
  }
  return {
    show(kind) {
      const pattern = PATTERNS[kind] ?? PATTERNS.idle;
      cancel();
      gpio.write(pins.buzzer, 0);
      colour(pattern.colour);
      let at = 0;
      for (const [on, off] of pattern.beeps) {
        timers.push(setTimer(() => gpio.write(pins.buzzer, 1), at));
        timers.push(setTimer(() => gpio.write(pins.buzzer, 0), at + on));
        at += on + off;
      }
      // A verdict light goes out on its own; a fault stays lit.
      if (kind !== 'idle' && kind !== 'fault' && kind !== 'validating') {
        timers.push(setTimer(() => colour('off'), Math.max(holdMs, at)));
      }
    },
    off() {
      cancel();
      colour('off');
      gpio.write(pins.buzzer, 0);
    },
  };
}

/*
  The simulated door.

  Reports, for each verdict, what a real door controller would be told. At the
  boarding door a full bus holds the door; nothing ever holds the exit. It
  listens to decisions the door already made and does not make any of its own.
*/
export function doorActionFor(result, role) {
  if (!result) return null;
  if (result.reason === 'at_capacity') return { door: role, action: 'hold', why: 'bus at permitted capacity' };
  if (result.ok && (result.action === 'in' || result.action === 'out')) return { door: role, action: 'release', why: result.action === 'in' ? 'boarded' : 'alighted' };
  return { door: role, action: 'none', why: result.reason ?? 'refused' };
}
