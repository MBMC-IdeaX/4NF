// The Bhada door validator, on a Raspberry Pi Zero 2 W.
//
//   node --import ./validator/register.mjs validator/main.mjs
//
// (npm run validator). Everything is configured from the environment, so the
// same program runs on the bus, on a bench with half the parts and on a laptop
// with none of them. See validator/README.md for the wiring and the settings.

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { installRandomSource } from '../src/device/identity.js';
import { terminal } from '../src/device/terminal.js';
import { syncConfigured } from '../src/device/sync.js';
import { createKeypair } from '../protocol/token.mjs';
import { createUplink, selfKey, queueSize } from './uplink.mjs';
import { configureStore, db } from './adapters/store.mjs';
import { attachVehicleSource, onSend } from './adapters/link.mjs';
import { attachCardReader } from './adapters/nfc.mjs';
import { openSerial } from './hw/serial.mjs';
import { createScanner } from './hw/scanner.mjs';
import { createPn532 } from './hw/pn532.mjs';
import { createFrameSync } from './hw/rs485.mjs';
import { createFrameOdometer, createSimulatedOdometer } from './hw/odometer.mjs';
import { createVehicleSource } from './hw/vehicle.mjs';
import { createRtcClock, createFrameClock, createFixedClock, createNtpClock, createClockGate } from './hw/clock.mjs';
import { createPinctrl, createRecordingGpio, createSignals, PINS } from './hw/signals.mjs';
import { createPowerWatch, noteBoot, noteCleanExit, feedFromPinctrl } from './hw/power.mjs';
import { createDisplay, createFramebuffer, createPngSink, createNullSink } from './ui/display.mjs';
import { createValidator } from './core.mjs';
import path from 'node:path';

const env = process.env;
const setting = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : env[name]);
const off = (value) => value === 'none' || value === 'off' || value === '0';

function say(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

const DOOR = setting('BHADA_DOOR', 'A').toUpperCase();
const DATA_DIR = setting('BHADA_DATA_DIR', '/var/lib/bhada');

configureStore({ file: path.join(DATA_DIR, 'validator.sqlite') });
installRandomSource();
const database = await db();
const boot = await noteBoot(database);
say(`boot: door ${DOOR}, data in ${DATA_DIR}${boot.previousRunEndedCleanly ? '' : ' — previous run did not shut down cleanly (power cut or crash)'}`);

// ------------------------------------------------------------------- clock
const frameClock = createFrameClock();
const clockSetting = setting('BHADA_RTC', '/sys/class/rtc/rtc0');
const clockSources = [];
if (clockSetting === 'trust-system') {
  // A laptop on a bench, with a network-set clock. Never on a bus.
  say('clock: TRUSTING THE SYSTEM CLOCK — bench only');
  clockSources.push(createFixedClock({ trusted: true }));
} else if (!off(clockSetting)) {
  clockSources.push(createRtcClock({ sysfs: clockSetting }));
  clockSources.push(createNtpClock({
    check: () => spawnSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { encoding: 'utf8' }).stdout,
  }));
}
clockSources.push(frameClock);
const clock = createClockGate(clockSources);
const firstClock = clock.status();
say(`clock: ${firstClock.trusted ? `trusted (${firstClock.source}, drift ${firstClock.driftS ?? 0} s)` : `NOT trusted — ${firstClock.reason}`}`);

// ---------------------------------------------------------- vehicle and meter
const frameOdometer = createFrameOdometer();
const odometerSetting = setting('BHADA_ODOMETER', 'meter');
const odometer = odometerSetting === 'simulated' ? createSimulatedOdometer({ unitId: `ODO-SIM` }) : odometerSetting === 'meter' ? frameOdometer : null;
const vehicle = createVehicleSource({ odometer });
attachVehicleSource(vehicle);
vehicle.start();

const rs485Device = setting('BHADA_RS485', 'none');
if (!off(rs485Device)) {
  const line = openSerial(rs485Device, { baud: Number(setting('BHADA_RS485_BAUD', 115200)) });
  const sync = createFrameSync({
    onFrame(frame) {
      frameOdometer.onFrame(frame);
      frameClock.onFrame(frame);
      vehicle.onFrame(frame);
    },
    onError: (error) => say(`rs485: ${error.message}`),
  });
  line.onData((bytes) => sync.push(bytes));
  say(`rs485: listening on ${rs485Device}`);
}

// Door → meter messages have no agreed wire format yet. Logged, not sent.
onSend((message) => {
  if (message.kind === 'boarded' || message.kind === 'alighted') say(`to meter (no RS-485 format yet, not sent): ${message.kind} ${message.legId}`);
});

// ------------------------------------------------------------- the door itself
const door = terminal(DOOR);

// --------------------------------------------------------- light and buzzer
const gpioSetting = setting('BHADA_GPIO', 'pinctrl');
const gpio = gpioSetting === 'pinctrl' ? createPinctrl() : createRecordingGpio();
const signals = createSignals({ gpio });
signals.off();

// ----------------------------------------------------------------- display
const displaySetting = setting('BHADA_DISPLAY', '/dev/fb1');
let sink;
if (off(displaySetting)) sink = createNullSink();
else if (displaySetting.startsWith('png:')) sink = createPngSink({ dir: displaySetting.slice(4) });
else sink = createFramebuffer({ device: displaySetting });
const display = createDisplay({ sink, onError: (error) => say(`display: ${error.message}`) });

// -------------------------------------------------------------- the backend
// 'door': one door on a bus whose meter announces the vehicle key.
// 'vehicle': the bus's only unit. It makes the vehicle key and announces it.
const ROLE = setting('BHADA_ROLE', 'door');
let uplink = null;
const online = () => uplink?.online() ?? false;

const validator = createValidator({ door, clock, signals, display, online, log: say });

// --------------------------------------------------------------- card reader
const pn532Device = setting('BHADA_PN532', '/dev/serial0');
if (!off(pn532Device)) {
  try {
    const port = openSerial(pn532Device, { baud: 115200 });
    const reader = createPn532({ port, onError: (error) => say(`pn532: ${error.message}`) });
    const version = await reader.init();
    say(`pn532: firmware ${version.version}.${version.revision} on ${pn532Device}`);
    attachCardReader(validator.cardReader(reader));
    reader.start();
  } catch (error) {
    say(`pn532: not available — ${error.message}. Rider cards will not be read.`);
  }
}

await door.boot();
validator.refresh();

// ------------------------------------------------------------------ scanner
function onCode(code) {
  validator.present(code).then((result) => {
    say(`scan: ${result.ok ? `ok ${result.action}` : `refused ${result.reason}`}`);
  }).catch((error) => say(`scan: ${error.message}`));
}
function onReject(screened, raw) {
  validator.unrecognised(raw).catch((error) => say(`scan: ${error.message}`));
}

const scannerDevice = setting('BHADA_SCANNER', '/dev/ttyACM0');
if (!off(scannerDevice) && scannerDevice !== 'stdin') {
  try {
    const port = openSerial(scannerDevice, { baud: Number(setting('BHADA_SCANNER_BAUD', 9600)) });
    createScanner({ port, onCode, onReject });
    say(`scanner: listening on ${scannerDevice}`);
  } catch (error) {
    say(`scanner: not available — ${error.message}`);
  }
}
if (scannerDevice === 'stdin') {
  // A bench with no scanner: paste codes, one per line.
  const scanner = createScanner({ onCode, onReject });
  createInterface({ input: process.stdin }).on('line', (line) => { scanner.push(`${line}\r`); });
  say('scanner: reading codes from stdin, one per line');
}

// ------------------------------------------------------------------- power
const feedPin = setting('BHADA_FEED_SENSE', 'none');
if (!off(feedPin)) {
  const run = (args) => new Promise((resolve) => {
    const child = spawn('pinctrl', args);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });
  await run(['set', feedPin, 'ip', 'pd']);
  const watch = createPowerWatch({
    readFeed: feedFromPinctrl(feedPin === 'default' ? PINS.feedSense : feedPin, { run }),
    odometer,
    database,
    tripId: () => door.snapshot().tripId,
  });
  setInterval(() => { watch.tick().catch((error) => say(`power: ${error.message}`)); }, 1000);
  say(`power: watching the vehicle feed on GPIO ${feedPin}`);
}

// -------------------------------------------------------------- upload
if (ROLE === 'vehicle') {
  const vehicleId = setting('BHADA_VEHICLE', door.snapshot().vehicleId).toUpperCase();
  const keyed = await selfKey(door, { vehicleId, createKeypair });
  if (keyed.created) say(`vehicle: made the vehicle key for ${vehicleId}; the backend learns it on the first upload`);
}
uplink = createUplink({
  door,
  database,
  role: ROLE,
  capacity: Number(setting('BHADA_CAPACITY', 42)),
  firmware: 'bhada-validator/1',
  log: say,
});
if (syncConfigured()) {
  uplink.start();
  const queued = await queueSize(database);
  say(`uplink: ${ROLE} role, ${queued.receipts} receipts and ${queued.taps} taps queued`);
} else {
  say('uplink: BHADA_SYNC_URL not set — rides are kept on the card and never uploaded');
}

// Re-check the clock every ten seconds, so a coin cell dying mid-shift shows.
setInterval(() => validator.refresh(), 10 * 1000);

async function leave() {
  signals.off();
  await noteCleanExit(database).catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', leave);
process.on('SIGINT', leave);
say(`ready: ${door.snapshot().paired ? `paired to ${door.snapshot().vehicleId}` : 'NOT PAIRED — show the meter’s pairing code to the scanner'}`);
