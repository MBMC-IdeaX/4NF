// Record the door's Nepali announcements as audio clips.
//
// A bus has no signal and most phones have no Nepali voice installed, so the
// speech cannot be generated on the bus. It is generated once, here, by a
// Nepali TTS model, and shipped in public/voice/ where the service worker
// precaches it with the rest of the app. src/lib/voice.js plays the clips and
// falls back to the device's own speech for anything not recorded.
//
// A spoken amount is two clips: the number, then the rest of the sentence.
// That keeps the set small — every number once, every sentence once — instead
// of one clip per amount per sentence.
//
//   npm run voice                 record every clip that is missing
//   npm run voice -- --force      record them all again
//
// TTS_URL and TTS_VOICE override the endpoint and the reference voice.

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/voice/', import.meta.url));
const ENDPOINT = process.env.TTS_URL ?? 'http://tts.wiseai.wiseyak.com/generate_from_text';
const VOICE = process.env.TTS_VOICE ?? 'Pratikshya';
const FORCE = process.argv.includes('--force');

// Amounts up to this are recorded. A metered fare never passes the Rs 25 cap,
// a family of four is Rs 100; larger stage fares fall back to device speech.
export const MAX_NUMBER = 100;

// Keys are what src/lib/voice.js asks for. Change a sentence here and in the
// English fallback there together.
export const PHRASES = {
  board: 'चढ्नुहोस्',
  bus_full: 'सिट सकियो, अर्को गाडी जानुस्',
  'after:deducted': 'रुपैयाँ कट्यो',
  'after:received': 'रुपैयाँ प्राप्त भयो',
  'after:ticket': 'रुपैयाँ को टिकट तयार भयो',
  'refused:replay': 'टिकट दोहोरियो',
  'refused:bad_signature': 'टिकट नक्कली छ',
  'refused:wrong_conductor': 'अर्को बसको टिकट',
  'refused:stale': 'टिकट पुरानो भयो',
  'refused:unreadable': 'टिकट पढ्न सकिएन',
  'refused:other': 'टिकट मिलेन',
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
    language: 'nepali',
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
  return { extension, bytes: Buffer.from(await response.arrayBuffer()) };
}

const exists = (path) => access(path).then(() => true, () => false);

async function main() {
  await mkdir(OUT, { recursive: true });
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = (await exists(manifestPath)) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};

  const jobs = Object.entries(PHRASES);
  for (let n = 0; n <= MAX_NUMBER; n += 1) jobs.push([`n:${n}`, devanagari(n)]);

  let made = 0;
  let bytes = 0;
  for (const [key, text] of jobs) {
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
