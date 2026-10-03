// How a camera frame is turned into QR text, as policy rather than as a loop.
//
// Two readers exist. `BarcodeDetector` is native and cheap, but on many Android
// builds it constructs happily and then reports nothing forever, because the
// QR model ships with Play Services and is missing. So native is used only when
// it says it reads `qr_code`, and even then jsQR looks at every third frame
// that native came back empty on. A code is never left unread because the
// faster reader was trusted blindly.
//
// jsQR tries both polarities: a ride card shown on a phone in dark mode is
// light modules on a dark ground, and 'dontInvert' could never read it.

export const JSQR_OPTIONS = { inversionAttempts: 'attemptBoth' };
export const SCANS_PER_SECOND = 8;
export const DECODE_WIDTH = 640;
const FALLBACK_EVERY = 3;

export function createReadPolicy({ nativeFormats }) {
  const useNative = Array.isArray(nativeFormats) && nativeFormats.includes('qr_code');
  return {
    useNative,
    tryFallback(tick, nativeFound) {
      if (!useNative) return true;
      return !nativeFound && tick % FALLBACK_EVERY === 0;
    },
  };
}
