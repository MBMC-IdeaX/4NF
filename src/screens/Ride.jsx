// Passenger surface for the metered bus: a ride card, not a ticket.
//
// On a stage-fare bus the passenger prices their own ride before boarding. On a
// metered bus they cannot — nobody knows the distance until they get off — so
// this screen does three other things instead:
//
//   1. Shows the ride code. The passenger's own signature on "I am boarding
//      this bus, now", refreshed every half minute so a screenshot is worthless
//      by the time it reaches anyone else. It is the one thing the backend
//      needs from the passenger before it will charge them for anything.
//   2. Measures the ride itself. The phone is on the bus too, so it runs the
//      same odometer the bus runs, from its own receiver. The passenger is not
//      asked to trust the bus's kilometres — they get a second opinion from a
//      device they own.
//   3. Keeps the receipt. The door shows the signed receipt as a QR; this
//      screen reads it, re-does the arithmetic, and sets the bus's distance
//      beside the phone's. A disagreement is evidence, signed by the bus.
//
// None of it needs a network.

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { trustedBusKey, authenticateRecord } from '../device/receipt-auth';
import { loadIdentity, shortKey, companionKeys, noteCompanions, keyLinkFor, companionLinksFor } from '../device/identity';
import { db } from '../storage/db';
import { currentVehicle, plateFromId } from '../device/fleet';
import { fixFromPosition, holdScreenOn } from '../device/positioning';
import { nfcSupported, writeNfc } from '../device/nfc';
import Scanner from '../components/Scanner';
import { buildTap, signTap, decodeLeg, decodePass, toMicro, fromMicro, PASS_MAX_AGE_S, buildGroup } from '../../protocol/leg.mjs';
import { MAX_COMPANIONS } from '../../protocol/pseudonym.mjs';
import { buildDispute, signDispute } from '../../protocol/dispute.mjs';
import { initialOdometer, applyFix, odometerReading, priceDistance, TARIFFS, TARIFF, CURRENT_TARIFF, stageNear, stageName } from '../../protocol/meter.mjs';
import { rupees } from '../lib/nepali';

// The bus this device is provisioned for. A phone moved to another vehicle
// is re-provisioned, not rebuilt.
// The bus this device is provisioned for, read at the moment of use: a phone
// moved to another vehicle is re-provisioned, never rebuilt.
const vehicleId = () => currentVehicle().id;
const CODE_REFRESH_S = 30;
const RIDE_KEY = 'passengerRide';
const RECEIPTS_KEY = 'passengerReceipts';
const CLAIMS_KEY = 'passengerClaims';

async function loadRide() {
  const database = await db();
  return (await database.get('meter', RIDE_KEY)) ?? { phase: 'idle', state: 'ready' };
}

async function saveRide(ride) {
  const database = await db();
  await database.put('meter', ride, RIDE_KEY);
}

async function loadReceipts() {
  const database = await db();
  return (await database.get('meter', RECEIPTS_KEY)) ?? [];
}

/*
  A ride this phone opened and never closed.

  The pass is good for PASS_MAX_AGE_S; past that no door will take it and the
  bus has already charged the unclosed cap at the end of its trip. If the phone
  also stopped measuring well before that — the battery went — then there is a
  claim to make, and the witness reading is the evidence for it.
*/
export function strandedRide(ride, nowS = Math.floor(Date.now() / 1000)) {
  if (ride?.phase !== 'riding' || !ride.legId || !ride.vehicleId) return null;
  const startedAtS = Math.floor((ride.startedAt ?? 0) / 1000);
  if (!startedAtS || nowS - startedAtS <= PASS_MAX_AGE_S) return null;
  if (!Number.isFinite(ride.witnessAt) || !Number.isFinite(ride.witnessM)) return null;
  // The phone has to have gone quiet before the ride could have ended, or it
  // was alive at the door and the tap-out was simply skipped.
  if (ride.witnessAt - startedAtS < 0) return null;
  return {
    legId: ride.legId,
    vehicleId: ride.vehicleId,
    witnessM: Math.round(ride.witnessM),
    witnessAt: Math.round(ride.witnessAt),
    witnessLatMicro: Math.round(ride.witnessLatMicro ?? 0),
    witnessLonMicro: Math.round(ride.witnessLonMicro ?? 0),
  };
}

/*
  The bus's distance against the phone's. The tolerance is the meter's own
  (±2%, proven in `npm run proof:meter`) plus the phone's, with a floor for
  short rides where tens of metres are all either receiver can promise.
*/
export function compareDistances(busM, phoneM) {
  if (!Number.isFinite(phoneM) || phoneM < 100) {
    return { verdict: 'unmeasured', text: 'Your phone did not measure enough of this ride to compare.' };
  }
  const diff = busM - phoneM;
  const pct = (diff / phoneM) * 100;
  const tolerance = Math.max(80, phoneM * 0.04);
  if (Math.abs(diff) <= tolerance) {
    return { verdict: 'agree', pct, diff, text: `Agrees with your phone to within ${Math.abs(pct).toFixed(1)}%.` };
  }
  return {
    verdict: diff > 0 ? 'over' : 'under',
    pct,
    diff,
    text: diff > 0
      ? `The bus measured ${Math.round(diff)} m more than your phone did. Keep this receipt — it is signed by the bus, and it is your evidence.`
      : `The bus measured ${Math.round(-diff)} m less than your phone did. You were charged for less than you rode.`,
  };
}

export default function Ride({ onBack, onStageFare }) {
  const [identity, setIdentity] = useState(null);
  const [ride, setRide] = useState(null);
  const [code, setCode] = useState(null);
  // People riding on this wallet with the passenger: a parent with children,
  // someone with an elderly relative. 0 is the passenger alone.
  const [family, setFamily] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [scanning, setScanning] = useState(null); // 'pass' | 'receipt' | null
  const [receipt, setReceipt] = useState(null);   // the one just scanned
  const [history, setHistory] = useState([]);
  const [problem, setProblem] = useState(null);
  const [witness, setWitness] = useState({ metres: 0, doppler: null, fixes: 0 });
  const odoRef = useRef(null);

  useEffect(() => {
    trustedBusKey(vehicleId()).catch(() => {});
    loadIdentity().then(setIdentity).catch((error) => setProblem(error.message));
    loadRide().then((saved) => {
      setRide(saved);
      if (saved.phase === 'riding') setWitness((w) => ({ ...w, metres: saved.witnessM ?? 0 }));
    });
    const refresh = () => loadReceipts().then(setHistory);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  // The ride code. Re-signed every half minute: a tap is valid for five minutes, so the
  // code on screen is always fresh and a photographed one soon is not.
  const drawCode = useCallback(async () => {
    if (!identity) return;
    const active = await loadRide();
    if (active.phase !== 'riding') {
      const today = await loadIdentity();
      if (today.publicKey !== identity.publicKey) { setIdentity(today); return; }
    }
    const keys = active.phase === 'riding' && active.consentIdentity ? active.consentIdentity : identity;
    const sign = (keys) => signTap(buildTap({ passengerPublicKey: keys.publicKey, vehicleId: active.vehicleId ?? vehicleId(), doorId: 'ANY' }), keys.secretKey);
    // One code for the whole group: the passenger's own, then each
    // companion's, in a BG1 the door takes apart (protocol/leg.mjs).
    const own = sign(keys);
    const text = family > 0 ? buildGroup([own, ...companionKeys(keys, family).map(sign)]) : own;
    const image = await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M', margin: 1, width: 640, color: { dark: '#16130fff', light: '#ffffffff' },
    });
    setCode({ text, image, madeAt: Date.now(), family });
  }, [identity, family]);

  const changeFamily = useCallback((next) => {
    const n = Math.max(0, Math.min(MAX_COMPANIONS, next));
    setFamily(n);
    // Remembered, so the links that let these fares reach this wallet go up
    // with the next sync.
    if (n > 0) noteCompanions(n).catch(() => {});
  }, []);

  useEffect(() => {
    drawCode();
    const timer = setInterval(drawCode, CODE_REFRESH_S * 1000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); clearInterval(clock); };
  }, [drawCode]);

  /*
    Tap-and-go, where the phone has it.

    The QR stays on screen and stays the thing that works everywhere. This only
    offers the code over NFC as well, so a passenger with an Android handset can
    hold it against the door terminal instead of holding it up to be aimed at —
    a few hundred milliseconds against a second and a half, which is the
    difference between a queue that moves at Koteshwor and one that shoves.

    Re-offered whenever the code is re-signed, because a stale code in the radio
    is a code the door will refuse.
  */
  const [nfcState, setNfcState] = useState('idle'); // idle | offering | unsupported
  useEffect(() => {
    if (!nfcSupported()) { setNfcState('unsupported'); return undefined; }
    // Whichever the screen is showing: a pass closes a ride, a code opens one.
    const text = ride?.phase === 'riding' && ride?.passQr ? ride.passQr : code?.text;
    if (!text) return undefined;
    const controller = new AbortController();
    setNfcState('offering');
    writeNfc(text, { signal: controller.signal }).catch(() => setNfcState('idle'));
    return () => controller.abort();
  }, [code?.text, ride?.passQr]);

  // The pass, drawn for tapping out at a door that never saw this passenger
  // board — the offline path, and the reason the pass is worth keeping.
  const [passImage, setPassImage] = useState(null);
  useEffect(() => {
    if (!ride?.passQr) { setPassImage(null); return; }
    QRCode.toDataURL(ride.passQr, { errorCorrectionLevel: 'M', margin: 1, width: 640 }).then(setPassImage);
  }, [ride?.passQr]);

  // The phone's own odometer, while riding. Same protocol/meter.mjs as the bus.
  useEffect(() => {
    if (ride?.phase !== 'riding' || !navigator.geolocation) return undefined;
    odoRef.current = initialOdometer(ride.witnessM ?? 0);
    const release = holdScreenOn();
    let lastSaved = Date.now();
    const id = navigator.geolocation.watchPosition(
      (position) => {
        const fix = fixFromPosition(position);
        odoRef.current = applyFix(odoRef.current, fix).state;
        const metres = odometerReading(odoRef.current);
        const here = stageNear(CURRENT_TARIFF, fix);
        setWitness((w) => ({ metres, doppler: Number.isFinite(fix.speed), fixes: w.fixes + 1, stage: here ?? w.stage ?? null }));
        if (here) {
          loadRide().then((current) => {
            if (current.phase !== 'riding') return;
            const boardStage = current.boardStage ?? here;
            if (current.boardStage === boardStage && current.currentStage === here) return;
            saveRide({ ...current, boardStage, currentStage: here });
            setRide((r) => (r?.phase === 'riding' ? { ...r, boardStage, currentStage: here } : r));
          }).catch(() => {});
        }
        if (Date.now() - lastSaved > 10_000) {
          lastSaved = Date.now();
          // The time and place of the reading, not just the reading. A phone
          // that dies mid-ride leaves this behind as the last moment it can
          // prove it was aboard, and that is the whole of a claim's evidence.
          loadRide().then((current) => saveRide({
            ...current,
            witnessM: metres,
            witnessAt: Math.floor(fix.at / 1000),
            witnessLatMicro: toMicro(fix.lat),
            witnessLonMicro: toMicro(fix.lon),
          })).catch(() => {});
        }
      },
      () => setWitness((w) => ({ ...w, doppler: w.doppler ?? false })),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
    return () => {
      navigator.geolocation.clearWatch(id);
      release();
    };
  }, [ride?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startRiding(extra = {}) {
    const next = { phase: 'riding', state: extra.passQr ? 'riding' : 'awaiting_boarding_confirmation', startedAt: Date.now(), witnessM: 0, passengerPublicKey: identity.publicKey, consentIdentity: identity, ...extra };
    await saveRide(next);
    setWitness({ metres: 0, doppler: null, fixes: 0 });
    setRide(next);
  }

  async function onScan(text, injectedMode) {
    const mode = injectedMode ?? scanning;
    setScanning(null);
    setProblem(null);
    const trimmed = String(text).trim();

    if (mode === 'pass') {
      try {
        const { pass } = decodePass(trimmed);
        if (pass.passengerPublicKey !== (ride?.passengerPublicKey ?? identity.publicKey)) {
          setProblem('That pass belongs to someone else.');
          return;
        }
        const authentication = authenticateRecord(trimmed, pass, await trustedBusKey(pass.vehicleId), { passengerPublicKey: ride?.passengerPublicKey ?? identity.publicKey, vehicleId: ride?.vehicleId ?? vehicleId(), legId: ride?.legId });
        if (!authentication.ok) {
          if (authentication.reason === 'verification_pending') {
            const database = await db();
            const pending = (await database.get('meter', 'unverifiedBoardingPasses')) ?? [];
            await database.put('meter', [...pending.filter((row) => row.pass.legId !== pass.legId), { pass, qrText: trimmed, state: 'verification_pending' }], 'unverifiedBoardingPasses');
          }
          setProblem(authentication.reason === 'verification_pending' ? 'Boarding pass saved, verification pending. Connect once to cache the bus key, then scan again.' : 'Boarding pass verification failed.'); return;
        }
        // The pass carries the door's position at boarding: that is the stage.
        const passStage = stageNear(CURRENT_TARIFF, { lat: fromMicro(pass.boardLatMicro), lon: fromMicro(pass.boardLonMicro) });
        if (ride?.phase === 'riding') {
          const next = { ...ride, state: 'riding', passQr: trimmed, legId: pass.legId, vehicleId: pass.vehicleId, ...(passStage ? { boardStage: passStage } : {}) };
          await saveRide(next);
          setRide(next);
        } else {
          await startRiding({ passQr: trimmed, legId: pass.legId, vehicleId: pass.vehicleId, ...(passStage ? { boardStage: passStage } : {}) });
        }
      } catch {
        setProblem('That is not a Bhada boarding pass.');
      }
      return;
    }

    if (mode === 'receipt') {
      let leg;
      try {
        ({ leg } = decodeLeg(trimmed));
      } catch {
        setProblem('That is not a Bhada receipt.');
        return;
      }
      if (leg.passengerPublicKey !== (ride?.passengerPublicKey ?? identity.publicKey)) {
        setProblem('That receipt is for someone else.');
        return;
      }
      const authentication = authenticateRecord(trimmed, leg, await trustedBusKey(leg.vehicleId), { passengerPublicKey: ride?.passengerPublicKey ?? identity.publicKey, vehicleId: ride?.vehicleId ?? vehicleId(), legId: ride?.legId });
      if (!authentication.ok && authentication.reason !== 'verification_pending' && authentication.reason !== 'unsupported_tariff') { setProblem('Receipt verification failed. Keep the active ride and ask the crew to scan again.'); return; }
      // Re-priced with the tariff the receipt names, never today's: tariffs are
      // added, not edited, and an old receipt is judged by its own.
      const repriced = TARIFFS[leg.tariffCode] ? priceDistance(leg.distanceM, { concession: leg.concession, tariffCode: leg.tariffCode, boardStage: leg.boardStage, alightStage: leg.alightStage, unclosed: leg.distanceSource === 'unclosed' }) : { amount: null, breakdown: [] };
      const phoneM = ride?.phase === 'riding' ? witness.metres : null;
      const entry = {
        legId: leg.legId,
        at: Date.now(),
        receipt: trimmed,
        leg,
        breakdown: repriced.breakdown,
        arithmeticOk: repriced.amount === leg.amount,
        state: authentication.ok ? 'awaiting_reconciliation' : 'review_required',
        recordState: 'exit_receipt_saved',
        keyLinks: [keyLinkFor(ride?.consentIdentity ?? identity), ...companionLinksFor(ride?.consentIdentity ?? identity)].filter(Boolean),
        verification: authentication.reason ?? (authentication.ok ? 'verified' : 'review_required'),
        phoneM,
        phoneDoppler: witness.doppler,
      };
      const database = await db();
      const tx = database.transaction('meter', 'readwrite');
      const saved = (await tx.store.get(RECEIPTS_KEY)) ?? [];
      const next = [entry, ...saved.filter((h) => h.legId !== leg.legId)];
      await tx.store.put(next, RECEIPTS_KEY);
      const nextRide = authentication.ok ? { phase: 'idle', state: 'awaiting_reconciliation', completedLegId: leg.legId } : { ...ride, pendingCompletion: leg.legId };
      await tx.store.put(nextRide, RIDE_KEY);
      await tx.done;
      setHistory(next);
      setRide(nextRide);
      setReceipt(entry);
    }
  }

  // The camera restarts whenever its callback changes, and this screen redraws
  // every second for the countdown. One stable callback, pointing at the latest.
  const scanRef = useRef(onScan);
  scanRef.current = onScan;
  const stableScan = useCallback((text) => scanRef.current(text), []);
  useEffect(() => {
    // Explicit local browser fixture only; omitted from normal app builds.
    if (import.meta.env.VITE_BROWSER_TESTS !== '1' || location.hostname !== 'localhost') return;
    const scan = (event) => scanRef.current(event.detail.text, event.detail.mode);
    window.addEventListener('bhada:test-scan', scan);
    return () => window.removeEventListener('bhada:test-scan', scan);
  }, []);

  async function endWithoutReceipt() {
    const database = await db();
    const abandoned = (await database.get('meter', 'unfinishedPassengerRides')) ?? [];
    await database.put('meter', [...abandoned, { ...ride, endedAt: Date.now() }], 'unfinishedPassengerRides');
    await saveRide({ phase: 'idle' });
    setRide({ phase: 'idle' });
  }

  /*
    File the claim for a ride that ended with a dead phone.

    Signed here and queued here, because the phone that is making the claim is
    by definition one that has been off a network. It goes up with the next
    sync and the refund lands in the wallet; nothing about this needs the
    passenger to be online while they do it.
  */
  async function claimStranded() {
    const stranded = strandedRide(ride);
    if (!stranded || !identity) return;
    const claim = signDispute(
      buildDispute({
        passengerPublicKey: ride.consentIdentity?.publicKey ?? identity.publicKey,
        vehicleId: stranded.vehicleId,
        legId: stranded.legId,
        witnessM: stranded.witnessM,
        witnessAt: stranded.witnessAt,
        witnessLatMicro: stranded.witnessLatMicro,
        witnessLonMicro: stranded.witnessLonMicro,
      }),
      ride.consentIdentity?.secretKey ?? identity.secretKey,
    );
    const database = await db();
    const queued = (await database.get('meter', CLAIMS_KEY)) ?? [];
    await database.put(
      'meter',
      [{ legId: stranded.legId, claim, at: Date.now(), sent: 0 }, ...queued.filter((c) => c.legId !== stranded.legId)],
      CLAIMS_KEY,
    );
    await saveRide({ phase: 'idle' });
    setRide({ phase: 'idle' });
    setProblem('Claim saved. It goes up the next time this phone finds a network, and the refund lands in your balance.');
  }

  if (!identity || !ride) {
    return (
      <div className="stub-page">
        <div className="stub">
          <p className="stub__empty">{problem ?? 'Opening your ride card.'}</p>
        </div>
      </div>
    );
  }

  if (receipt) {
    return <ReceiptView entry={history.find((row) => row.legId === receipt.legId) ?? receipt} onDone={() => setReceipt(null)} />;
  }

  const riding = ride.phase === 'riding';
  const stranded = strandedRide(ride, Math.floor(now / 1000));
  const strandedFare = stranded ? priceDistance(stranded.witnessM) : null;
  const freshFor = code ? Math.max(0, CODE_REFRESH_S - Math.floor((now - code.madeAt) / 1000)) : 0;
  // The fare so far is the stage fare from the boarding stage to the stage the
  // bus is at now. It changes when the stage changes, not with every metre.
  const boardStage = ride.boardStage ?? null;
  const currentStage = witness.stage ?? ride.currentStage ?? null;
  const soFar = boardStage && currentStage
    ? priceDistance(witness.metres, { tariff: CURRENT_TARIFF, boardStage, alightStage: currentStage })
    : null;
  const stageLabel = (code) => stageName(CURRENT_TARIFF, code)?.en ?? '—';
  // Riding with a pass: show the pass to get off, because a pass closes the
  // ride at any door, online or not. Otherwise the ride code does both.
  const showPass = riding && passImage;

  return (
    <div className="stub-page">
      <div className="stub">
        <div className="stub__head">
          <div className="stub__wordmark">भाडा Bhada</div>
          <div className="stub__serial tabular">{shortKey(identity.publicKey)}</div>
        </div>

        <div className="ride__status">
          {riding ? (
            <>
              <b><i className="ride__live" aria-hidden="true" />यात्रामा · {ride.passQr ? 'On ride - boarding confirmed' : 'Measuring locally - awaiting boarding confirmation'}</b>
              <span>Since {new Date(ride.startedAt ?? now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · {Math.max(0, Math.floor((now - (ride.startedAt ?? now)) / 60000))} min. Show the code below when you get off.</span>
            </>
          ) : (
            <>
              <b>चढ्दा देखाउनुहोस्</b>
              <span>Show this at the door when you get on.</span>
            </>
          )}
        </div>

        {riding ? (
          <div className="ride__witness">
            <dl className="ride__stages">
              <div><dt>Boarded</dt><dd>{boardStage ? stageLabel(boardStage) : 'Finding your stage…'}</dd></div>
              <div><dt>Now at</dt><dd>{currentStage ? stageLabel(currentStage) : '—'}</dd></div>
            </dl>
            <div>
              <small>Fare so far</small>
              <b className="tabular ride__fare">{soFar ? rupees(soFar.amount) : '—'}</b>
            </div>
            <div>
              <small>Journey</small>
              <b className="tabular ride__km">{(witness.metres / 1000).toFixed(1)}<span>km</span></b>
            </div>
            <p>
              {witness.doppler === null
                ? 'Waiting for your phone’s GPS. Keep this screen open.'
                : soFar
                  ? `Stage fare ${soFar.fareRule.toLowerCase()} on the route\u2019s fare table. The door works out the final fare from the stage you get off at.`
                  : 'Your phone is not near a stage on this route yet. The door still prices the ride from its own GPS.'}
              {' '}{typeof navigator !== 'undefined' && !navigator.onLine ? 'Offline — the ride continues normally.' : ''}
            </p>
          </div>
        ) : null}

        <div className="perf" />

        <div className="stub__window">
          {showPass ? (
            <img src={passImage} alt="Your boarding pass" />
          ) : code ? (
            <img src={code.image} alt="Your ride code" />
          ) : (
            <p className="stub__empty">Signing your ride code.</p>
          )}
          <p className="ride__caption tabular">
            {showPass
              ? `Boarding pass ${ride.legId}. Works at any door, signal or not.`
              : `${family > 0 ? `One code for ${family + 1} people · ` : ''}Renews in ${freshFor} s`}
          </p>

          {!showPass && code ? (
            <div className="ride__fresh" aria-hidden="true">
              <i style={{ width: `${(freshFor / CODE_REFRESH_S) * 100}%` }} />
            </div>
          ) : null}

          <details className="ride__security">
            <summary>Secure ride code · works without internet</summary>
            <p>
              The code is signed by a key that never leaves this phone, and a new one is made every {CODE_REFRESH_S} seconds.
              A door accepts each code once and only for a few minutes, so a screenshot passed to someone else is refused.
              Nothing is charged when you get on — the fare is worked out from the distance when you get off.
            </p>
          </details>

          {showPass ? null : (
            <div className="ride__family" role="group" aria-label="People on this code">
              <button type="button" onClick={() => changeFamily(family - 1)} disabled={family === 0} aria-label="One fewer">−</button>
              <span>
                <b className="tabular">{family === 0 ? 'Just me' : `Me + ${family}`}</b>
                <small>{family === 0 ? 'Paying for family? Add them.' : 'Each fare is charged to your account'}</small>
              </span>
              <button type="button" onClick={() => changeFamily(family + 1)} disabled={family === MAX_COMPANIONS} aria-label="One more">+</button>
            </div>
          )}
          {nfcState === 'offering' ? (
            <p className="ride__caption">Or hold your phone against the door reader — no aiming needed.</p>
          ) : null}
        </div>

        <div className="perf" />

        {riding ? null : (
          <div className="ride__tariff">
            <div className="ride__tariff-row">
              <span>To the next stage</span>
              <b className="tabular">{rupees(CURRENT_TARIFF.boardingCharge)}</b>
            </div>
            <div className="ride__tariff-row">
              <span>Each stage after that</span>
              <b className="tabular">+{rupees(5)}</b>
            </div>
            <div className="ride__tariff-row">
              <span>Never more than</span>
              <b className="tabular">{rupees(CURRENT_TARIFF.cap)}</b>
            </div>
            <p>
              Your fare is the stage fare from where you get on to where you get off. The bus&rsquo;s GPS works out both
              stages, so nobody has to guess. Students and seniors pay half.
              {CURRENT_TARIFF.demo ? ' This is a demo fare table, not the published one.' : ''}
            </p>
          </div>
        )}

        {history.length > 0 && !riding ? <History history={history} onOpen={setReceipt} /> : null}
      </div>

      {problem ? <p className="notice">{problem}</p> : null}

      {stranded ? (
        <div className="ride__claim">
          <b>This ride never closed</b>
          <p>
            Your pass for ride {stranded.legId} has expired, so the bus charged the {rupees(TARIFF.unclosedLegFare)} cap
            for a ride nobody tapped out of. Your phone measured {(stranded.witnessM / 1000).toFixed(2)} km before it
            stopped recording — {rupees(strandedFare.amount)} at the ordinary fare.
          </p>
          <p>
            Claiming sends that reading, signed by this phone, and asks for the difference back. It is checked against
            the bus&rsquo;s own record of the ride, and it can only ever return what you were overcharged.
          </p>
        </div>
      ) : null}

      {stranded ? (
        <>
          <button type="button" className="action" onClick={claimStranded}>
            {rupees(TARIFF.unclosedLegFare - strandedFare.amount)} फिर्ता माग्नुहोस्
            <small>Claim the difference — my phone died before I got off</small>
          </button>
          <button type="button" className="action action--quiet" onClick={endWithoutReceipt}>
            Leave it. I did ride that far.
          </button>
        </>
      ) : riding ? (
        <>
          <button type="button" className="action" onClick={() => setScanning('receipt')}>
            यात्रा सकियो
            <small>Finish ride — scan the receipt on the door screen</small>
          </button>
          {!ride.passQr ? (
            <button type="button" className="action action--quiet" onClick={() => setScanning('pass')}>
              Keep my boarding pass (for doors with no signal)
            </button>
          ) : null}
          <button type="button" className="action action--quiet" onClick={endWithoutReceipt}>
            End ride without a receipt
          </button>
        </>
      ) : (
        <>
          <button type="button" className="action" onClick={() => startRiding()}>
            म चढें
            <small>I’m on — start measuring with my phone</small>
          </button>
          <button type="button" className="action action--quiet" onClick={() => setScanning('pass')}>
            Scan my boarding pass from the door
          </button>
        </>
      )}
      <button type="button" className="action action--quiet" onClick={onStageFare}>
        Pay a fixed stage fare instead
      </button>
      <button type="button" className="action action--quiet" onClick={onBack}>
        Back to home
      </button>

      {scanning ? (
        <Scanner
          label={scanning === 'pass' ? 'Point at the boarding pass on the door screen' : 'Point at the receipt on the door screen'}
          onText={stableScan}
          onClose={() => setScanning(null)}
        />
      ) : null}
    </div>
  );
}

function ReceiptView({ entry, onDone }) {
  const { leg } = entry;
  const comparison = compareDistances(leg.distanceM, entry.phoneM);
  const repriced = TARIFFS[leg.tariffCode] ? priceDistance(leg.distanceM, { concession: leg.concession, tariffCode: leg.tariffCode, boardStage: leg.boardStage, alightStage: leg.alightStage, unclosed: leg.distanceSource === 'unclosed' }) : { amount: null, breakdown: [] };
  const arithmeticOk = repriced.amount === leg.amount;
  const plate = plateFromId(leg.vehicleId);
  const board = leg.boardAt ? new Date(leg.boardAt * 1000) : null;
  const alight = new Date(leg.alightAt * 1000);
  const hm = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="stub-page">
      <div className="stub">
        <div className="stub__head">
          <div className="stub__wordmark">भाडा Bhada</div>
          <div className="stub__serial tabular">{alight.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        </div>

        <div className="ride__done">
          <b><i aria-hidden="true">✓</i> यात्रा सकियो · Ride completed</b>
          <span>
            {plate ? `Bus ${plate.province} ${plate.number} ${plate.series} ${plate.digits}` : `Vehicle ${leg.vehicleId}`} · {board ? `${hm(board)} → ${hm(alight)}` : `off at ${hm(alight)}`}
          </span>
        </div>

        {leg.boardStage ? (
          <dl className="ride__stages ride__stages--receipt">
            <div><dt>Boarded</dt><dd>{stageName(TARIFFS[leg.tariffCode] ?? {}, leg.boardStage)?.en ?? leg.boardStage}</dd></div>
            <div><dt>Got off</dt><dd>{stageName(TARIFFS[leg.tariffCode] ?? {}, leg.alightStage)?.en ?? leg.alightStage}</dd></div>
          </dl>
        ) : null}
        <div className="ride__final">
          <div>
            <small>Final fare</small>
            <b className="tabular">{rupees(leg.amount)}</b>
          </div>
          <div>
            <small>Journey</small>
            <b className="tabular">{(leg.distanceM / 1000).toFixed(1)}<span>km</span></b>
          </div>
        </div>
        <p className="ride__basis">
          {leg.boardStage
            ? `Fare basis: stage fare, ${repriced.fareRule ?? 'stage to stage'}${repriced.demo ? ' (demo fare table)' : ''}`
            : 'Fare basis: distance tariff (issued before stage fares, or without a GPS stage)'}
          {leg.concession && leg.concession !== 'none' ? `, ${leg.concession} rate` : ''}
        </p>

        <div className="ride__states">
          <span className={`ride__state ride__state--${entry.verification === 'verified' && arithmeticOk ? 'ok' : 'bad'}`}>
            {entry.verification === 'verified' && arithmeticOk ? 'Ride verified' : 'Verification pending / review required'}
          </span>
          <span className="ride__state ride__state--wait">{entry.ledgerState === 'settled' ? 'Ledger settled' : entry.ledgerState === 'unpaid' ? 'Unpaid fare' : 'Awaiting reconciliation'}</span>
        </div>
        <p className="ride__basis">
          Signed receipt saved offline on this phone. The fare is taken from your balance when the bus syncs;
          your statement in Account shows it once it has. A ledger result does not confirm an external payment transfer.
        </p>
        {comparison.verdict === 'over' || comparison.verdict === 'under' ? (
          <p className="ride__basis ride__basis--warn">{comparison.text}</p>
        ) : null}

        <details className="ride__security">
          <summary>Fare breakdown and security details</summary>
          <p className="tabular">Ride {leg.legId}</p>
        <ul className="ride__lines">
          {(entry.breakdown ?? repriced.breakdown).map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <b className="tabular">{item.value}</b>
            </li>
          ))}
          <li className="ride__total">
            <span>Charged</span>
            <b className="tabular">{rupees(leg.amount)}</b>
          </li>
        </ul>

        <div className="perf" />

        <div className={`ride__compare ride__compare--${comparison.verdict}`}>
          <div className="ride__pair">
            <div>
              <small>The bus</small>
              <b className="tabular">{(leg.distanceM / 1000).toFixed(2)} km</b>
            </div>
            <div>
              <small>Your phone</small>
              <b className="tabular">{Number.isFinite(entry.phoneM) ? `${(entry.phoneM / 1000).toFixed(2)} km` : 'not measured'}</b>
            </div>
          </div>
          <p>{comparison.text}</p>
        </div>

        <div className="ride__checks">
          <p>{arithmeticOk ? 'The arithmetic on this receipt checks out against the published tariff.' : 'The arithmetic on this receipt does NOT match the published tariff. The office will refuse it too.'}</p>
          <p>
            Signed by vehicle {leg.vehicleId}. It is charged to your account only together with the ride code you
            showed when you got on — nobody can charge you for a ride without it.
          </p>
        </div>
        </details>
      </div>
      <button type="button" className="action" onClick={onDone}>ठीक छ<small>Done</small></button>
    </div>
  );
}

function History({ history, onOpen }) {
  return (
    <div className="ride__history">
      <div className="punch__label">Your last rides</div>
      <ul>
        {history.slice(0, 4).map((h) => {
          const c = compareDistances(h.leg.distanceM, h.phoneM);
          return (
            <li key={h.legId}>
              <button type="button" onClick={() => onOpen(h)}>
                <span className="tabular">{(h.leg.distanceM / 1000).toFixed(2)} km</span>
                <span className="tabular">{rupees(h.leg.amount)}</span>
                <small>{c.verdict === 'agree' ? 'matches your phone' : c.verdict === 'unmeasured' ? 'phone did not measure' : 'differs from your phone'}</small>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
