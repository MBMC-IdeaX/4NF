// Signing on for a shift, from the conductor's own phone.
//
// There is no employee record in Bhada and this screen does not create one. A
// conductor holds an ordinary wallet — the same one they ride on — and the
// sign-on is a CR1 their phone signs: their key, the bus, the minute. The meter
// console reads it, and every trip the shift covers is credited to that key when
// it comes up clean.
//
// It is the mirror of the passenger's ride code, down to the refresh: a tap is
// consent to be charged and this is consent to be credited, so both are
// re-signed while they are on screen and a photograph of either goes stale.

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { loadIdentity, installRandomSource, shortKey } from '../device/identity';
import { buildSignOn, signSignOn, SIGNON_MAX_AGE_S } from '../../protocol/crew.mjs';
import { CLEAN_TRIP_BONUS_NPR } from '../../protocol/policy.mjs';
import { currentVehicle } from '../device/fleet';
import { navigate } from '../lib/router';
import { meter } from '../device/meter';

// Well inside the console's five-minute window, so what is on screen is always
// something the meter will take.
const REFRESH_S = 60;

export default function Crew() {
  const [identity, setIdentity] = useState(null);
  const [plate, setPlate] = useState(() => currentVehicle().id);
  const [code, setCode] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    installRandomSource();
    loadIdentity().then(setIdentity);
  }, []);

  const draw = useCallback(async () => {
    if (!identity || !plate.trim()) return;
    try {
      const text = signSignOn(
        buildSignOn({ crewPublicKey: identity.publicKey, vehicleId: plate.trim() }),
        identity.secretKey,
      );
      const image = await QRCode.toDataURL(text, {
        errorCorrectionLevel: 'M', margin: 1, width: 640, color: { dark: '#16130fff', light: '#ffffffff' },
      });
      setCode({ text, image, madeAt: Date.now() });
      setError(null);
    } catch (problem) {
      setCode(null);
      setError(problem.message);
    }
  }, [identity, plate]);

  useEffect(() => {
    draw();
    const timer = setInterval(draw, REFRESH_S * 1000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); clearInterval(clock); };
  }, [draw]);

  // On the Crew app this phone is the meter too, so signing on is one tap:
  // the same signed CR1, handed to the meter here instead of to a camera.
  const [here, setHere] = useState(null);
  async function signOnHere() {
    if (!code) return;
    const unit = meter();
    await unit.boot();
    const verdict = await unit.signOnCrew(code.text);
    setHere(verdict?.ok ? { ok: true } : { ok: false, text: verdict?.message ?? 'This bus could not take the sign-on.' });
  }

  const ageS = code ? Math.floor((now - code.madeAt) / 1000) : 0;
  const leftS = Math.max(0, SIGNON_MAX_AGE_S - ageS);

  return (
    <div className="screen crew">
      <header className="crew__head">
        <h1>सिफ्ट सुरु · Start your shift<span>Sign on so a clean trip pays you the bonus</span></h1>
      </header>

      <label className="crew__plate">
        Bus
        <input
          value={plate}
          onChange={(event) => setPlate(event.target.value.trim().toUpperCase())}
          placeholder="BA2KHA4412"
          aria-label="Vehicle plate"
        />
      </label>

      {code ? (
        <>
          <button type="button" className="crew__here" onClick={signOnHere}>
            {here?.ok ? '✓ साइन इन भयो · Signed on' : 'यो बसमा साइन इन · Sign on to this bus'}
          </button>
          {here && !here.ok ? <p className="crew__empty">{here.text}</p> : null}
          <p className="crew__or">Another phone is the meter? Show it this code instead:</p>
          <img className="crew__qr" src={code.image} alt="Crew sign-on code" />
          <p className="crew__age tabular">Fresh for {leftS}s. Show this to the meter console.</p>
          <p className="crew__key">Signing on as {shortKey(identity?.publicKey)}</p>
        </>
      ) : (
        <p className="crew__empty">{error ?? 'Naming the bus makes the code.'}</p>
      )}

      <p className="crew__note">
        A trip that carried passengers, kept its power, never overrode the door interlock and metered
        nothing impossible pays Rs&nbsp;{CLEAN_TRIP_BONUS_NPR} into this wallet. One sign-on covers the
        whole shift — you do not scan again at every terminus.
      </p>
    </div>
  );
}
