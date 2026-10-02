// Bhada fare token: what the passenger phone signs and the conductor phone verifies.
// Both happen with no network on either device. The QR string is the whole protocol.

import nacl from 'tweetnacl';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { randomBytes } from './random.mjs';

export const TOKEN_VERSION = 'BH1';
const SEPARATOR = '|';
const FIELD_COUNT = 10;
const NONCE_BYTES = 6;
const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

// A field that could contain the separator would let one field impersonate another,
// so every free-text field is restricted to the base64url alphabet.
// Exported because the meter's own token formats in leg.mjs are separator-joined
// by the same rule, and two copies of this check would eventually disagree.
export function assertCode(value, label, maxLength = 24) {
  const text = String(value ?? '');
  if (!CODE_PATTERN.test(text) || text.length > maxLength) {
    throw new Error(`${label} must be 1-${maxLength} characters of A-Z a-z 0-9 - _`);
  }
}

export function assertWholeNumber(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a whole number`);
}

export const FIELD_SEPARATOR = SEPARATOR;

export function createKeypair() {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: toBase64url(pair.publicKey),
    secretKey: toBase64url(pair.secretKey),
  };
}

export function keypairFromSecret(secretKeyBase64url) {
  const pair = nacl.sign.keyPair.fromSecretKey(fromBase64url(secretKeyBase64url));
  return {
    publicKey: toBase64url(pair.publicKey),
    secretKey: toBase64url(pair.secretKey),
  };
}

export function newNonce() {
  return toBase64url(randomBytes(NONCE_BYTES));
}

// The signed message is the exact body string that travels in the QR, so there is
// no re-serialisation step where the two devices could disagree on byte order.
function bodyOf(token) {
  return [
    TOKEN_VERSION,
    token.passengerPublicKey,
    token.conductorId,
    String(token.amount),
    token.boardingStop,
    token.alightingStop,
    String(token.sequenceNumber),
    token.nonce,
    String(token.timestamp),
  ].join(SEPARATOR);
}

export function buildToken({
  passengerPublicKey,
  conductorId,
  amount,
  boardingStop,
  alightingStop,
  sequenceNumber,
  nonce = newNonce(),
  timestamp = Math.floor(Date.now() / 1000),
}) {
  assertCode(passengerPublicKey, 'passengerPublicKey', 43);
  assertCode(conductorId, 'conductorId');
  assertCode(boardingStop, 'boardingStop');
  assertCode(alightingStop, 'alightingStop');
  assertCode(nonce, 'nonce');
  assertWholeNumber(amount, 'amount');
  assertWholeNumber(sequenceNumber, 'sequenceNumber');
  assertWholeNumber(timestamp, 'timestamp');
  return {
    passengerPublicKey,
    conductorId,
    amount,
    boardingStop,
    alightingStop,
    sequenceNumber,
    nonce,
    timestamp,
  };
}

// Sign and flatten to the string that becomes the QR. No network, no clock sync.
export function signToken(token, secretKeyBase64url) {
  const body = bodyOf(token);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(secretKeyBase64url));
  return `${body}${SEPARATOR}${toBase64url(signature)}`;
}

export function decodeToken(qrText) {
  const parts = String(qrText ?? '').trim().split(SEPARATOR);
  if (parts[0] !== TOKEN_VERSION) throw new Error('not a Bhada fare token');
  if (parts.length !== FIELD_COUNT) throw new Error('fare token is damaged or incomplete');
  const [, publicKey, conductorId, amount, boardingStop, alightingStop, sequence, nonce, timestamp, signature] = parts;
  const token = {
    passengerPublicKey: publicKey,
    conductorId,
    amount: Number(amount),
    boardingStop,
    alightingStop,
    sequenceNumber: Number(sequence),
    nonce,
    timestamp: Number(timestamp),
  };
  if (!Number.isInteger(token.amount) || !Number.isInteger(token.sequenceNumber) || !Number.isInteger(token.timestamp)) {
    throw new Error('fare token has non-numeric fields');
  }
  return { token, signature, body: bodyOf(token) };
}

// Everything a conductor phone needs to accept or refuse a fare, offline.
// `seenSequences` is the set of sequence numbers already collected from this
// passenger on this trip; `maxAgeSeconds` bounds clock drift between two phones.
export function verifyQr(qrText, { conductorId, seenSequences, now = Math.floor(Date.now() / 1000), maxAgeSeconds = 6 * 60 * 60 } = {}) {
  let decoded;
  try {
    decoded = decodeToken(qrText);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { token, signature, body } = decoded;

  let signatureValid = false;
  try {
    signatureValid = nacl.sign.detached.verify(
      utf8Bytes(body),
      fromBase64url(signature),
      fromBase64url(token.passengerPublicKey),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, reason: 'bad_signature', message: 'Signature does not match this passenger. Ask for cash.', token };
  }

  if (conductorId && token.conductorId !== conductorId) {
    return { ok: false, reason: 'wrong_conductor', message: `Ticket was made for conductor ${token.conductorId}.`, token };
  }

  if (seenSequences && seenSequences.has(token.sequenceNumber)) {
    return { ok: false, reason: 'replay', message: 'This ticket was already collected on this trip.', token };
  }

  if (Math.abs(now - token.timestamp) > maxAgeSeconds) {
    return { ok: false, reason: 'stale', message: 'Ticket is too old. Passenger should make a new one.', token };
  }

  return { ok: true, token };
}
