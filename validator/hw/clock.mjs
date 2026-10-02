// Whether this door can tell the time.
//
// A BT1 ride code is good for TAP_MAX_AGE_S (300 s) either side of the door's
// clock, and settle_leg() applies the same 300 s at the backend. A door whose
// clock is ten minutes out refuses every honest passenger; one that is ten
// minutes behind accepts a screenshot the backend will later refuse, and that
// ride's fare is stranded. A Raspberry Pi has no clock of its own: it boots at
// whatever time it last wrote to disk and waits for a network that a bus in a
// Kathmandu underpass does not have.
//
// So the door does not take its own word for the time. A DS3231 on I2C keeps
// time with the power off (±2 ppm, about a minute a year), the kernel's
// rtc-ds1307 driver sets the system clock from it at boot, and before every
// decision the validator checks that the system clock and the RTC still agree.
// If there is no RTC, or the RTC says it lost time, or the two have drifted
// apart, the door says so and refuses to validate instead of guessing.
//
// A source is anything with status() → { trusted, seconds, reason }. The DS3231
// is the first; the meter's heartbeat carries unix seconds too, and a GNSS or
// vehicle clock is another source with the same shape. createClockGate() takes
// the first trusted one.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// How far the system clock may be from the reference before the door stops
// validating. Two seconds is far inside the 300 s window and far outside the
// one-second resolution both clocks have.
export const MAX_DRIFT_S = 2;

// Nothing this door signs can be from before it was built. A clock reading
// earlier than this is a clock that was never set.
export const EARLIEST_TRUSTED_S = Date.UTC(2026, 0, 1) / 1000;

function systemSeconds(now) {
  return Math.floor(now() / 1000);
}

function judge(name, seconds, now) {
  const system = systemSeconds(now);
  if (!Number.isFinite(seconds)) return { source: name, trusted: false, reason: 'unreadable', seconds: null, systemSeconds: system };
  if (seconds < EARLIEST_TRUSTED_S) return { source: name, trusted: false, reason: 'never_set', seconds, systemSeconds: system };
  const driftS = system - seconds;
  if (Math.abs(driftS) > MAX_DRIFT_S) return { source: name, trusted: false, reason: 'drift', seconds, systemSeconds: system, driftS };
  return { source: name, trusted: true, reason: null, seconds, systemSeconds: system, driftS };
}

/*
  The DS3231, through the kernel.

  `dtoverlay=i2c-rtc,ds3231` in config.txt binds it to rtc-ds1307, which puts it
  at /sys/class/rtc/rtc0. Reading `since_epoch` there is a register read of the
  chip. When the chip's oscillator-stop flag is set — its coin cell died, or it
  was never set — the driver refuses the read with EINVAL, which is exactly the
  "I do not know the time" this needs.
*/
export function createRtcClock({ sysfs = '/sys/class/rtc/rtc0', now = () => Date.now(), read = (file) => readFileSync(file, 'utf8') } = {}) {
  return {
    name: 'ds3231',
    status() {
      let seconds;
      try {
        seconds = Number(String(read(path.join(sysfs, 'since_epoch'))).trim());
      } catch (error) {
        const reason = error?.code === 'ENOENT' ? 'no_rtc' : error?.code === 'EINVAL' ? 'rtc_lost_time' : 'unreadable';
        return { source: 'ds3231', trusted: false, reason, seconds: null, systemSeconds: systemSeconds(now) };
      }
      return judge('ds3231', seconds, now);
    },
  };
}

// The meter box's clock, as carried on its heartbeat. Only as good as the
// meter's own time source, and only fresh for a few seconds.
export function createFrameClock({ now = () => Date.now(), freshMs = 5000 } = {}) {
  let last = null;
  return {
    name: 'meter',
    onFrame(frame, at = now()) {
      if (frame?.unixSeconds) last = { seconds: frame.unixSeconds, at };
    },
    status() {
      if (!last || now() - last.at > freshMs) return { source: 'meter', trusted: false, reason: 'no_meter_time', seconds: null, systemSeconds: systemSeconds(now) };
      const seconds = last.seconds + Math.floor((now() - last.at) / 1000);
      return judge('meter', seconds, now);
    },
  };
}

/*
  The network's clock, when there is one.

  When systemd-timesyncd has synchronised the system clock over NTP, the system
  clock is the best time on the bus and the RTC is the one that is behind until
  bhada-rtc-sync writes it back. Without this source the gate would see the two
  disagree and stop the door in exactly the minutes it came into signal.
*/
export function createNtpClock({ now = () => Date.now(), check, cacheMs = 30000 } = {}) {
  let cached = null;
  return {
    name: 'ntp',
    status() {
      if (!cached || now() - cached.at > cacheMs) {
        let synced = false;
        try {
          synced = String(check()).trim() === 'yes';
        } catch {
          synced = false;
        }
        cached = { synced, at: now() };
      }
      const system = systemSeconds(now);
      if (!cached.synced) return { source: 'ntp', trusted: false, reason: 'not_synchronised', seconds: null, systemSeconds: system };
      return judge('ntp', system, now);
    },
  };
}

// For a bench or a test: a clock that says whatever it is told.
export function createFixedClock({ trusted = true, reason = null } = {}) {
  let current = { trusted, reason };
  return {
    name: 'fixed',
    set(next) { current = { ...current, ...next }; },
    status: () => ({ source: 'fixed', seconds: null, systemSeconds: null, ...current }),
  };
}

export function createClockGate(sources) {
  return {
    status() {
      const results = sources.map((source) => source.status());
      const good = results.find((result) => result.trusted);
      if (good) return good;
      return results[0] ?? { trusted: false, reason: 'no_clock' };
    },
  };
}

// What the door shows when it will not validate, in words a conductor can act on.
export function clockProblem(reason) {
  switch (reason) {
    case 'no_rtc': return 'Clock module not found — check the DS3231';
    case 'rtc_lost_time': return 'Clock lost its time — replace the coin cell';
    case 'never_set': return 'Clock has never been set.';
    case 'drift': return 'System clock disagrees with the clock module';
    default: return 'Clock cannot be read.';
  }
}
