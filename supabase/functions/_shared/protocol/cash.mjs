// CT1: a fare paid in cash, on the record.
//
// Plenty of people will pay a Nepali conductor in coins for years yet: no
// smartphone, no card, no balance, a Rs 20 note. Refusing them is not an option
// and pretending they are not aboard is how cash goes missing today. So the
// conductor records each one, on the door phone, as a cash ticket:
//
//   CT1 | vehicle | trip | ticket | door | from stop | to stop | metres | Rs | tariff | unix s | sig
//
// Signed with the vehicle key, like a BM1 receipt, so it is the bus's own
// statement that it took this much cash for this ride — the amount the conductor
// owes the owner at the end of the day. The fare is the published tariff for
// the declared stops, not a number the conductor types: the backend reprices
// it and refuses a ticket whose amount disagrees.
//
// No wallet moves. A cash ticket only counts: toward the money the crew hands
// in, and toward the riders recorded on a trip, which the door counter checks
// (cleanTripVerdict in crew.mjs).

import nacl from 'npm:tweetnacl@1.0.3';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, newNonce, FIELD_SEPARATOR as SEP } from './token.mjs';

export const CASH_VERSION = 'CT1';
const CASH_FIELDS = 12;

function cashBody(ticket) {
  return [
    CASH_VERSION,
    ticket.vehicleId,
    ticket.tripId,
    ticket.ticketId,
    ticket.doorId,
    ticket.fromStop,
    ticket.toStop,
    String(ticket.distanceM),
    String(ticket.amount),
    ticket.tariffCode,
    String(ticket.issuedAt),
  ].join(SEP);
}

export function buildCashTicket({
  vehicleId,
  tripId,
  ticketId = `C${newNonce()}`,
  doorId,
  fromStop,
  toStop,
  distanceM,
  amount,
  tariffCode,
  issuedAt = Math.floor(Date.now() / 1000),
}) {
  assertCode(vehicleId, 'vehicleId');
  assertCode(tripId, 'tripId', 32);
  assertCode(ticketId, 'ticketId', 32);
  assertCode(doorId, 'doorId', 8);
  assertCode(fromStop, 'fromStop', 24);
  assertCode(toStop, 'toStop', 24);
  assertWholeNumber(distanceM, 'distanceM');
  assertWholeNumber(amount, 'amount');
  assertCode(tariffCode, 'tariffCode', 32);
  assertWholeNumber(issuedAt, 'issuedAt');
  return { vehicleId, tripId, ticketId, doorId, fromStop, toStop, distanceM, amount, tariffCode, issuedAt };
}

export function signCashTicket(ticket, vehicleSecretKeyBase64url) {
  const body = cashBody(ticket);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(vehicleSecretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodeCashTicket(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== CASH_VERSION) throw new Error('not a Bhada cash ticket');
  if (parts.length !== CASH_FIELDS) throw new Error('cash ticket is damaged or incomplete');
  const [, vehicleId, tripId, ticketId, doorId, fromStop, toStop, distanceM, amount, tariffCode, issuedAt, signature] = parts;
  const ticket = {
    vehicleId, tripId, ticketId, doorId, fromStop, toStop,
    distanceM: Number(distanceM), amount: Number(amount), tariffCode, issuedAt: Number(issuedAt),
  };
  for (const key of ['distanceM', 'amount', 'issuedAt']) {
    if (!Number.isInteger(ticket[key]) || ticket[key] < 0) throw new Error(`cash ticket has a bad ${key}`);
  }
  return { ticket, signature, body: cashBody(ticket) };
}

/*
  What the backend checks before it records a ticket: the vehicle signed it,
  and the amount is what the published tariff charges for that distance. A
  conductor cannot write down Rs 10 for a Rs 25 ride and keep the difference;
  the tariff and the signature are both theirs to get past, and neither is.
*/
export function verifyCashTicket(text, { vehiclePublicKey, priceFn } = {}) {
  let decoded;
  try {
    decoded = decodeCashTicket(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { ticket, signature, body } = decoded;
  let valid = false;
  try {
    valid = nacl.sign.detached.verify(utf8Bytes(body), fromBase64url(signature), fromBase64url(vehiclePublicKey));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature', message: 'Cash ticket was not signed by that vehicle.', ticket };
  if (priceFn) {
    const price = priceFn(ticket.distanceM, { tariffCode: ticket.tariffCode });
    if (!Number.isFinite(price?.amount) || price.amount !== ticket.amount) {
      return { ok: false, reason: 'price_mismatch', message: `The tariff says Rs ${price?.amount} for ${ticket.distanceM} m, not Rs ${ticket.amount}.`, ticket };
    }
  }
  return { ok: true, ticket };
}
