// base64url for Uint8Array. Pure JS: works in Node and React Native (no Buffer, no atob).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function toBase64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 || 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 || 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function fromBase64url(text) {
  const clean = String(text);
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) throw new Error(`base64url: bad character at ${i}`);
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (acc >> bits) & 0xff;
      written += 1;
    }
  }
  return bytes.subarray(0, written);
}

// UTF-8 helpers. TextEncoder is not guaranteed on every RN runtime, so encode by hand.
export function utf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}
