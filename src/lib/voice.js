// Sound.
//
// The reference is the UPI soundbox, which merchants across India and Nepal
// adopted because it means never looking at a screen to know you were paid. A
// conductor has exactly that problem: eyes on the passenger, the door and the
// road, one hand holding cash.
//
// The hard constraint is airplane mode, so this is built in two layers:
//
//   Layer 1  A synthesised cue, generated with the Web Audio API. No files, no
//            network, no voice pack. It always plays. This is the signal.
//   Layer 2  The amount spoken aloud in Nepali: recorded clips when they have
//            been made (public/voice/, see scripts/make-voice.mjs), otherwise
//            speechSynthesis when a usable voice exists on the device. This is
//            a bonus on top of layer 1, never the thing being relied on.
//
// Device speech is genuinely unreliable in the field: Nepali (ne-NP) voices are
// rarely installed, iOS Safari has no offline guarantee, and a device with its
// language packs stripped has nothing to speak with. Treating speech as an
// enhancement rather than the signal is the only honest way to ship it.

let context = null;
let unlocked = false;

// Browsers refuse audio until a user gesture. Both sound moments follow a tap
// somewhere earlier in the flow (choosing a role, tapping pay), so the context
// is created and resumed on the first touch and is warm by the time it matters.
export function unlockAudio() {
  if (unlocked) return;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    context = context ?? new Ctor();
    if (context.state === 'suspended') context.resume();
    unlocked = true;
  } catch {
    // A device that will not give us an audio context still has haptics and a
    // full-bleed screen. Sound is the third signal, not the only one.
  }
}

/*
  The cues are physical objects, not tones.

  The screen already says a stamp came down on a ticket. A beep would say
  something else entirely — a beep is a laptop, a microwave, a notification.
  These are synthesised as impacts instead: a short noise transient for the
  strike, and a damped resonant body underneath it for what the strike landed
  on. That is what makes a sound read as a thing hitting a thing rather than
  as an alert.

  Both are built from noise and filters rather than sample files, so they stay
  at zero bytes, need no precache, and work with the radio off.
*/

let noiseBuffer = null;

function noise() {
  if (!noiseBuffer) {
    const length = Math.floor(context.sampleRate * 0.4);
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  const source = context.createBufferSource();
  source.buffer = noiseBuffer;
  return source;
}

// Exponential ramps cannot reach zero, and a decay that stops dead clicks.
function decayTo(param, at, peak, seconds) {
  param.setValueAtTime(0.0001, at);
  param.exponentialRampToValueAtTime(peak, at + 0.002);
  param.exponentialRampToValueAtTime(0.0001, at + seconds);
}

/*
  A rubber stamp hitting a paper ticket on a wooden counter.

  Two parts, which is what every real impact is made of: the contact transient
  (rubber meeting paper — broadband, gone in twenty milliseconds, rolled off
  high because paper is soft) and the body resonance under it (the counter,
  low, pitch dropping slightly as it dies, the way struck wood does).
*/
function stampStrike(at, level = 1) {
  // Contact: the flat slap of the rubber face.
  const contact = noise();
  const contactFilter = context.createBiquadFilter();
  contactFilter.type = 'lowpass';
  contactFilter.frequency.setValueAtTime(1900, at);
  contactFilter.frequency.exponentialRampToValueAtTime(700, at + 0.05);
  const contactGain = context.createGain();
  decayTo(contactGain.gain, at, 0.34 * level, 0.055);
  contact.connect(contactFilter).connect(contactGain).connect(context.destination);
  contact.start(at);
  contact.stop(at + 0.1);

  // Body: the counter under the ticket. Struck wood falls in pitch as it dies.
  const body = context.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(178, at);
  body.frequency.exponentialRampToValueAtTime(112, at + 0.14);
  const bodyGain = context.createGain();
  decayTo(bodyGain.gain, at, 0.3 * level, 0.16);
  body.connect(bodyGain).connect(context.destination);
  body.start(at);
  body.stop(at + 0.22);
}

/*
  A flat palm on the sheet metal of a bus.

  This is the sound a Nepali conductor already makes: two slaps on the side of
  the body, the signal every driver and passenger on that road understands. It
  means stop, wait, something is wrong. Using it for a refused fare means the
  cue needs no learning — it is already the vocabulary of the vehicle.

  Bandpassed noise for the slap, plus a short metallic partial for the panel
  ringing and being damped by the hand that hit it.
*/
function metalSlap(at, level = 1) {
  const slap = noise();
  const band = context.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(2500, at);
  band.Q.setValueAtTime(1.1, at);
  const slapGain = context.createGain();
  decayTo(slapGain.gain, at, 0.3 * level, 0.085);
  slap.connect(band).connect(slapGain).connect(context.destination);
  slap.start(at);
  slap.stop(at + 0.14);

  // The panel ringing, immediately damped by the palm still resting on it.
  const ring = context.createOscillator();
  ring.type = 'triangle';
  ring.frequency.setValueAtTime(1240, at);
  ring.frequency.exponentialRampToValueAtTime(980, at + 0.07);
  const ringGain = context.createGain();
  decayTo(ringGain.gain, at, 0.1 * level, 0.075);
  ring.connect(ringGain).connect(context.destination);
  ring.start(at);
  ring.stop(at + 0.12);
}

// Accepted: one stamp. The same object the screen is showing.
export function cueAccepted() {
  unlockAudio();
  if (!context) return;
  stampStrike(context.currentTime + 0.005);
}

/*
  Refused: the double slap. Two hits, 135ms apart, the second a little softer —
  the natural fall of a hand doing it twice, not a metronome. Nothing else in
  the app uses metal, so it cannot be mistaken for the stamp even across a
  crowded bus.
*/
export function cueRefused() {
  unlockAudio();
  if (!context) return;
  const now = context.currentTime + 0.005;
  metalSlap(now, 1);
  metalSlap(now + 0.135, 0.82);
}

// --------------------------------------------------------------- speech

const PREFERRED = ['ne-NP', 'ne', 'hi-IN', 'hi', 'en-IN', 'en-GB', 'en-US', 'en'];

/*
  Pick the best available voice. Nepali is preferred and rarely present; Hindi
  is common on Android handsets and renders Devanagari intelligibly to a Nepali
  listener, which is why it sits second rather than English.
*/
function pickVoice() {
  let voices = [];
  try {
    voices = window.speechSynthesis?.getVoices?.() ?? [];
  } catch {
    return null;
  }
  if (voices.length === 0) return null;
  for (const tag of PREFERRED) {
    const match = voices.find((voice) => voice.lang?.toLowerCase().startsWith(tag.toLowerCase()));
    if (match) return match;
  }
  return voices[0] ?? null;
}

export function stopSpeaking() {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    // Nothing to cancel.
  }
}

function speak(devanagari, english) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const voice = pickVoice();
    if (!voice) return;

    const devanagariCapable = /^(ne|hi|mr|sa)/i.test(voice.lang ?? '');
    const utterance = new SpeechSynthesisUtterance(devanagariCapable ? devanagari : english);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    // Slightly slower than default: this is heard once, over engine noise, and
    // there is no way to ask for a repeat.
    utterance.rate = 0.95;
    utterance.pitch = 1;

    // A queued backlog of announcements is worse than none. The newest fare is
    // the only one anybody cares about.
    synth.cancel();
    synth.speak(utterance);
  } catch {
    // Speech is layer 2. Its failure is silent by design.
  }
}

// --------------------------------------------------------------- recorded clips

/*
  A recorded Nepali voice, made ahead of time by scripts/make-voice.mjs and
  precached with the app, so it plays with the radio off on a phone that has
  no Nepali voice of its own. It sits in front of speechSynthesis: when every
  clip a sentence needs is recorded, the clips play; otherwise the device
  speaks, exactly as before. No manifest, no clips, no change.
*/

let manifest = null;
let manifestLoad = null;
const clips = new Map();
let playing = [];

function loadManifest() {
  manifestLoad ??= fetch('/voice/manifest.json')
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}))
    .then((loaded) => { manifest = loaded; return loaded; });
  return manifestLoad;
}

function clip(key) {
  if (!clips.has(key)) {
    const loading = fetch(`/voice/${manifest[key]}`)
      .then((response) => response.arrayBuffer())
      .then((data) => context.decodeAudioData(data))
      .catch(() => { clips.delete(key); return null; });
    clips.set(key, loading);
  }
  return clips.get(key);
}

function stopClips() {
  for (const source of playing) {
    try { source.stop(); } catch { /* already finished */ }
  }
  playing = [];
}

// Plays the clips back to back. Resolves false when any is missing, so the
// caller can speak the sentence instead.
async function playClips(keys) {
  if (!context) return false;
  if (!manifest) await loadManifest();
  if (!keys.every((key) => manifest[key])) return false;
  const buffers = await Promise.all(keys.map(clip));
  if (buffers.some((buffer) => !buffer)) return false;

  // The newest announcement is the only one anybody cares about.
  stopClips();
  stopSpeaking();
  // After the cue has landed, not over it.
  let at = context.currentTime + 0.18;
  for (const buffer of buffers) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(at);
    at += buffer.duration;
    playing.push(source);
  }
  return true;
}

function say(keys, devanagari, english) {
  playClips(keys).then((played) => { if (!played) speak(devanagari, english); });
}

const amountKey = (kind, amount) => `${kind}:${Math.round(Number(amount))}`;

/*
  Announcements. Devanagari first, with an English line for a device that only
  has a Latin-script voice.

  Amounts are left as digits rather than spelled out: every speech engine reads
  a numeral in its own language correctly, and hand-written Nepali number words
  would be one more thing to get wrong for no gain.
*/
export function announceReceived(amount) {
  cueAccepted();
  say([amountKey('received', amount)], `${amount} रुपैयाँ प्राप्त भयो`, `${amount} rupees received`);
}

export function announceSent(amount) {
  cueAccepted();
  say([amountKey('ticket', amount)], `${amount} रुपैयाँ को टिकट तयार भयो`, `Ticket ready for ${amount} rupees`);
}

export function announceRefused(reason) {
  cueRefused();
  const lines = {
    replay: ['टिकट दोहोरियो', 'Ticket already used'],
    bad_signature: ['टिकट नक्कली छ', 'Ticket is not genuine'],
    wrong_conductor: ['अर्को बसको टिकट', 'Ticket for another bus'],
    stale: ['टिकट पुरानो भयो', 'Ticket is too old'],
    unreadable: ['टिकट पढ्न सकिएन', 'Could not read the ticket'],
  };
  const [devanagari, english] = lines[reason] ?? ['टिकट मिलेन', 'Ticket not accepted'];
  say([`refused:${lines[reason] ? reason : 'other'}`], devanagari, english);
}

/*
  The door's own three announcements.

  A conductor at a boarding door has both hands occupied and is looking at the
  queue, not at a phone. These are the three things the queue needs to hear
  without anybody reading anything, and they are the three a Nepali conductor
  already shouts — which is why they are phrased the way they are rather than
  translated from English.
*/
export function announceBoarded() {
  cueAccepted();
  say(['board'], 'चढ्नुहोस्', 'Board');
}

export function announceFare(amount) {
  cueAccepted();
  say([amountKey('deducted', amount)], `${amount} रुपैयाँ कट्यो`, `${amount} rupees deducted`);
}

export function announceBusFull() {
  cueRefused();
  say(['bus_full'], 'सिट सकियो, अर्को गाडी जानुस्', 'Bus is full, please take the next one');
}

// Voice lists load asynchronously in Chrome; warming it early means the first
// announcement is not the one that gets skipped.
export function warmVoices() {
  loadManifest();
  try {
    window.speechSynthesis?.getVoices?.();
    if (window.speechSynthesis && 'onvoiceschanged' in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  } catch {
    // No speech support. Layer 1 still plays.
  }
}
