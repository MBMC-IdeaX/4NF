// Record the door's Nepali announcements as audio clips.
//
// A bus has no signal and most phones have no Nepali voice installed, so the
// speech cannot be generated on the bus. It is generated once, here, by a
// Nepali TTS model, and shipped in public/voice/ where the service worker
// precaches it with the rest of the app. src/lib/voice.js plays the clips and
// falls back to the device's own speech for anything not recorded.
//
// Every amount is recorded as a whole sentence. A bare numeral comes out of
// the model rushed and clipped (६ alone is 0.16 s), and spliced in front of the
// rest of the sentence it sounds like two speakers; inside the sentence it is
// spoken the way a person says it.
//
//   npm run voice                 record every clip that is missing
//   npm run voice -- --force      record them all again
//
// TTS_URL and TTS_VOICE override the endpoint and the reference voice.

import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mp3Encoder } from '@breezystack/lamejs';

const OUT = fileURLToPath(new URL('../public/voice/', import.meta.url));
// The default is a temporary tunnel to the model; pass TTS_URL when it moves.
const ENDPOINT = process.env.TTS_URL ?? 'https://rkfpx-113-199-192-49.free.pinggy.net/generate_from_text';
const VOICE = process.env.TTS_VOICE ?? 'Pratikshya';
const FORCE = process.argv.includes('--force');


// Keys are what src/lib/voice.js asks for. Change a sentence here and in the
// English fallback there together.
export const PHRASES = {
  board: 'चढ्नुहोस्',
  bus_full: 'सिट सकियो, अर्को गाडी जानुस्',
  'refused:replay': 'टिकट दोहोरियो',
  'refused:bad_signature': 'टिकट नक्कली छ',
  'refused:wrong_conductor': 'अर्को बसको टिकट',
  'refused:stale': 'टिकट पुरानो भयो',
  'refused:unreadable': 'टिकट पढ्न सकिएन',
  'refused:other': 'टिकट मिलेन',
};

// One clip per amount for each of these: deducted:24 is २४ रुपैयाँ कट्यो, up
// to the largest amount that sentence is said for. A fare never passes Rs 25 a
// person; the door charges a family code at once, so it goes to four fares.
// Anything larger falls back to device speech.
export const AMOUNTS = {
  deducted: { max: 100, say: (n) => `${n} रुपैयाँ कट्यो` },
  received: { max: 50, say: (n) => `${n} रुपैयाँ प्राप्त भयो` },
  ticket: { max: 50, say: (n) => `${n} रुपैयाँ को टिकट तयार भयो` },
};

const DIGITS = '०१२३४५६७८९';
const devanagari = (n) => String(n).replace(/\d/g, (d) => DIGITS[d]);

const EXTENSIONS = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/webm': 'webm' };

async function record(text) {
  const body = new URLSearchParams({
    bucket_name: 'string',
    target_sample_rate: '0',
    filename: 'string',
    model: 'omnivoice_tts',
    text,
    user_id: 'string',
    organization: 'string',
    service: 'string',
    reference_audio_id: VOICE,
    language: 'nep',
    output_type: 'audio',
    audio_speed: '1',
  });
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const extension = EXTENSIONS[type];
  if (!extension) throw new Error(`expected audio, got '${type}': ${(await response.text()).slice(0, 200)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (extension !== 'wav') return { extension, bytes };
  return { extension: 'mp3', bytes: toMp3(trimSilence(bytes)) };
}

// The whole set is precached onto every phone, over 2G. As 24 kHz PCM it is
// about 3 MB, twice the rest of the app; as 16 kHz, 16 kbit/s MP3 it is a tenth of
// that. It is taken down to 16 kHz first, telephone bandwidth, which is all a
// voice heard over a diesel engine through a phone speaker can use.
const RATE = 16000;

// Low-pass below the new Nyquist (a short windowed sinc), then interpolate.
function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const cutoff = Math.min(1, to / from) * 0.9;
  const taps = 16;
  const kernel = [];
  for (let k = -taps; k <= taps; k += 1) {
    const x = k * cutoff;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const window = 0.5 + 0.5 * Math.cos((Math.PI * k) / (taps + 1));
    kernel.push(sinc * window * cutoff);
  }
  const output = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const centre = Math.round(i * ratio);
    let sum = 0;
    for (let k = -taps; k <= taps; k += 1) {
      const at = centre + k;
      if (at >= 0 && at < input.length) sum += input[at] * kernel[k + taps];
    }
    output[i] = Math.max(-32768, Math.min(32767, Math.round(sum)));
  }
  return output;
}

function toMp3(wav) {
  const offset = wav.indexOf('data', 12, 'ascii');
  const channels = wav.readUInt16LE(22);
  const rate = wav.readUInt32LE(24);
  if (offset < 0 || channels !== 1 || wav.readUInt16LE(34) !== 16) throw new Error('expected 16-bit mono WAV from the model');
  const data = wav.subarray(offset + 8, offset + 8 + wav.readUInt32LE(offset + 4));
  const samples = resample(new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - (data.length % 2))), rate, RATE);
  const encoder = new Mp3Encoder(1, RATE, 16);
  const parts = [];
  for (let i = 0; i < samples.length; i += 1152) parts.push(encoder.encodeBuffer(samples.subarray(i, i + 1152)));
  parts.push(encoder.flush());
  return Buffer.concat(parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.length)));
}

// The model pads every clip with silence. Two clips played back to back — a
// number, then the rest of the sentence — would have a gap in the middle, so
// the padding is cut down to a breath at each end. 16-bit PCM only; anything
// else is kept as it came.
function trimSilence(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(34) !== 16) return wav;
  let offset = 12;
  let rate = 0;
  let channels = 1;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') { channels = wav.readUInt16LE(offset + 10); rate = wav.readUInt32LE(offset + 12); }
    if (id === 'data') {
      const start = offset + 8;
      const end = Math.min(start + size, wav.length);
      const frame = 2 * channels;
      // Low enough to keep a soft छ or स at the edge of a word.
      const loud = (at) => Math.abs(wav.readInt16LE(at)) > 150;
      let first = start;
      while (first < end && !loud(first)) first += 2;
      let last = end - 2;
      while (last > first && !loud(last)) last -= 2;
      if (first >= end) return wav;
      const pad = Math.round(rate * 0.06) * frame;
      const from = Math.max(start, first - (first - start) % frame - pad);
      const to = Math.min(end, last - (last - start) % frame + frame + pad);
      const header = Buffer.from(wav.subarray(0, start));
      header.writeUInt32LE(to - from, offset + 4);
      header.writeUInt32LE(header.length - 8 + (to - from), 4);
      return Buffer.concat([header, wav.subarray(from, to)]);
    }
    offset += 8 + size + (size % 2);
  }
  return wav;
}

const exists = (path) => access(path).then(() => true, () => false);

async function main() {
  await mkdir(OUT, { recursive: true });
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = (await exists(manifestPath)) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};

  const jobs = Object.entries(PHRASES);
  for (const [kind, { max, say }] of Object.entries(AMOUNTS)) {
    for (let n = 1; n <= max; n += 1) jobs.push([`${kind}:${n}`, say(devanagari(n))]);
  }

  // Clips for sentences no longer in the list are deleted, not shipped.
  const wanted = new Set(jobs.map(([key]) => key));
  for (const key of Object.keys(manifest)) {
    if (wanted.has(key)) continue;
    await rm(join(OUT, manifest[key]), { force: true });
    delete manifest[key];
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);

  let made = 0;
  let bytes = 0;
  for (const [key, text] of jobs) {
    // A clip recorded before the MP3 step is converted, not recorded again.
    if (!FORCE && manifest[key]?.endsWith('.wav') && (await exists(join(OUT, manifest[key])))) {
      const file = manifest[key].replace(/\.wav$/, '.mp3');
      await writeFile(join(OUT, file), toMp3(trimSilence(await readFile(join(OUT, manifest[key])))));
      await rm(join(OUT, manifest[key]));
      manifest[key] = file;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
      continue;
    }
    if (!FORCE && manifest[key] && (await exists(join(OUT, manifest[key])))) continue;
    const clip = await record(text);
    const file = `${key.replace(/[^a-z0-9_]+/gi, '-')}.${clip.extension}`;
    await writeFile(join(OUT, file), clip.bytes);
    manifest[key] = file;
    made += 1;
    bytes += clip.bytes.length;
    // Written after every clip, so a dropped connection keeps what was done.
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${key.padEnd(26)} ${text}  (${(clip.bytes.length / 1024).toFixed(0)} KB)`);
  }
  console.log(`${made} recorded, ${(bytes / 1024).toFixed(0)} KB; ${Object.keys(manifest).length}/${jobs.length} in public/voice/manifest.json`);
}

main().catch((error) => {
  console.error(`voice: ${error.message}`);
  if (/ENOTFOUND|getaddrinfo/.test(String(error.cause ?? error))) console.error(`voice: cannot resolve ${new URL(ENDPOINT).host} — check TTS_URL`);
  process.exit(1);
});
