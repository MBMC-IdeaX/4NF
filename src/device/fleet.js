// Which bus this device is on.
//
// The plate was a constant in five files. That is correct for one demo bus and
// wrong for the second one: an operator with eleven buses on R11 cannot ship
// eleven builds, and a conductor phone that moves to another vehicle in the
// morning would be signing taps for a bus it is not on.
//
// So the vehicle is provisioned, once, per device, and kept. Three ways in,
// because three different people set these devices up:
//
//   - the meter's own provisioning QR, which the door terminals already scan to
//     get the vehicle key. It carries the plate too; pairing now keeps it.
//   - a URL parameter (`?vehicle=BA2KHA4412`), for a technician setting up a
//     rack of phones from a spreadsheet.
//   - the built-in default, so a fresh install with no provisioning at all is
//     still a working demo rather than a blank screen.
//
// Nothing here talks to a network. A device that has been provisioned once
// stays provisioned through a reinstall of nothing and a reboot of anything,
// because the answer lives in the same IndexedDB as everything else.

import { db } from '../storage/db';

const KEY = 'vehicle';

/*
  The demo bus. Every field is a fact about a real vehicle that a real
  deployment reads off the route permit, which is why they are all here together
  rather than scattered: capacity is what the door interlock enforces, and
  plate is what every signature on this device names.
*/
export const DEFAULT_VEHICLE = {
  id: 'BA2KHA4412',
  plate: { province: 'बा', number: '२', series: 'ख', digits: '४४१२' },
  routeId: 'R11',
  routeName: 'Ratna Park — Koteshwor',
  seated: 30,
  standing: 12,
  capacity: 42,
  firmware: 'bhada-meter 1.2.0',
  hardware: 'ESP32-S3 · u-blox NEO-M9N · SIM7600 · RS-485',
};

// Latin plate as Nepali plate fields, so a vehicle provisioned by id alone
// still draws a number plate. `BA2KHA4412` -> बा २ ख ४४१२.
const PROVINCE = { BA: 'बा', GA: 'ग', LU: 'लु', NA: 'ना', SE: 'से', KO: 'को', ME: 'मे', PR: 'प्र' };
const SERIES = { KHA: 'ख', CHA: 'च', JA: 'ज', PA: 'प', GA: 'ग', HA: 'ह', TA: 'त' };
const DEVANAGARI = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
const devanagari = (value) => String(value).replace(/\d/g, (d) => DEVANAGARI[Number(d)]);

export function plateFromId(id) {
  const match = /^([A-Z]{2})(\d)([A-Z]{2,3})(\d{4})$/.exec(String(id ?? '').toUpperCase());
  if (!match) return null;
  const [, province, number, series, digits] = match;
  return {
    province: PROVINCE[province] ?? province,
    number: devanagari(number),
    series: SERIES[series] ?? series,
    digits: devanagari(digits),
  };
}

let cached = null;

/*
  What vehicle this device is provisioned for.

  Read once and held, because it is asked for on every tap and a signature that
  waited on a database round trip is a signature that arrives after the
  passenger has stepped past.
*/
export async function loadVehicle() {
  if (cached) return cached;
  const database = await db();
  const saved = await database.get('meter', KEY);
  if (saved) {
    cached = { ...DEFAULT_VEHICLE, ...saved };
    return cached;
  }

  // A technician's URL, honoured once and then written down like any other
  // provisioning. Read here rather than at every call site so no screen has to
  // know it is a possibility.
  const fromUrl = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('vehicle')
    : null;
  if (fromUrl) return provisionVehicle({ id: fromUrl.toUpperCase() });

  cached = DEFAULT_VEHICLE;
  return cached;
}

// The synchronous answer, for a render that cannot wait. Whatever was last
// loaded, or the default until the first load lands.
export function currentVehicle() {
  return cached ?? DEFAULT_VEHICLE;
}

/*
  Provision this device for a vehicle.

  Everything not supplied falls back to the default, so provisioning by plate
  alone is enough to get a working device — an operator who has not told us the
  seat count gets the demo's 42, and the console shows what it is enforcing.
*/
export async function provisionVehicle(vehicle) {
  const id = String(vehicle?.id ?? '').toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(id)) {
    return { ok: false, reason: 'bad_plate', message: 'A plate is letters and digits, like BA2KHA4412.' };
  }
  const next = {
    ...DEFAULT_VEHICLE,
    ...vehicle,
    id,
    plate: vehicle?.plate ?? plateFromId(id) ?? DEFAULT_VEHICLE.plate,
  };
  const database = await db();
  await database.put('meter', next, KEY);
  cached = next;
  return { ok: true, vehicle: next };
}
