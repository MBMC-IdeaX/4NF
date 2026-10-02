// Tap-and-go, where the handset will do it.
//
// The camera path works and it is slow. Aligning a phone screen with another
// phone's camera takes a second and a half in good light and six in the sun or
// in an unlit bus at night, and at Koteshwor at half five in the evening
// twenty-five people come through a seventy-centimetre door in under fifteen
// seconds. The queue does not wait; it pushes, and the conductor stops scanning.
//
// Web NFC is the answer where it exists: Chrome on Android, over HTTPS, with the
// tag or phone held against the back of the handset. A read completes in a few
// hundred milliseconds and needs no aim, no light and no clean lens.
//
// It exists nowhere else — not on iOS, not on desktop, not in Firefox — so this
// is strictly an accelerator. Every surface that uses it keeps its camera
// button exactly where it was, and `nfcSupported()` is how a screen decides
// whether to offer the faster path, never whether to offer a path at all.

export function nfcSupported() {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

const BHADA_RECORD = 'application/vnd.bhada.token';

/*
  Read Bhada tokens off anything tapped against the back of this phone.

  `onText` gets the token string — a BT1 tap, a BO1 pass, an AT1 card — from
  whichever record carries it. Three shapes are accepted because three things
  will be tapped here:

    - a phone running Bhada, writing our own MIME record
    - a phone or tag carrying a plain NDEF text record
    - a blank or foreign tag with no readable record at all, which is a rider
      card: it has no payload, only a hardware serial, and `onCard` gets that

  Returns a stop function. Reading is cancelled through an AbortController
  because a live NFC scan holds the radio, and a door terminal that left one
  running behind a closed screen would drain a phone in a shift.
*/
export function readNfc({ onText, onCard, onError } = {}) {
  if (!nfcSupported()) return () => {};
  const controller = new AbortController();
  let reader;
  try {
    reader = new window.NDEFReader();
  } catch (error) {
    onError?.(error);
    return () => {};
  }

  reader.addEventListener('readingerror', () => {
    onError?.(new Error('That tag could not be read. Hold it flat against the back of the phone.'));
  });

  reader.addEventListener('reading', ({ message, serialNumber }) => {
    const decoder = new TextDecoder();
    for (const record of message.records ?? []) {
      if (record.mediaType === BHADA_RECORD || record.recordType === 'text') {
        const text = decoder.decode(record.data).trim();
        if (text) {
          onText?.(text);
          return;
        }
      }
    }
    // Nothing readable on it. That is not a failure: an empty tag with a serial
    // is exactly what a Rs 20 rider card is.
    if (serialNumber) onCard?.(String(serialNumber).toUpperCase());
  });

  reader.scan({ signal: controller.signal }).catch((error) => {
    // A refused permission and a cancelled scan arrive the same way. Only the
    // first is worth telling anyone about.
    if (error?.name !== 'AbortError') onError?.(error);
  });

  return () => controller.abort();
}

/*
  Write a token onto a tag, or offer it to a phone held against this one.

  Used by the passenger app to hand its ride code to a door terminal without
  either screen being looked at, and by an enrolment desk writing a rider card.
*/
export async function writeNfc(text, { signal } = {}) {
  if (!nfcSupported()) throw new Error('This phone cannot do NFC in the browser.');
  const writer = new window.NDEFReader();
  await writer.write(
    { records: [{ recordType: 'mime', mediaType: BHADA_RECORD, data: new TextEncoder().encode(text) }] },
    { signal },
  );
}
