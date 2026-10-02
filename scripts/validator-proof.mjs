// Proof: the Bhada door validator on a Raspberry Pi.
//
// Runs the phone's door terminal (src/device/terminal.js) unchanged under Node,
// with the Pi's adapters swapped in for the browser, and drives it the way the
// hardware will: codes arriving as bytes from a scanner, cards as PN532 frames,
// the meter as 32-byte RS-485 heartbeats, the clock from a DS3231 through the
// kernel. Nothing in this file opens a socket; fetch is replaced with a trap
// that fails the proof if validation ever reaches for the network.
//
// Keys and codes are made fresh each run with protocol/'s own functions, as
// every other proof in scripts/ does; there are no fixed vectors to reuse.
// The PN532 frames are checked against the examples in NXP's PN532 User Manual.
//
// Run: npm run proof:validator            (add -- --screens to write PNGs of
//                                          every screen to docs/validator/)

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';

import { installRandomSource } from '../src/device/identity.js';
import { terminal } from '../src/device/terminal.js';
import { createKeypair } from '../protocol/token.mjs';
import { buildTap, signTap, verifyTap, verifyLeg, TAP_MAX_AGE_S, decodePass } from '../protocol/leg.mjs';
import { priceDistance } from '../protocol/meter.mjs';
import { FLAG, encodeFrame } from '../protocol/frame.mjs';

import { configureStore, db } from '../validator/adapters/store.mjs';
import { attachVehicleSource } from '../validator/adapters/link.mjs';
import { attachCardReader, formatSerial } from '../validator/adapters/nfc.mjs';
import { createScanAssembler, createRepeatFilter, screenCode, createKeyboardWedge } from '../src/lib/scan-input.js';
import { createScanner } from '../validator/hw/scanner.mjs';
import { buildFrame, parseFrames, parseTargets, createPn532, ACK, CMD } from '../validator/hw/pn532.mjs';
import { createFrameSync } from '../validator/hw/rs485.mjs';
import { createManualOdometer, fresh, ODOMETER_FRESH_MS } from '../validator/hw/odometer.mjs';
import { createVehicleSource } from '../validator/hw/vehicle.mjs';
import { createRtcClock, createFrameClock, createFixedClock, createNtpClock, createClockGate, MAX_DRIFT_S } from '../validator/hw/clock.mjs';
import { createRecordingGpio, createSignals, doorActionFor, PINS } from '../validator/hw/signals.mjs';
import { createPowerWatch, noteBoot, noteCleanExit } from '../validator/hw/power.mjs';
import { screenFor } from '../validator/ui/screens.mjs';
import { renderSvg, rasterise, toRgb565, toPng, qrLayout, WIDTH, HEIGHT } from '../validator/ui/render.mjs';
import { createValidator } from '../validator/core.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCREENS = process.argv.includes('--screens');
// The screens the READMEs show. The rest are checked but not written.
const DOCUMENTED = new Set(['idle', 'in', 'out', 'invalid', 'held']);

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  const suffix = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
}
function section(title) {
  console.log(`\n${title}`);
}

const nowS = () => Math.floor(Date.now() / 1000);
const noTimer = () => 0;
const VEHICLE = 'BA2KHA4412';

installRandomSource();

// Validation must never touch the network. Anything that calls fetch is a
// failure unless a section has swapped in its own mock on purpose.
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('the validator reached for the network');
};

function tapFor(keys, { vehicleId = VEHICLE, doorId = 'A', timestamp } = {}) {
  return signTap(buildTap({ passengerPublicKey: keys.publicKey, vehicleId, doorId, ...(timestamp ? { timestamp } : {}) }), keys.secretKey);
}

// =========================================================== 1. scanner input
section('1. Scanner input: where a scan ends, and what is worth verifying');
{
  const got = [];
  const assembler = createScanAssembler({ onScan: (text) => got.push(text), setTimer: noTimer, clearTimer: () => {} });
  assembler.push('BT1|abc\r');
  assembler.push('BT1|d');
  assembler.push('ef\n');
  assembler.push(new TextEncoder().encode('BO1|xyz\r\n'));
  check('CR, LF and CRLF each end exactly one scan', JSON.stringify(got) === JSON.stringify(['BT1|abc', 'BT1|def', 'BO1|xyz']), got);

  let timed = [];
  let fire = null;
  const silent = createScanAssembler({ onScan: (text) => timed.push(text), setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  silent.push('BT1|no-terminator');
  check('a scanner set up with no terminator is not stuck', timed.length === 0 && typeof fire === 'function');
  fire();
  check('...silence ends the scan instead', timed[0] === 'BT1|no-terminator');

  const junk = ['https://example.com/ride', '{"v":"BHPAIR1"}', 'WIFI:S:bus;P:1234;;', 'BT1|<script>', `BT1|${'A'.repeat(2000)}`, ''];
  check('a URL, a Wi-Fi sticker, markup and a flood are all screened out', junk.every((text) => !screenCode(text).ok), junk.map((text) => screenCode(text).reason));
  check('BT1 and BO1 pass the screen', screenCode(' BT1|a|b \r').ok && screenCode('BO1|x').ok);

  const repeat = createRepeatFilter({ windowMs: 3000, now: (() => { let t = 0; return () => (t += 500); })() });
  check('the same screen read again inside 3 s is swallowed', repeat('BT1|x') === true && repeat('BT1|x') === false && repeat('BT1|y') === true);

  const typed = [];
  let clock = 0;
  const wedge = createKeyboardWedge({ onScan: (text) => typed.push(text), now: () => clock });
  const code = 'BT1|abcdefghijklmnopqrstuvwxyz';
  for (const key of code) { clock += 4; wedge({ key, target: { tagName: 'BODY' } }); }
  clock += 4; wedge({ key: 'Enter', target: { tagName: 'BODY' }, preventDefault() {} });
  for (const key of 'BT1|slow-human-typing-here') { clock += 200; wedge({ key, target: { tagName: 'BODY' } }); }
  clock += 200; wedge({ key: 'Enter', target: { tagName: 'BODY' } });
  for (const key of code) { clock += 4; wedge({ key, target: { tagName: 'TEXTAREA' } }); }
  wedge({ key: 'Enter', target: { tagName: 'TEXTAREA' } });
  check('phone OTG scanner: a fast burst ending in Enter is a scan', typed[0] === code);
  check('...a person typing, or typing into a field, is not', typed.length === 1, typed);
}

// ====================================================== 2. the 300-second rule
section('2. The 300-second tap window, door and backend');
{
  const keys = createKeypair();
  const at = nowS();
  const tap = tapFor(keys, { timestamp: at });
  check('TAP_MAX_AGE_S is 300', TAP_MAX_AGE_S === 300);
  check('300 s old: accepted', verifyTap(tap, { vehicleId: VEHICLE, now: at + 300 }).ok);
  check('301 s old: refused as stale', verifyTap(tap, { vehicleId: VEHICLE, now: at + 301 }).reason === 'stale');
  check('300 s in the future: accepted (a phone clock ahead)', verifyTap(tap, { vehicleId: VEHICLE, now: at - 300 }).ok);
  check('301 s in the future: refused', verifyTap(tap, { vehicleId: VEHICLE, now: at - 301 }).reason === 'stale');

  const migrations = readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const latest = migrations.filter((f) => /function\s+(public\.)?settle_leg\s*\(/i.test(readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'))).at(-1);
  const body = readFileSync(path.join(ROOT, 'supabase', 'migrations', latest), 'utf8');
  check(`settle_leg() in ${latest} applies the same 300 s`, /tapped_at\s*-\s*p_boarded_at\)\)\)\s*>\s*300/.test(body));

  // A validator whose own clock is wrong refuses honest passengers. This is the
  // failure the clock gate exists to prevent.
  const fresh = tapFor(keys);
  check('a door clock 10 min fast refuses a code made this second', verifyTap(fresh, { vehicleId: VEHICLE, now: nowS() + 600 }).reason === 'stale');
  check('a door clock 10 min slow refuses it too', verifyTap(fresh, { vehicleId: VEHICLE, now: nowS() - 600 }).reason === 'stale');
}

// ================================================================= 3. clock
section('3. The clock: DS3231 through the kernel, and the gate');
{
  const sysNow = Date.UTC(2026, 8, 28, 9, 42, 18);
  const reader = (answer) => () => {
    if (answer instanceof Error) throw answer;
    return `${answer}\n`;
  };
  const errno = (code) => Object.assign(new Error(code), { code });
  const rtc = (answer) => createRtcClock({ now: () => sysNow, read: reader(answer) }).status();

  check('RTC agrees with the system clock: trusted', rtc(sysNow / 1000).trusted === true);
  check(`RTC ${MAX_DRIFT_S} s apart: still trusted`, rtc(sysNow / 1000 - MAX_DRIFT_S).trusted === true);
  check(`RTC ${MAX_DRIFT_S + 1} s apart: not trusted (drift)`, rtc(sysNow / 1000 - MAX_DRIFT_S - 1).reason === 'drift');
  check('oscillator stopped (EINVAL from rtc-ds1307): not trusted', rtc(errno('EINVAL')).reason === 'rtc_lost_time');
  check('no RTC on the bus: not trusted', rtc(errno('ENOENT')).reason === 'no_rtc');
  check('RTC reading 1970: never set', rtc(12345).reason === 'never_set');

  const frameClock = createFrameClock({ now: () => sysNow });
  check('meter heartbeat time: not trusted before any frame', frameClock.status().trusted === false);
  frameClock.onFrame({ unixSeconds: sysNow / 1000 }, sysNow);
  check('...trusted once a frame agrees', frameClock.status().trusted === true);

  const gate = createClockGate([createRtcClock({ now: () => sysNow, read: reader(errno('EINVAL')) }), frameClock]);
  check('dead coin cell, meter heard: the gate uses the meter', gate.status().trusted && gate.status().source === 'meter');
  const lagging = createRtcClock({ now: () => sysNow, read: reader(sysNow / 1000 - 40) });
  const ntpYes = createNtpClock({ now: () => sysNow, check: () => 'yes' });
  const ntpNo = createNtpClock({ now: () => sysNow, check: () => 'no' });
  check('just came into signal: NTP moved the clock, RTC 40 s behind — still validating', createClockGate([lagging, ntpYes]).status().trusted);
  check('...but without NTP the same 40 s is drift and the door stops', !createClockGate([lagging, ntpNo]).status().trusted);
  const alone = createClockGate([createRtcClock({ now: () => sysNow, read: reader(errno('EINVAL')) })]);
  check('dead coin cell, nothing else: the gate says why', !alone.status().trusted && alone.status().reason === 'rtc_lost_time');
}

// ================================================================== 4. PN532
section('4. PN532 frames (NXP PN532 User Manual examples)');
{
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
  check('GetFirmwareVersion frame', hex(buildFrame(CMD.GET_FIRMWARE_VERSION)) === '00 00 ff 02 fe d4 02 2a 00', hex(buildFrame(CMD.GET_FIRMWARE_VERSION)));
  check('SAMConfiguration (normal mode) frame', hex(buildFrame(CMD.SAM_CONFIGURATION, [0x01, 0x14, 0x01])) === '00 00 ff 05 fb d4 14 01 14 01 02 00');
  const reply = Uint8Array.from([0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff, 0x06, 0xfa, 0xd5, 0x03, 0x32, 0x01, 0x06, 0x07, 0xe8, 0x00]);
  const parsed = parseFrames(reply);
  check('ACK then firmware response parse (IC 0x32, v1.6)', parsed.frames[0].ack && parsed.frames[1].response === 0x03 && parsed.frames[1].data[0] === 0x32 && parsed.frames[1].data[1] === 1 && parsed.frames[1].data[2] === 6);
  const damaged = Uint8Array.from(reply);
  damaged[15] ^= 0xff;
  check('a response with a bad checksum is dropped whole', parseFrames(damaged).frames.filter((f) => f.response !== undefined).length === 0);
  const split = parseFrames(reply.subarray(0, 12));
  check('half a frame waits for the rest', split.frames.length === 1 && split.rest.length === 6);

  const targets = parseTargets(Uint8Array.from([0x01, 0x01, 0x00, 0x44, 0x00, 0x07, 0x04, 0xa2, 0x3b, 0x4c, 0x5d, 0x6e, 0x80]));
  check('InListPassiveTarget: a 7-byte NTAG serial', targets.length === 1 && formatSerial(targets[0].uid) === '04:A2:3B:4C:5D:6E:80', formatSerial(targets[0]?.uid ?? []));
  check('the serial is formatted as Chrome Web NFC reports it, upper-cased as nfc.js does', formatSerial([0x04, 0xa2]) === '04:A2');
}

// ================================================================= 5. RS-485
section('5. RS-485: the protocol/frame.mjs heartbeat off a byte stream');
{
  const frames = [];
  const errors = [];
  const sync = createFrameSync({ onFrame: (frame) => frames.push(frame), onError: (e) => errors.push(e) });
  const beat = (odometerMetres, flags = 0) => encodeFrame({ flags, occupancy: 12, capacity: 42, odometerMetres, unixSeconds: 1790584615, openLegs: 12, accrued: 480 });
  const stream = [
    Uint8Array.from([0x13, 0x37, 0x01, 0x00, 0xff]), // joined half way through something
    beat(1000), beat(1010), beat(1020, FLAG.AT_CAPACITY | FLAG.MOVING),
  ];
  const corrupt = beat(1030);
  corrupt[8] ^= 0x01;
  stream.push(corrupt, beat(1040));
  const all = new Uint8Array(stream.reduce((n, s) => n + s.length, 0));
  let at = 0;
  for (const s of stream) { all.set(s, at); at += s.length; }
  // Arrive in awkward pieces, as a UART delivers them.
  for (let i = 0; i < all.length; i += 7) sync.push(all.subarray(i, i + 7));
  check('finds the frames after joining mid-stream', frames.length >= 4 && frames[0].odometerMetres === 1000, frames.map((f) => f.odometerMetres));
  check('a frame corrupted on the wire is dropped, the next one is not', !frames.some((f) => f.odometerMetres === 1030) && frames.at(-1).odometerMetres === 1040);
  check('flags survive: AT_CAPACITY and MOVING', frames[2].flagNames.includes('AT_CAPACITY') && frames[2].flagNames.includes('MOVING'));
  check('decodeFrame() is the only parser — every field round-trips', frames[0].occupancy === 12 && frames[0].capacity === 42 && frames[0].accrued === 480 && frames[0].unixSeconds === 1790584615);
}

// =========================================================== 6. odometer seam
section('6. The vehicle odometer adapter');
{
  let t = 1_000_000;
  const odo = createManualOdometer({ unitId: `ODO-${VEHICLE}`, metres: 500, now: () => t });
  const reading = await odo.getVehicleOdometer();
  check('getVehicleOdometer() answers metres, time, unit and source', reading.metres === 500 && reading.unitId === `ODO-${VEHICLE}` && reading.source === 'manual');
  check(`a reading ${ODOMETER_FRESH_MS} ms old is fresh; one ms more is not`, fresh(reading, t + ODOMETER_FRESH_MS) && !fresh(reading, t + ODOMETER_FRESH_MS + 1));

  const heard = [];
  const source = createVehicleSource({ odometer: odo, now: () => t });
  source.subscribe((m) => heard.push(m));
  await source.tick();
  check('no meter box: the odometer alone reaches the door as state', heard.length === 1 && heard[0].odometerM === 500 && heard[0].unitId === `ODO-${VEHICLE}` && heard[0].onboard === undefined);
  t += ODOMETER_FRESH_MS + 1;
  await source.tick();
  check('a stale odometer is not passed on as if it were current', heard.length === 1);
  source.onFrame({ flags: FLAG.AT_CAPACITY, occupancy: 42, capacity: 42, odometerMetres: 9000, accrued: 0, openLegs: 42, unixSeconds: 0 });
  await source.tick();
  check('a meter heartbeat wins over the odometer', heard.at(-1).unitId === 'METER' && heard.at(-1).atCapacity === true && heard.length === 2);
}

// ============================================================ 7. the door
section('7. The phone door, unchanged, on the Pi adapters — offline');

configureStore({ file: ':memory:' });
const vehicleKeys = createKeypair();
const pairing = JSON.stringify({ v: 'BHPAIR1', publicKey: vehicleKeys.publicKey, secretKey: vehicleKeys.secretKey, vehicleId: VEHICLE });

let t0 = Date.now();
const odometer = createManualOdometer({ unitId: `ODO-${VEHICLE}`, metres: 1000 });
const vehicle = createVehicleSource({ odometer });
attachVehicleSource(vehicle);

const doorA = terminal('A');
await doorA.boot();
const clockA = createFixedClock({ trusted: true });
const gpio = createRecordingGpio();
const signals = createSignals({ gpio, setTimer: noTimer, clearTimer: () => {} });
const shown = [];
const validatorA = createValidator({ door: doorA, clock: clockA, signals, display: { show: (m) => shown.push(m) }, setTimer: noTimer, clearTimer: () => {} });
const scannerA = createScanner({
  onCode: (code) => { pendingScan = validatorA.present(code); },
  onReject: (screened, raw) => { pendingScan = validatorA.unrecognised(raw); },
});
let pendingScan = null;
async function scan(text) {
  pendingScan = null;
  scannerA.push(`${text}\r`);
  return pendingScan ? pendingScan : null;
}

{
  const unpaired = await scan(tapFor(createKeypair()));
  check('unpaired: refused before the door is asked', unpaired?.reason === 'unpaired' && shown.at(-1).kind === 'unpaired');
  const pair = await scan(pairing);
  check('the vehicle key loads through the scanner while the door has none', pair?.ok === true && doorA.snapshot().paired && doorA.snapshot().vehicleId === VEHICLE);
  const other = createKeypair();
  const repair = await scan(JSON.stringify({ v: 'BHPAIR1', publicKey: other.publicKey, secretKey: other.secretKey, vehicleId: VEHICLE }));
  check('...and never again: a stranger\'s pairing code is refused', repair?.ok === false && doorA.snapshot().vehiclePublicKey === vehicleKeys.publicKey);
}

const riders = { amrita: createKeypair(), bishal: createKeypair(), chandra: createKeypair(), dipa: createKeypair() };

{
  await vehicle.tick();
  const boardTap = tapFor(riders.amrita);
  const boarded = await scan(boardTap);
  check('valid BT1: boarded, verified on the door with no network', boarded?.ok && boarded.action === 'in');
  check('...the screen shows ✓ VALID with the BO1 pass as a QR', shown.at(-1).kind === 'in' && shown.at(-1).qr === boarded.passQr);
  check('...green light and one beep', gpio.writes.some((w) => w.pin === PINS.green && w.on));
  const pass = decodePass(boarded.passQr).pass;
  check('...the pass is stamped with the vehicle odometer, 1000 m', pass.unitId === `ODO-${VEHICLE}` && pass.boardOdoM === 1000, { unitId: pass.unitId, boardOdoM: pass.boardOdoM });

  const again = await scan(boardTap);
  check('the same code held up again inside 3 s: swallowed, no second verdict', again === null && scannerA.counts().repeats === 1);

  const malformed = await scan(boardTap.slice(0, 60));
  check('malformed BT1 (cut off): INVALID', malformed?.reason === 'unreadable' && shown.at(-1).kind === 'invalid');

  const forged = boardTap.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  const bad = await scan(forged.replace(/\|[^|]+\|/, `|${riders.bishal.publicKey}|`));
  check('BT1 with somebody else\'s key and a signature that is not theirs: bad_signature', bad?.reason === 'bad_signature');

  const other = await scan(tapFor(riders.bishal, { vehicleId: 'BA3KHA0001' }));
  check('BT1 for another bus: wrong_vehicle', other?.reason === 'wrong_vehicle');

  const expired = await scan(tapFor(riders.bishal, { timestamp: nowS() - 302 }));
  check('expired BT1 (302 s old): stale', expired?.reason === 'stale' && shown.at(-1).lines[0].includes('expired'));

  const edge = await scan(tapFor(riders.bishal, { timestamp: nowS() - 299 }));
  check('299 s old: boarded — the window is the same one the backend applies', edge?.ok && edge.action === 'in');

  // The ride, closed at the same door, by distance off the vehicle odometer.
  odometer.set(5200);
  await vehicle.tick();
  const closing = await scan(tapFor(riders.amrita));
  const leg = closing?.leg;
  check('amrita taps again: ride closed, priced by the odometer (4200 m)', closing?.ok && closing.action === 'out' && leg.distanceM === 4200 && leg.distanceSource === 'odometer', leg && { distanceM: leg.distanceM, source: leg.distanceSource });
  check('...fare is exactly the published tariff for 4.2 km', leg.amount === priceDistance(4200).amount, `Rs ${leg.amount}`);
  const receipt = verifyLeg(closing.receipt, { vehiclePublicKey: vehicleKeys.publicKey });
  check('...BM1 receipt signed by the vehicle key and verifies', receipt.ok && receipt.leg.amount === leg.amount && receipt.leg.distanceM === 4200);
  check('...the ride close carries the boarding tapQr, not the alighting one', leg.tapQr === boardTap);
  const row = await (await db()).get('legs', leg.legId);
  check('...and so does the row the upload reads', row.tapQr === boardTap && row.receipt === closing.receipt && row.status === 'closed');
  check('...the screen shows ✓ VALID, the fare and the receipt QR', shown.at(-1).kind === 'out' && shown.at(-1).fare === `Rs ${leg.amount}` && shown.at(-1).qr === closing.receipt);

  // The clock gate.
  clockA.set({ trusted: false, reason: 'rtc_lost_time' });
  const before = doorA.snapshot().issued;
  const gated = await scan(tapFor(riders.chandra));
  check('clock not trusted: refused before the door is asked', gated?.reason === 'clock_untrusted' && doorA.snapshot().issued === before);
  check('...the screen says CLOCK NOT SET', validatorA.screen().kind === 'clock');
  clockA.set({ trusted: true, reason: null });

  check('no network was touched by any of it', fetchCalls === 0, `${fetchCalls} fetch calls`);
  check('the link says detached — no meter box, no pretending', doorA.snapshot().link === 'detached');
}

// A family on one phone: one scan, three people, each on their own ride.
{
  const { buildGroup } = await import('../protocol/leg.mjs');
  const family = [createKeypair(), createKeypair(), createKeypair()];
  const on = await scan(buildGroup(family.map((k) => tapFor(k))));
  check('a family code boards all three with one scan', on?.ok && on.action === 'group' && on.boarded === 3, on && { boarded: on.boarded, refused: on.refused });
  odometer.set(6200);
  await vehicle.tick();
  const off = await scan(buildGroup(family.map((k) => tapFor(k))));
  check('...and lets all three off with the next, each fare its own', off?.ok && off.alighted === 3 && off.results.every((r) => r.leg?.tapQr), off && { alighted: off.alighted, amount: off.amount });
}

// ================================================= 8. held, and the exit never held
section('8. The interlock: held at capacity, the exit never held');
{
  const boarded = await scan(tapFor(riders.chandra));
  check('chandra boards', boarded?.ok && boarded.action === 'in');
  vehicle.onFrame({ flags: FLAG.AT_CAPACITY, occupancy: 42, capacity: 42, odometerMetres: 6000, accrued: 0, openLegs: 42, unixSeconds: nowS() });
  const refused = await scan(tapFor(riders.dipa));
  check('meter says 42/42: dipa is refused at the boarding door', refused?.reason === 'at_capacity');
  check('...the screen says HELD, the light is amber', shown.at(-1).kind === 'held' && gpio.writes.slice(-4).some((w) => w.pin === PINS.red && w.on));
  check('...the simulated door holds', doorActionFor(refused, 'boarding').action === 'hold');
  const leaving = await scan(tapFor(riders.chandra));
  check('chandra, already aboard, taps at the same door: let off — the exit is never held', leaving?.ok && leaving.action === 'out');
  check('...the simulated door releases', doorActionFor(leaving, 'boarding').action === 'release');
  check('the idle screen at a full boarding door says so', screenFor({ snap: doorA.snapshot(), now: Date.now() + 60000 }).kind === 'held-idle');
  check('no GPIO pin drives a door — only light and sound', Object.keys(PINS).every((k) => ['red', 'green', 'blue', 'buzzer', 'feedSense'].includes(k)));
}

// ================================================================ 9. screens
section('9. The 320×240 screen: every state, every QR decodes');
{
  const snap = doorA.snapshot();
  const passResult = { ok: true, action: 'in', legId: 'L0000', passQr: null, pass: { boardOdoM: 1000 }, at: Date.now() };
  const lastIn = shown.filter((m) => m.kind === 'in').at(-1);
  const lastOut = shown.filter((m) => m.kind === 'out').at(-1);
  const models = {
    idle: screenFor({ snap: { ...snap, bus: { ...snap.bus, atCapacity: false }, last: null }, online: true }),
    offline: screenFor({ snap: { ...snap, bus: { ...snap.bus, atCapacity: false }, last: null }, online: false }),
    validating: screenFor({ snap, validating: true }),
    in: lastIn,
    out: lastOut,
    invalid: screenFor({ snap: { ...snap, last: { ok: false, reason: 'stale', at: Date.now() } } }),
    held: screenFor({ snap: { ...snap, last: { ok: false, reason: 'at_capacity', at: Date.now() } } }),
    'held-idle': screenFor({ snap: { ...snap, last: null }, now: Date.now() }),
    clock: screenFor({ snap, clock: { trusted: false, reason: 'rtc_lost_time' } }),
    unpaired: screenFor({ snap: { ...snap, paired: false } }),
  };
  void passResult;
  check('idle: BHADA, SCAN QR OR TAP CARD', models.idle.kind === 'idle' && models.idle.lines[0] === 'SCAN QR OR TAP CARD');
  check('offline is a note on the idle screen, not a refusal', models.offline.kind === 'idle' && models.offline.offline === true);
  check('validating, invalid, held, clock and unpaired each have a screen', ['validating', 'invalid', 'held', 'clock', 'unpaired'].every((k) => models[k].kind === k));

  const outDir = path.join(ROOT, 'docs', 'validator');
  if (SCREENS) mkdirSync(outDir, { recursive: true });
  for (const [name, model] of Object.entries(models)) {
    const svg = renderSvg(model);
    const raster = await rasterise(svg);
    check(`${name}: renders at ${WIDTH}×${HEIGHT}`, raster.width === WIDTH && raster.height === HEIGHT);
    if (SCREENS && DOCUMENTED.has(name)) writeFileSync(path.join(outDir, `screen-${name}.png`), await toPng(svg));
    if (model.qr) {
      const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
      for (let i = 0, o = 0; i < raster.rgb.length; i += 3, o += 4) {
        rgba[o] = raster.rgb[i]; rgba[o + 1] = raster.rgb[i + 1]; rgba[o + 2] = raster.rgb[i + 2]; rgba[o + 3] = 255;
      }
      const decoded = jsQR(rgba, WIDTH, HEIGHT);
      const layout = qrLayout(model.qr, { box: 228, level: model.kind === 'out' ? 'L' : 'M' });
      check(`${name}: the QR on the glass decodes to the exact ${model.kind === 'out' ? 'BM1 receipt' : 'BO1 pass'} (v${layout.version}, ${layout.scale} px a module, ${model.qr.length} chars)`, decoded?.data === model.qr && layout.scale >= 3);
    }
  }
  const frame = toRgb565(await rasterise(renderSvg(models.idle)));
  check('RGB565 frame is exactly one ILI9341 screen (153,600 bytes)', frame.length === WIDTH * HEIGHT * 2);
  if (SCREENS) console.log(`  screens written to ${path.relative(ROOT, outDir)}`);
}

doorA.shutdown();

// ================================================================== 10. power
section('10. Vehicle power: power_lost goes in meter_events, never door_events');
{
  configureStore({ file: ':memory:' });
  const database = await db();
  let t = Date.UTC(2026, 8, 28, 9, 0, 0);
  const odo = createManualOdometer({ unitId: 'ODO', metres: 0, now: () => t });
  let feed = true;
  const watch = createPowerWatch({ readFeed: async () => feed, odometer: odo, database, tripId: () => 'TPROOF', now: () => t });
  for (let i = 0; i < 30; i += 1) { t += 1000; odo.set(i * 8); await watch.tick(); }
  feed = false;
  for (let i = 0; i < 125; i += 1) { t += 1000; await watch.tick(); }
  let events = await database.getAll('deviceEvents');
  check('feed gone 2 min after moving: one power_lost', events.filter((e) => e.power === 'power_lost').length === 1 && events[0].kind === 'power');
  feed = true;
  t += 1000; await watch.tick();
  events = await database.getAll('deviceEvents');
  check('feed back: power_restored', events.some((e) => e.power === 'power_restored'));

  // A bus parked for the night: the same socket goes, nothing is raised.
  configureStore({ file: ':memory:' });
  const parkedDb = await db();
  let p = Date.UTC(2026, 8, 28, 22, 0, 0);
  const still = createManualOdometer({ metres: 42000, now: () => p });
  let parkedFeed = true;
  const parked = createPowerWatch({ readFeed: async () => parkedFeed, odometer: still, database: parkedDb, now: () => p });
  for (let i = 0; i < 700; i += 1) { p += 1000; still.set(42000); await parked.tick(); }
  parkedFeed = false;
  for (let i = 0; i < 300; i += 1) { p += 1000; await parked.tick(); }
  check('a parked bus losing the same feed raises nothing', (await parkedDb.getAll('deviceEvents')).length === 0);

  // Where it goes: sync.js's own classifier decides, via a mocked backend.
  configureStore({ file: ':memory:' });
  const tapeDb = await db();
  await tapeDb.add('deviceEvents', { at: Date.now(), kind: 'power', text: 'The meter lost its vehicle feed with the bus moving.', tripId: 'TPROOF', severity: 'alarm', power: 'power_lost', moving: true });
  globalThis.__BHADA_ENV__ = { ...(globalThis.__BHADA_ENV__ ?? {}), VITE_SYNC_URL: 'https://proof.invalid/sync' };
  const { syncMeter } = await import('../src/device/sync.js');
  let sent = null;
  const trap = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ legsSettled: 0, legResults: [], tapResults: [] }) };
  };
  await syncMeter({ vehicleId: VEHICLE, publicKey: vehicleKeys.publicKey, capacity: 42, firmware: 'proof' });
  globalThis.fetch = trap;
  check('sync.js sends it as a meter event', sent?.meterEvents?.length === 1 && sent.meterEvents[0].kind === 'power_lost' && sent.meterEvents[0].moving === true);
  check('...and puts nothing on the door tape', Array.isArray(sent?.doorEvents) && sent.doorEvents.length === 0);

  // The validator's own death is a diagnostic, not an event on either tape.
  configureStore({ file: ':memory:' });
  const bootDb = await db();
  const first = await noteBoot(bootDb);
  const second = await noteBoot(bootDb);
  await noteCleanExit(bootDb);
  const third = await noteBoot(bootDb);
  check('a run that ended without a clean exit is noticed at the next boot', first.previousRunEndedCleanly && !second.previousRunEndedCleanly && third.previousRunEndedCleanly);
  check('...and written to neither tape', (await bootDb.getAll('deviceEvents')).length === 0);
}

// =============================================================== 11. storage
section('11. Storage: a pulled plug after a tap');
{
  const dir = path.join(tmpdir(), `bhada-validator-proof-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const file = path.join(dir, 'validator.sqlite');
  configureStore({ file });
  const database = await db();
  await database.put('legs', { legId: 'LPROOF', status: 'open', tapQr: 'BT1|proof', passengerPublicKey: 'x' });
  await database.put('meter', { publicKey: 'k' }, 'pairing');
  // Read it back over a second connection while the first is still open and
  // was never closed or flushed: what a fresh boot after a pulled plug sees.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  const leg = raw.prepare("SELECT value FROM kv WHERE store = 'legs' AND key = 's:LPROOF'").get();
  check('a leg written before the power went is on disk, committed', JSON.parse(leg?.value ?? '{}').tapQr === 'BT1|proof');
  const pair = raw.prepare("SELECT value FROM kv WHERE store = 'meter' AND key = 's:pairing'").get();
  check('...and so is the pairing', JSON.parse(pair?.value ?? '{}').publicKey === 'k');
  check('WAL journal on disk (the store sets synchronous FULL on its own connection)', raw.prepare('PRAGMA journal_mode').get().journal_mode === 'wal');
  raw.close();
  configureStore({ file: ':memory:' });
  rmSync(dir, { recursive: true, force: true });
}

// ================================================================== 12. NFC
section('12. Rider cards on a PN532, through the door\'s existing card flow');
{
  configureStore({ file: ':memory:' });
  const doorB = terminal('B');
  await doorB.boot();
  await doorB.pair(pairing);

  // A PN532 on a fake UART: answers every command, and reports whichever card
  // is on it.
  let onCard = null;
  const port = {
    listeners: new Set(),
    card: null,
    onData(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    write(bytes) {
      const { frames } = parseFramesFromHost(bytes);
      for (const cmd of frames) {
        const answer = cmd === CMD.GET_FIRMWARE_VERSION ? [0x32, 0x01, 0x06, 0x07]
          : cmd === CMD.SAM_CONFIGURATION ? []
          : cmd === CMD.IN_LIST_PASSIVE_TARGET ? (this.card ? [0x01, 0x01, 0x00, 0x44, 0x00, this.card.length, ...this.card] : null)
          : null;
        if (answer === null) continue;
        const out = new Uint8Array([...ACK, ...responseFrame(cmd + 1, answer)]);
        queueMicrotask(() => { for (const fn of this.listeners) fn(out); });
      }
    },
  };
  const reader = createPn532({ port, responseMs: 30, pollMs: 5 });
  const version = await reader.init();
  check('PN532 answers GetFirmwareVersion (1.6)', version.version === 1 && version.revision === 6);

  const clock = createFixedClock({ trusted: true });
  const validatorB = createValidator({ door: doorB, clock, setTimer: noTimer, clearTimer: () => {} });
  attachCardReader(validatorB.cardReader(reader));
  check('the door now reports a card reader', doorB.snapshot().nfc === true);

  const serial = [0x04, 0xa2, 0x3b, 0x4c, 0x5d, 0x6e, 0x80];
  await doorB.enrol({ alias: 'Hari', cardUid: formatSerial(serial) });

  port.card = serial;
  await reader.pollOnce();
  await new Promise((r) => setTimeout(r, 20));
  let last = doorB.snapshot().last;
  check('enrolled card on the reader: boarded by the door\'s own card flow', last?.ok && last.action === 'in');
  const openRow = (await (await db()).getAll('legs')).find((r) => r.status === 'open');
  check('...with a BT1 the door signed for the card, verified like any other', openRow?.tapQr?.startsWith('BT1|') && verifyTap(openRow.tapQr, { vehicleId: VEHICLE }).ok);

  await reader.pollOnce();
  await new Promise((r) => setTimeout(r, 20));
  check('card left resting on the reader: not read twice', doorB.snapshot().last === last);

  port.card = null;
  await reader.pollOnce();
  port.card = serial;
  await reader.pollOnce();
  await new Promise((r) => setTimeout(r, 20));
  last = doorB.snapshot().last;
  check('taken away and tapped again: ride closed', last?.ok && last.action === 'out' && last.leg.tapQr === openRow.tapQr);

  port.card = null;
  await reader.pollOnce();
  port.card = [0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
  await reader.pollOnce();
  await new Promise((r) => setTimeout(r, 20));
  check('an unknown card is refused, not enrolled on the spot', doorB.snapshot().last?.reason === 'unknown_card' && doorB.snapshot().cards.length === 1);

  port.card = null;
  await reader.pollOnce();
  clock.set({ trusted: false, reason: 'no_rtc' });
  const issued = doorB.snapshot().issued;
  port.card = serial;
  await reader.pollOnce();
  await new Promise((r) => setTimeout(r, 20));
  check('clock not trusted: a card tap is refused too', doorB.snapshot().issued === issued && validatorB.results().at(-1)?.reason === 'clock_untrusted');

  doorB.shutdown();
  reader.stop();
  check('still no network touched outside the mocked sync', fetchCalls === 0);
}

// ================================================================ 13. uplink
section('13. Getting rides to the database: store, forward, never twice');
{
  // Loaded here, after section 10 pointed sync.js at a mock endpoint.
  const { createUplink, selfKey, queueSize, pruneSettled, INTERVAL_MS } = await import('../validator/uplink.mjs');
  configureStore({ file: ':memory:' });
  const database = await db();
  const odo = createManualOdometer({ unitId: `ODO-${VEHICLE}`, metres: 2000 });
  const source = createVehicleSource({ odometer: odo });
  attachVehicleSource(source);
  const unit = terminal('C');
  await unit.boot();

  const keyed = await selfKey(unit, { vehicleId: VEHICLE, createKeypair });
  check('a validator that is the whole bus makes its own vehicle key', keyed.created && unit.snapshot().paired);
  check('...once: a second boot keeps it', (await selfKey(unit, { vehicleId: VEHICLE, createKeypair })).created === false);

  const rider = createKeypair();
  await source.tick();
  const boardTap = tapFor(rider, { doorId: 'C' });
  await unit.present({ text: boardTap });
  odo.set(9500);
  await source.tick();
  const out = await unit.present({ text: tapFor(rider, { doorId: 'C' }) });
  check('a ride closed offline waits in the queue', out.ok && (await queueSize(database)).receipts === 1);

  let clock = Date.now();
  const sent = [];
  let answer = 'offline';
  const trap = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    return {
      ok: true,
      json: async () => ({
        legsSettled: body.legs.length,
        legResults: body.legs.map((item) => ({ ok: true, legId: item.receipt.split('|')[3] })),
        tapResults: [],
      }),
    };
  };
  const uplink = createUplink({ door: unit, database, role: 'vehicle', capacity: 42, now: () => clock });

  const failed = await uplink.once();
  check('no signal: the upload fails and the ride stays queued', Boolean(failed.error) && (await queueSize(database)).receipts === 1);
  check('...and the next try waits twice as long', uplink.delay() === INTERVAL_MS * 2);

  answer = 'online';
  const first = await uplink.once();
  const body = sent.at(-1);
  check('signal back: one HTTPS POST of JSON, the same batch a phone sends', body.legs.length === 1 && body.devicePublicKey === unit.snapshot().vehiclePublicKey);
  check('...the receipt travels with the passenger’s own boarding tap', body.legs[0].tap === boardTap && verifyLeg(body.legs[0].receipt, { vehiclePublicKey: unit.snapshot().vehiclePublicKey }).ok);
  check('...the vehicle role announces its key for register_meter()', body.meter?.publicKey === unit.snapshot().vehiclePublicKey && body.meter.vehicleId === VEHICLE && body.meter.capacity === 42);
  check('...settled rides leave the queue, the schedule is back to one minute', first.cleared === 1 && (await queueSize(database)).receipts === 0 && uplink.delay() === INTERVAL_MS);
  await uplink.once();
  check('the next upload sends nothing twice', sent.at(-1).legs.length === 0);

  check('settled rides stay on the card for a fortnight', (await pruneSettled(database, { now: clock + 13 * 86400000 })) === 0);
  check('...then are removed, so the card does not fill', (await pruneSettled(database, { now: clock + 15 * 86400000 })) === 1 && (await database.getAll('legs')).length === 0);
  globalThis.fetch = trap;
  unit.shutdown();
  clock += 0;
}

// Helpers for the fake PN532: what the host sent, and how the chip answers.
function parseFramesFromHost(bytes) {
  const out = [];
  for (let i = 0; i + 7 < bytes.length; i += 1) {
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x00 && bytes[i + 2] === 0xff && bytes[i + 5] === 0xd4) out.push(bytes[i + 6]);
  }
  return { frames: out };
}
function responseFrame(code, data) {
  const body = [0xd5, code, ...data];
  const sum = body.reduce((a, b) => a + b, 0);
  return [0x00, 0x00, 0xff, body.length, (0x100 - body.length) & 0xff, ...body, (0x100 - (sum & 0xff)) & 0xff, 0x00];
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures > 0) {
  console.log(`${failures} FAILED.`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
