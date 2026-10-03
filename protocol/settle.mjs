// One settlement path, two runtimes.
//
// A sync batch is verified in exactly one place. The Edge Function (Deno) and
// the PGlite harness (Node) used to carry their own copy of this: the same
// verification, the same batching, the same argument shaping, written twice.
// Two copies of a money path drift, and the drift is invisible — the proofs
// pass against the Node copy while the Deno copy is what actually bills people.
//
// So the verification lives here, platform-free like the rest of `protocol/`,
// and each runtime supplies a ledger: an object of async methods that touch
// its own database and nothing else. Nothing in this file knows what a
// Postgres client is, and nothing in it reads a clock or an environment
// variable it was not handed.

import { verifyQr } from './token.mjs';
import { verifyLeg, verifyLegConsent, verifyTap } from './leg.mjs';
import { verifyDispute, assessDispute } from './dispute.mjs';
import { verifyAttestation } from './attest.mjs';
import { verifyLink } from './pseudonym.mjs';
import { verifyAccountLink } from './account.mjs';
import { scoreLeg } from './plausibility.mjs';
import { verifySignOn, cleanTripVerdict, SHIFT_MAX_AGE_S } from './crew.mjs';
import { priceDistance } from './meter.mjs';
import { verifyCashTicket } from './cash.mjs';

// Queued fares can be days old on a device that has been out of coverage, so
// the freshness window here is generous. The offline cap, not the clock, is
// what bounds exposure.
export const MAX_TOKEN_AGE_SECONDS = 30 * 24 * 60 * 60;
export const MAX_BATCH = 500;

/*
  The envelope, before any signature is looked at.

  Returns the batch split into its three queues, or the status and message the
  caller should answer with. Both runtimes answer with the same words, because
  a device retrying against the local fallback must see what the hosted
  function would have told it.
*/
export function readBatch(body) {
  const tickets = body?.tickets ?? [];
  const legs = body?.legs ?? [];
  const taps = body?.taps ?? [];
  const disputes = body?.disputes ?? [];
  const links = body?.keyLinks ?? [];
  const accountLink = body?.accountLink ?? null;
  const cash = body?.cashTickets ?? [];
  const hasMeter = Boolean(body?.meter?.vehicleId && body?.meter?.publicKey);
  const count = tickets.length + legs.length + taps.length + disputes.length + links.length + (accountLink ? 1 : 0)
    + (Array.isArray(cash) ? cash.length : 0);

  if (!Array.isArray(tickets) || !Array.isArray(legs) || !Array.isArray(taps) || !Array.isArray(disputes)
    || !Array.isArray(links) || !Array.isArray(cash) || (count === 0 && !hasMeter)
    || (accountLink !== null && (typeof accountLink !== 'object' || typeof accountLink.link !== 'string'))) {
    return { ok: false, status: 400, error: 'Send tickets, legs, taps, cash tickets, an account link, or a meter announcement.' };
  }
  if (count > MAX_BATCH) {
    return { ok: false, status: 413, error: `Send at most ${MAX_BATCH} items per request.` };
  }
  if (!body.devicePublicKey) {
    return { ok: false, status: 400, error: 'Send devicePublicKey so settlements can be attributed.' };
  }
  return { ok: true, tickets, legs, taps, disputes, links, accountLink, cash, hasMeter };
}

/*
  A ledger call that failed is a rejected row, not a failed batch.

  One unreachable RPC must not cost a device the other 499 fares it queued, so
  every ledger call is wrapped: a thrown error becomes a `server_error` verdict
  for that row and the batch carries on. A ledger method is free to throw.
*/
async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, reason: 'server_error', message: error?.message ?? String(error) };
  }
}

/*
  Settle one batch.

  `ledger` is the runtime's own database, as methods:

    registerMeter({ vehicleId, publicKey, capacity, firmware, enrolCode })
    registerDevice(publicKey, signupCredit)
    vehicleKey(plate)                       -> base64url key on file, or null
    settledLeg(legId)                       -> the settled row, or null
    registerPseudonym(args)                 -> binds a day-key to its wallet
    userForToken(accessToken)               -> the signed-in user's id, or null
    linkAccount({ userId, walletPublicKey, link }) -> joins a login to a wallet
    moveWallet({ userId, walletPublicKey, link })  -> optional; carries a login's
                                              money to this phone's wallet
    settleFare(args) / recordTap(args) / settleLeg(args) / fileDispute(args)
    flagLeg(args)                           -> optional; records a plausibility score
    appendDoorEvents(events, { vehiclePlate, tripId })
    appendMeterEvents(events, { vehiclePlate })  -> optional; the box's power tape
    noteCrew(args)                          -> optional; binds a signed-on crew to a trip
    tripEvidence(tripId)                    -> optional; the counts a bonus is judged on
    awardCleanTrip(args)                    -> optional; pays one trip's bonus, once

  and two hooks the hosted function does not need, which a local demo does:

    ensureVehicle(plate)                    -> optional
    noteTrip(tripId, plate)                 -> optional

  `now` and `signupCredit` are handed in rather than read, for the same reason
  the random source is: this file has no environment to read them from.
*/
export async function settleBatch(body, ledger, { signupCredit = 0, now = Math.floor(Date.now() / 1000) } = {}) {
  const batch = readBatch(body);
  if (!batch.ok) return [batch.status, { error: batch.error }];
  const { tickets, legs, taps, disputes, links, accountLink, cash, hasMeter } = batch;

  const ensureVehicle = async (plate) => {
    if (ledger.ensureVehicle && plate) await ledger.ensureVehicle(plate);
  };

  // A device that has never been online has no row yet. Registering on first
  // sight is what lets a passenger start paying before they can reach us.
  // Once per batch, not once per ticket.
  const registered = new Set();
  const registerPassenger = async (key) => {
    if (registered.has(key)) return;
    registered.add(key);
    await ledger.registerDevice(key, signupCredit);
  };

  // A meter announcing itself. The key is frozen on first sight by
  // register_meter(); a second key for the same plate comes back as a mismatch
  // rather than quietly replacing the one every existing receipt was signed with.
  // A bus its owner registered binds only a phone that brings the one-time
  // setup code from the Owner app (0034); the verdict goes back to the phone so
  // it can say why it is not yet the bus.
  let meterResult = null;
  if (hasMeter) {
    await ensureVehicle(body.meter.vehicleId);
    meterResult = await attempt(() => ledger.registerMeter({
      vehicleId: body.meter.vehicleId,
      publicKey: body.meter.publicKey,
      capacity: body.meter.capacity ?? null,
      firmware: body.meter.firmware ?? null,
      enrolCode: typeof body.meter.enrolCode === 'string' ? body.meter.enrolCode : null,
    }));
  }

  // ------------------------------------------------------- day-key registrations

  /*
    A phone telling the backend which wallet today's key spends from.

    First, before any fare in this batch is settled, because a leg signed with a
    day-key that has no wallet behind it would be refused as an unknown
    passenger. Both signatures on a PK1 are checked here — the wallet's, saying
    it authorised this key, and the key's own, proving the sender holds it.
  */
  const linkResults = [];
  for (const text of links) {
    const verdict = verifyLink(String(text ?? ''));
    if (!verdict.ok) {
      linkResults.push({ ok: false, reason: verdict.reason, message: verdict.message });
      continue;
    }
    const { link } = verdict;
    linkResults.push(await attempt(async () => {
      await registerPassenger(link.rootPublicKey);
      return ledger.registerPseudonym({
        pseudonymPublicKey: link.pseudonymPublicKey,
        rootPublicKey: link.rootPublicKey,
        dayIndex: link.day,
        link: String(text),
      });
    }));
  }

  // ------------------------------------------------------------ account link

  /*
    A login claiming a wallet.

    The AL1 proves the phone holds the wallet and names the login it is for;
    the access token proves who is asking. Both must agree, or a link someone
    saw could be replayed into their own session.
  */
  let accountResult = null;
  if (accountLink) {
    const verdict = verifyAccountLink(accountLink.link, { now });
    if (!verdict.ok) {
      accountResult = { ok: false, reason: verdict.reason, message: verdict.message };
    } else {
      accountResult = await attempt(async () => {
        const userId = accountLink.accessToken ? await ledger.userForToken(accountLink.accessToken) : null;
        if (!userId) return { ok: false, reason: 'not_signed_in', message: 'Sign in before linking a wallet.' };
        if (userId !== verdict.link.userId) {
          return { ok: false, reason: 'wrong_user', message: 'This link was made for a different login.' };
        }
        await registerPassenger(verdict.link.walletPublicKey);
        // A new phone taking over a login that already has a wallet: the
        // balance moves to this phone (move_wallet, migration 0029). Same two
        // proofs as a first link; the flag only says which the caller meant.
        if (accountLink.move === true && ledger.moveWallet) {
          return ledger.moveWallet({
            userId,
            walletPublicKey: verdict.link.walletPublicKey,
            link: accountLink.link,
          });
        }
        return ledger.linkAccount({
          userId,
          walletPublicKey: verdict.link.walletPublicKey,
          link: accountLink.link,
        });
      });
    }
  }

  // ------------------------------------------------------------ stage fares

  const results = [];
  for (const qrText of tickets) {
    const verdict = verifyQr(qrText, { now, maxAgeSeconds: MAX_TOKEN_AGE_SECONDS });
    if (!verdict.ok) {
      results.push({ ok: false, reason: verdict.reason, message: verdict.message });
      continue;
    }
    const token = verdict.token;
    results.push(await attempt(async () => {
      await registerPassenger(token.passengerPublicKey);
      await ensureVehicle(token.conductorId);
      if (body.tripId && ledger.noteTrip) await ledger.noteTrip(body.tripId, token.conductorId);
      return ledger.settleFare({
        passengerPublicKey: token.passengerPublicKey,
        vehiclePlate: token.conductorId,
        tripId: body.tripId ?? null,
        amount: token.amount,
        boardingStop: token.boardingStop,
        alightingStop: token.alightingStop,
        sequenceNumber: token.sequenceNumber,
        nonce: token.nonce,
        issuedAt: new Date(token.timestamp * 1000).toISOString(),
        collectedAt: new Date(now * 1000).toISOString(),
        settledBy: body.devicePublicKey,
      });
    }));
  }

  // --------------------------------------------------------- passenger taps

  /*
    The passenger's consent. A receipt is signed by the vehicle, and a
    passenger's public key is printed in every QR they show, so a vehicle key
    alone must not be able to bill anyone. A tap is filed against one leg,
    once; settle_leg() will not move money for a leg with no tap on file.
  */
  async function fileTap(legId, tap, leg) {
    let binding = leg;
    if (!binding) {
      // Filed on its own: only the signature can be checked here. settle_leg()
      // checks it against the receipt's passenger, plate and boarding time.
      const verdict = verifyTap(tap, { maxAgeSeconds: Number.MAX_SAFE_INTEGER });
      if (!verdict.ok) {
        return { ok: false, legId, reason: verdict.reason === 'bad_signature' ? 'bad_tap' : verdict.reason };
      }
      binding = {
        passengerPublicKey: verdict.tap.passengerPublicKey,
        vehicleId: verdict.tap.vehicleId,
        boardAt: verdict.tap.timestamp,
      };
    }
    const consent = verifyLegConsent(tap, binding);
    if (!consent.ok) return { ok: false, legId, reason: consent.reason, message: consent.message };
    return attempt(async () => {
      await ensureVehicle(consent.tap.vehicleId);
      return ledger.recordTap({
        legId,
        vehiclePlate: consent.tap.vehicleId,
        passengerPublicKey: consent.tap.passengerPublicKey,
        tapNonce: consent.tap.nonce,
        tappedAt: new Date(consent.tap.timestamp * 1000).toISOString(),
        tap,
      });
    });
  }

  const tapResults = [];
  for (const entry of taps) {
    if (!entry?.legId || !entry?.tap) {
      tapResults.push({ ok: false, reason: 'unreadable' });
      continue;
    }
    tapResults.push(await fileTap(String(entry.legId), String(entry.tap), null));
  }

  // ------------------------------------------------------------ metered legs

  // Vehicle keys, fetched once per batch. A receipt is only worth as much as
  // the key it was signed with, and that key comes from the operator's record
  // here — never from the upload, which is the thing being checked.
  const vehicleKeys = new Map();
  async function keyFor(plate) {
    if (!vehicleKeys.has(plate)) vehicleKeys.set(plate, (await ledger.vehicleKey(plate)) ?? null);
    return vehicleKeys.get(plate);
  }

  const legResults = [];
  for (const item of legs) {
    const receipt = typeof item === 'string' ? item : String(item?.receipt ?? '');
    const tap = typeof item === 'string' ? null : item?.tap ?? null;
    const card = typeof item === 'string' ? null : item?.attestation ?? null;
    // Peek at the plate before verifying, only to find the key to verify with.
    const plate = receipt.split('|')[1] ?? '';
    const vehicleKey = await keyFor(plate);
    if (!vehicleKey) {
      legResults.push({ ok: false, legId: receipt.split('|')[3] ?? null, reason: 'unknown_vehicle', message: `No meter key on file for ${plate}.` });
      continue;
    }

    // The same pricing function the box ran. If the two disagree, the receipt
    // is refused: an operator's box getting the arithmetic wrong is exactly the
    // failure this check exists to catch, and settling it anyway would make the
    // published tariff advisory.
    const verdict = verifyLeg(receipt, { vehiclePublicKey: vehicleKey, priceFn: priceDistance });
    if (!verdict.ok) {
      legResults.push({ ok: false, legId: verdict.leg?.legId ?? null, reason: verdict.reason, message: verdict.message });
      continue;
    }
    const { leg } = verdict;

    if (tap) {
      const filed = await fileTap(leg.legId, tap, leg);
      if (!filed?.ok) {
        legResults.push({ ok: false, legId: leg.legId, reason: filed?.reason ?? 'bad_tap', message: filed?.message });
        continue;
      }
    }

    /*
      The concession card, if the ride claims a concession.

      Signature, expiry and ownership are checked here; whether the office that
      signed it is one anybody registered is checked in settle_leg(), which is
      the only side holding the register. A claim with no usable card is not
      refused — the issuer key goes up as null and the leg settles at the full
      fare the same distance would have cost anyone else.
    */
    let issuerPublicKey = null;
    if (leg.concession && leg.concession !== 'none' && card) {
      const verdict = verifyAttestation(String(card), {
        passengerPublicKey: leg.passengerPublicKey,
        now: leg.boardAt,
      });
      if (verdict.ok && verdict.attestation.concession === leg.concession) {
        issuerPublicKey = verdict.attestation.issuerPublicKey;
      }
    }

    // What the same ride costs with no concession at all, under the tariff the
    // receipt names. settle_leg() charges this one when nothing backs the claim.
    const fullPrice = priceDistance(leg.distanceM, {
      concession: 'none',
      tariffCode: leg.tariffCode,
      unclosed: leg.distanceSource === 'unclosed',
    });

    legResults.push({ legId: leg.legId, ...await attempt(async () => {
      await registerPassenger(leg.passengerPublicKey);
      return ledger.settleLeg({
        legId: leg.legId,
        vehiclePlate: leg.vehicleId,
        tripId: leg.tripId,
        passengerPublicKey: leg.passengerPublicKey,
        boardDoor: leg.boardDoorId,
        alightDoor: leg.alightDoorId,
        boardOdoM: leg.boardOdoM,
        alightOdoM: leg.alightOdoM,
        distanceM: leg.distanceM,
        distanceSource: leg.distanceSource,
        concession: leg.concession,
        amount: leg.amount,
        tariffCode: leg.tariffCode,
        boardedAt: new Date(leg.boardAt * 1000).toISOString(),
        alightedAt: new Date(leg.alightAt * 1000).toISOString(),
        settledBy: body.devicePublicKey,
        receipt,
        fullAmount: Number.isFinite(fullPrice.amount) ? fullPrice.amount : leg.amount,
        issuerPublicKey,
      });
    }) });

    /*
      Does this receipt describe something a bus can do?

      After the settlement and never in front of it: every flag here has an
      honest cause — a diversion, a level crossing, a clear run down the ring
      road — so refusing a fare on one would mean a passenger's ride fails
      because their bus was rerouted. The money moves, the score is recorded,
      and an operator reads the rate rather than the incident.
    */
    const settledOk = legResults[legResults.length - 1]?.ok === true;
    if (settledOk && ledger.flagLeg) {
      const score = scoreLeg(leg, { route: null });
      if (!score.ok) {
        await attempt(() => ledger.flagLeg({ legId: leg.legId, plausibility: score.worst, flags: score.flags }));
      }
    }
  }

  // ------------------------------------------------------- dead-phone claims

  /*
    A claim against a ride that was charged the unclosed cap.

    Two checks before the money is touched, and they are in this order for a
    reason: the signature proves the claim came from the key the leg bills, and
    only then is the leg worth fetching. `file_dispute()` repeats the ownership
    check in SQL, because a leg id is printed on a receipt anyone can pick up.
  */
  const disputeResults = [];
  for (const text of disputes) {
    const verdict = verifyDispute(String(text ?? ''), { now });
    if (!verdict.ok) {
      disputeResults.push({ ok: false, legId: verdict.claim?.legId ?? null, reason: verdict.reason, message: verdict.message });
      continue;
    }
    const { claim } = verdict;
    disputeResults.push({ legId: claim.legId, ...await attempt(async () => {
      const leg = await ledger.settledLeg(claim.legId);
      const assessment = assessDispute(claim, leg, { priceFn: priceDistance });

      // A refused claim is still filed, so long as the leg is real and the
      // passenger's: the row is what an operator reads a pattern off, and what
      // stops the same claim being re-argued every time the phone syncs.
      if (!assessment.ok && ['unknown_leg', 'not_your_leg'].includes(assessment.reason)) {
        return { ok: false, legId: claim.legId, reason: assessment.reason, message: assessment.message };
      }
      const filed = await ledger.fileDispute({
        legId: claim.legId,
        passengerPublicKey: claim.passengerPublicKey,
        vehiclePlate: claim.vehicleId,
        claimNonce: claim.nonce,
        witnessM: claim.witnessM,
        witnessAt: new Date(claim.witnessAt * 1000).toISOString(),
        witnessLatMicro: claim.witnessLatMicro,
        witnessLonMicro: claim.witnessLonMicro,
        repricedNpr: assessment.ok ? assessment.amount : (assessment.repriced?.amount ?? 0),
        refundNpr: assessment.ok ? assessment.refund : 0,
        outcome: assessment.ok ? 'refunded' : assessment.reason,
        claim: String(text),
      });
      return assessment.ok ? filed : { ...filed, message: assessment.message };
    }) });
  }

  // ------------------------------------------------------------ cash tickets

  /*
    Fares paid to the conductor in cash. Verified like a receipt — the vehicle's
    key from the operator's record, never from the upload, and the tariff's
    price for the declared distance — and then only recorded: no wallet moves.
    What they change is what the crew owes the owner, and whether a trip's
    record covers the people its door counter saw.
  */
  const cashResults = [];
  if (cash.length > 0 && ledger.recordCashTicket) {
    for (const text of cash.slice(0, MAX_BATCH)) {
      const ticketText = String(text ?? '');
      const plate = ticketText.split('|')[1] ?? '';
      const vehicleKey = await keyFor(plate);
      if (!vehicleKey) {
        cashResults.push({ ok: false, reason: 'unknown_vehicle', message: `No meter key on file for ${plate}.` });
        continue;
      }
      const verdict = verifyCashTicket(ticketText, { vehiclePublicKey: vehicleKey, priceFn: priceDistance });
      if (!verdict.ok) {
        cashResults.push({ ok: false, ticketId: verdict.ticket?.ticketId, reason: verdict.reason, message: verdict.message });
        continue;
      }
      const { ticket } = verdict;
      cashResults.push(await attempt(() => ledger.recordCashTicket({
        ticketId: ticket.ticketId,
        vehiclePlate: ticket.vehicleId,
        tripId: ticket.tripId,
        doorId: ticket.doorId,
        fromStop: ticket.fromStop,
        toStop: ticket.toStop,
        distanceM: ticket.distanceM,
        amount: ticket.amount,
        tariffCode: ticket.tariffCode,
        issuedAt: new Date(ticket.issuedAt * 1000).toISOString(),
        ticket: ticketText,
      })));
    }
  }

  let doorEventsResult = null;
  let meterEventsResult = null;
  // --------------------------------------------------------------- door tape

  // Appended, never merged. The interlock record is only useful to a regulator
  // if it is the vehicle's own sequence of events rather than a summary someone
  // had the chance to tidy.
  if (Array.isArray(body.doorEvents) && body.doorEvents.length > 0 && hasMeter) {
    const events = body.doorEvents.slice(0, MAX_BATCH).map((event) => ({
      eventId: event.eventId ?? null,
      tripId: event.tripId ?? body.tripId ?? null,
      at: event.at ?? new Date(now * 1000).toISOString(),
      kind: event.kind ?? 'refused',
      door: event.door ?? null,
      onboard: event.onboard ?? null,
      capacity: event.capacity ?? null,
      note: event.note ?? null,
    }));
    doorEventsResult = await attempt(async () => {
      const result = await ledger.appendDoorEvents(events, { vehiclePlate: body.meter.vehicleId });
      return result ?? { ok: true };
    });
  }

  // ---------------------------------------------------------- the power tape

  // The same rule as the door tape, in a different book: door_events is the
  // interlock record a regulator reads, and a charger that went away is a fact
  // about the box rather than about a door.
  if (Array.isArray(body.meterEvents) && body.meterEvents.length > 0 && hasMeter && ledger.appendMeterEvents) {
    const events = body.meterEvents.slice(0, MAX_BATCH)
      .filter((event) => event.kind === 'power_lost' || event.kind === 'power_restored')
      .map((event) => ({
        eventId: event.eventId ?? null,
        tripId: event.tripId ?? body.tripId ?? null,
        at: event.at ?? new Date(now * 1000).toISOString(),
        kind: event.kind,
        moving: event.moving ?? null,
        note: event.note ?? null,
      }));
    if (events.length > 0) {
      meterEventsResult = await attempt(() => ledger.appendMeterEvents(events, { vehiclePlate: body.meter.vehicleId }));
    }
  }

  // --------------------------------------------------------- crew sign-on

  /*
    Who was working this trip, and consented to be credited for it.

    Verified here rather than at the console alone, because the console is
    offline and its word about a signature is the thing this file exists to stop
    taking. The vehicle is checked against the meter announcement in the same
    batch: a sign-on made out to another bus is not this bus's crew.
  */
  const crewResults = [];
  if (body.crew && typeof body.crew.signOn === 'string' && hasMeter && ledger.noteCrew) {
    const tripIds = Array.isArray(body.crew.tripIds) && body.crew.tripIds.length > 0
      ? body.crew.tripIds
      : [body.crew.tripId ?? body.tripId].filter(Boolean);
    // A shift, not a trip: one token covers every trip the crew member worked
    // between signing on and going home, which is why the window here is the
    // shift's and not the console's.
    const verdict = verifySignOn(body.crew.signOn, {
      vehicleId: body.meter.vehicleId,
      maxAgeS: SHIFT_MAX_AGE_S,
      now,
    });
    if (tripIds.length === 0) {
      crewResults.push({ ok: false, reason: 'no_trip', message: 'A sign-on has to name the trips it is for.' });
    } else if (!verdict.ok) {
      for (const tripId of tripIds) crewResults.push({ tripId, ok: false, reason: verdict.reason, message: verdict.message });
    } else {
      for (const tripId of tripIds.slice(0, MAX_BATCH)) {
        crewResults.push(await attempt(() => ledger.noteCrew({
          tripId,
          vehiclePlate: body.meter.vehicleId,
          crewPublicKey: verdict.signOn.crewPublicKey,
          signedOnAt: new Date(verdict.signOn.issuedAt * 1000).toISOString(),
          signOn: body.crew.signOn,
        })));
      }
    }
  }

  // --------------------------------------------------------- door counts

  /*
    How many bodies the door counter saw board, per trip. Recorded before any
    trip in this batch is judged, so a close and its count can travel together.
    Only the meter announces counts: it is the unit the counter is wired to.
  */
  const countResults = [];
  if (Array.isArray(body.tripCounts) && body.tripCounts.length > 0 && hasMeter && ledger.recordTripCount) {
    for (const entry of body.tripCounts.slice(0, MAX_BATCH)) {
      const counted = Number(entry?.counted);
      if (!entry?.tripId || !Number.isInteger(counted) || counted < 0) {
        countResults.push({ ok: false, tripId: entry?.tripId ?? null, reason: 'unreadable' });
        continue;
      }
      countResults.push(await attempt(() => ledger.recordTripCount({
        tripId: String(entry.tripId),
        vehiclePlate: body.meter.vehicleId,
        counted,
      })));
    }
  }

  // -------------------------------------------------------- closed trips

  /*
    The bonus.

    Counted by the ledger, judged here, paid by the ledger — the same division
    as a leg: what makes a trip clean is policy, and policy that lives in two
    languages eventually disagrees with itself.

    Closes arrive after the trip's legs because the device queues them that way
    and a batch settles its legs above. A leg that lands after the close is not
    counted toward the bonus and cannot reopen it: the award is once per trip,
    and a trip whose evidence keeps changing is not evidence.
  */
  const tripResults = [];
  if (Array.isArray(body.closedTrips) && body.closedTrips.length > 0 && ledger.tripEvidence && ledger.awardCleanTrip) {
    for (const tripId of body.closedTrips.slice(0, MAX_BATCH)) {
      if (!tripId) continue;
      const evidence = await attempt(() => ledger.tripEvidence(tripId));
      if (!evidence || evidence.ok === false) {
        tripResults.push({ tripId, ok: false, reason: evidence?.reason ?? 'server_error' });
        continue;
      }
      if (!evidence.crewPublicKey) {
        // Nobody signed on, so there is nobody to pay. Not a refusal: a trip run
        // without a crew sign-on is an ordinary trip that earns no bonus.
        tripResults.push({ tripId, ok: false, reason: 'no_crew' });
        continue;
      }
      const verdict = cleanTripVerdict(evidence);
      tripResults.push(await attempt(() => ledger.awardCleanTrip({
        tripId,
        vehiclePlate: evidence.vehiclePlate ?? body.meter?.vehicleId ?? null,
        crewPublicKey: evidence.crewPublicKey,
        amount: verdict.amount,
        legs: evidence.legs ?? 0,
        fares: evidence.fares ?? 0,
        reasons: verdict.reasons,
      })));
    }
  }

  const settled = results.filter((r) => r?.ok).length;
  const legsSettled = legResults.filter((r) => r?.ok).length;
  return [200, {
    settled,
    rejected: results.length - settled,
    legsSettled,
    legsRejected: legResults.length - legsSettled,
    legResults,
    tapResults,
    disputeResults,
    linkResults,
    accountResult,
    meterResult,
    doorEventsResult,
    meterEventsResult,
    crewResults,
    tripResults,
    cashResults,
    countResults,
    refunded: disputeResults.reduce((sum, r) => sum + (r?.refund ?? 0), 0),
    // Every ticket gets a verdict so the device knows exactly which rows to
    // mark settled and which to keep. A partial batch must never be retried
    // as a whole and re-counted.
    results,
  }];
}
