// Vehicle power, as the validator sees it.
//
// Two different things happen when a bus's power goes, and the tape must not
// confuse them.
//
// 1. The validator itself loses power. It has no battery, so it simply stops;
//    it cannot write anything about it. On the next boot it notices it was not
//    shut down cleanly and keeps a note in its own diagnostics. That note is
//    not `power_lost`: a parked bus has its master switch turned off every
//    night, and calling that a pulled plug would take every crew's bonus.
//
// 2. The feed a meter depends on goes away while the validator stays up. That
//    needs the validator on the bus's permanent (battery-direct) supply and a
//    sense wire, through an optocoupler, on the switched feed. Then it can do
//    what the phone meter does with its charger: sample the feed once a second
//    and hand it to assessPower() in protocol/crew.mjs, which decides — moving
//    in the last ten minutes, gone for two — whether this was a pulled plug.
//
// A `power_lost` is written to `deviceEvents` in exactly the shape the phone
// meter writes it (kind 'power', power 'power_lost'), which sync.js sends as a
// meter event. It never goes near the door tape: that tape is the interlock
// record a regulator reads.

import { assessPower } from '../../protocol/crew.mjs';

export function createPowerWatch({ readFeed, odometer = null, database, tripId = () => null, now = () => Date.now() } = {}) {
  let lostAt = null;
  let pulled = false;
  let lastMovedAt = null;
  let lastMetres = null;

  async function tick() {
    const nowS = Math.floor(now() / 1000);
    if (odometer) {
      const reading = await odometer.getVehicleOdometer().catch(() => null);
      if (reading && Number.isFinite(reading.metres)) {
        if (lastMetres !== null && reading.metres > lastMetres) lastMovedAt = nowS;
        lastMetres = reading.metres;
      }
    }
    let charging = null;
    try {
      charging = await readFeed();
    } catch {
      charging = null;
    }
    const next = assessPower({ charging, lostAt, pulled, lastMovedAt }, { now: nowS });
    lostAt = next.lostAt;
    pulled = next.pulled;
    if (next.event === 'power_lost') {
      await database.add('deviceEvents', {
        at: now(), kind: 'power', text: 'The meter lost its vehicle feed with the bus moving.',
        tripId: tripId(), severity: 'alarm', power: 'power_lost', moving: true,
      });
    } else if (next.event === 'power_restored') {
      await database.add('deviceEvents', {
        at: now(), kind: 'power', text: 'The vehicle feed is back.',
        tripId: tripId(), power: 'power_restored', moving: next.moving ?? null,
      });
    }
    return next;
  }

  return { tick, state: () => ({ lostAt, pulled, lastMovedAt }) };
}

/*
  Did the last run end cleanly?

  A marker is written at boot and cleared on a clean exit. Finding it at the
  next boot means the power went (or the process died) — a fact for the
  validator's own diagnostics, kept in the 'meter' store beside its other
  state, and deliberately not an event on either tape.
*/
export async function noteBoot(database, { now = () => Date.now(), keep = 20 } = {}) {
  const marker = await database.get('meter', 'validatorRunning');
  const boots = (await database.get('meter', 'validatorBoots')) ?? [];
  const entry = { at: now(), previousRunEndedCleanly: !marker, previousStartedAt: marker?.at ?? null };
  await database.put('meter', [entry, ...boots].slice(0, keep), 'validatorBoots');
  await database.put('meter', { at: now() }, 'validatorRunning');
  return entry;
}

export async function noteCleanExit(database) {
  await database.delete('meter', 'validatorRunning');
}

// The sense wire, read through pinctrl: "26: ip pd | hi // GPIO26 = input".
export function feedFromPinctrl(pin, { run }) {
  return async () => {
    const out = await run(['get', String(pin)]);
    if (/\|\s*hi\b/.test(out)) return true;
    if (/\|\s*lo\b/.test(out)) return false;
    return null;
  };
}
