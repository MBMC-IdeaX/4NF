// AT1 — somebody official saying this passenger really is a student.
//
// Nepal's Motor Vehicles and Transport Management Act sets concession fares:
// students, senior citizens, people with disabilities, transit staff. Bhada
// prices them — `CONCESSION_RATE` in meter.mjs — but until now the concession
// itself was a string the passenger's own phone put on the receipt. Anybody
// could tap "student" and pay half. In a system whose entire argument is that
// neither party has to be trusted, that was the one number taken on trust.
//
// An attestation fixes it without putting a person in the loop at the door. The
// body that can actually check the claim — a campus office, a ward office, a
// transport booth — signs a statement about the passenger's public key:
//
//   "I, this issuer, certify that this key is a student until this date."
//
// The passenger's phone carries it and shows it with the tap. The door does not
// have to recognise the issuer; the backend does, against `concession_issuers`.
// A ride with no valid attestation settles at the full fare — never refused,
// just not discounted, because a passenger with an expired card is still a
// passenger who needs to get to work.
//
// What this is not: an identity document. It carries no name, no roll number,
// no date of birth — only the passenger's own public key, which the operator
// already sees on every receipt. An issuer that wants to know which of its
// students is travelling learns nothing from this that it did not already give
// out, and the operator learns nothing about the student at all.

import nacl from 'npm:tweetnacl@1.0.3';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, FIELD_SEPARATOR as SEP } from './token.mjs';
import { CONCESSION_RATE } from './meter.mjs';

export const ATTEST_VERSION = 'AT1';
const ATTEST_FIELDS = 7;

// What an issuer is allowed to certify. `none` is not a concession and signing
// it would be a way to spend an issuer's signature on nothing.
export const ATTESTABLE = Object.keys(CONCESSION_RATE).filter((kind) => kind !== 'none');

function attestBody(attestation) {
  return [
    ATTEST_VERSION,
    attestation.passengerPublicKey,
    attestation.issuerPublicKey,
    attestation.concession,
    String(attestation.issuedAt),
    String(attestation.expiresAt),
  ].join(SEP);
}

export function buildAttestation({
  passengerPublicKey,
  issuerPublicKey,
  concession,
  issuedAt = Math.floor(Date.now() / 1000),
  expiresAt,
}) {
  assertCode(passengerPublicKey, 'passengerPublicKey', 43);
  assertCode(issuerPublicKey, 'issuerPublicKey', 43);
  assertCode(concession, 'concession', 12);
  assertWholeNumber(issuedAt, 'issuedAt');
  assertWholeNumber(expiresAt, 'expiresAt');
  if (!ATTESTABLE.includes(concession)) {
    throw new Error(`${concession} is not a concession an issuer can certify`);
  }
  if (expiresAt <= issuedAt) throw new Error('an attestation must expire after it is issued');
  return { passengerPublicKey, issuerPublicKey, concession, issuedAt, expiresAt };
}

export function signAttestation(attestation, issuerSecretKeyBase64url) {
  const body = attestBody(attestation);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(issuerSecretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodeAttestation(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== ATTEST_VERSION) throw new Error('not a Bhada concession card');
  if (parts.length !== ATTEST_FIELDS) throw new Error('concession card is damaged or incomplete');
  const [, passengerPublicKey, issuerPublicKey, concession, issuedAt, expiresAt, signature] = parts;
  const attestation = {
    passengerPublicKey,
    issuerPublicKey,
    concession,
    issuedAt: Number(issuedAt),
    expiresAt: Number(expiresAt),
  };
  for (const field of ['issuedAt', 'expiresAt']) {
    if (!Number.isInteger(attestation[field])) throw new Error(`concession card has a non-numeric ${field}`);
  }
  return { attestation, signature, body: attestBody(attestation) };
}

/*
  Is this card real, current, and this passenger's?

  `trustedIssuers` is a Map or plain object from issuer public key to whatever
  the backend knows about it — at minimum that it is on file. Leave it out and
  only the signature and the dates are checked, which is what a door terminal
  can do offline: a door has no register of ward offices, and does not need one,
  because the concession costs the operator money only once the backend settles.
*/
export function verifyAttestation(text, {
  passengerPublicKey,
  trustedIssuers,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  let decoded;
  try {
    decoded = decodeAttestation(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { attestation, signature, body } = decoded;

  let valid = false;
  try {
    valid = nacl.sign.detached.verify(
      utf8Bytes(body),
      fromBase64url(signature),
      fromBase64url(attestation.issuerPublicKey),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'bad_signature', message: 'This concession card was not signed by the office it names.', attestation };
  }
  if (passengerPublicKey && attestation.passengerPublicKey !== passengerPublicKey) {
    return { ok: false, reason: 'not_yours', message: 'This concession card belongs to someone else.', attestation };
  }
  if (!ATTESTABLE.includes(attestation.concession)) {
    return { ok: false, reason: 'unknown_concession', message: `No such concession: ${attestation.concession}.`, attestation };
  }
  if (now >= attestation.expiresAt) {
    return { ok: false, reason: 'expired', message: 'This concession card has expired. Renew it where you got it.', attestation };
  }
  if (now < attestation.issuedAt) {
    return { ok: false, reason: 'not_yet_valid', message: 'This concession card is dated in the future.', attestation };
  }
  if (trustedIssuers) {
    const known = trustedIssuers instanceof Map
      ? trustedIssuers.get(attestation.issuerPublicKey)
      : trustedIssuers[attestation.issuerPublicKey];
    if (!known) {
      return { ok: false, reason: 'unknown_issuer', message: 'No office on file issued this card.', attestation };
    }
    return { ok: true, attestation, issuer: known };
  }
  return { ok: true, attestation };
}

/*
  What a leg should actually be priced at.

  The rule is deliberately one-way: an attestation can only make a fare cheaper
  than the receipt claims, never dearer. A receipt that says `none` and arrives
  with a student card is a passenger who forgot to switch their phone over, and
  they get the discount. A receipt that claims `student` with no card behind it
  settles at full fare — the operator is not asked to fund an unbacked claim, and
  the passenger is not accused of anything.
*/
export function concessionFor(claimed, attestationText, options = {}) {
  const claim = claimed ?? 'none';
  if (!attestationText) {
    return claim === 'none'
      ? { concession: 'none', verified: false, reason: 'no_claim' }
      : { concession: 'none', verified: false, reason: 'unbacked_claim' };
  }
  const verdict = verifyAttestation(attestationText, options);
  if (!verdict.ok) {
    return { concession: 'none', verified: false, reason: verdict.reason, message: verdict.message };
  }
  // The card decides, not the phone. A passenger who claimed nothing and holds a
  // student card still gets the student rate; one who claimed `senior` and holds
  // a student card gets the student rate. What the phone said never enters it.
  return {
    concession: verdict.attestation.concession,
    verified: true,
    issuer: verdict.issuer ?? null,
    expiresAt: verdict.attestation.expiresAt,
  };
}
