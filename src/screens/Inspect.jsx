// /inspect — a fare inspector's phone.
//
// Works with no signal once the register has been downloaded. Three steps, all
// with the camera: scan the bus's inspection code off the meter (RS1, signed
// with the vehicle key), count heads, then scan passengers' ride codes one after
// another. Each comes back ON RECORD or NOT ON RECORD in letters large enough to
// show the passenger. Every check is protocol/inspect.mjs; nothing here decides.

import { useCallback, useEffect, useState } from 'react';
import Scanner from '../components/Scanner';
import { verifyRoster, checkRider, tallyInspection } from '../../protocol/inspect.mjs';
import { splitGroup } from '../../protocol/leg.mjs';
import { installRandomSource } from '../device/identity';
import { navigate } from '../lib/router';
import '../styles/inspect.css';

const REGISTER_KEY = 'bhada.vehicleRegister';

function loadRegister() {
  try {
    return JSON.parse(localStorage.getItem(REGISTER_KEY) ?? 'null');
  } catch {
    return null;
  }
}

const REASON = {
  not_recorded: 'No ride on this bus',
  replay: 'Code already used — ask for a fresh one',
  stale: 'Old code — ask for a fresh one',
  wrong_vehicle: 'Code for another bus',
  bad_signature: 'Code not signed by that phone',
  unreadable: 'Not a ride code',
};

export default function Inspect() {
  const [register, setRegister] = useState(loadRegister);
  const [syncing, setSyncing] = useState(false);
  const [problem, setProblem] = useState(null);
  const [roster, setRoster] = useState(null);
  const [scanning, setScanning] = useState(null); // 'roster' | 'rider'
  const [checks, setChecks] = useState([]);
  const [heads, setHeads] = useState(0);
  const [seen] = useState(() => new Set());

  useEffect(() => { installRandomSource(); }, []);

  // The register of bus keys, while there is signal. Kept on the phone after.
  const syncRegister = useCallback(async () => {
    setSyncing(true);
    setProblem(null);
    try {
      const { supabase, supabaseConfigured } = await import('../lib/supabase');
      if (!supabaseConfigured) throw new Error('No backend configured.');
      const { data, error } = await supabase.rpc('vehicle_public_keys');
      if (error) throw new Error(error.message);
      const next = { at: Date.now(), keys: Object.fromEntries((data ?? []).map((v) => [v.plate, v.publicKey])) };
      localStorage.setItem(REGISTER_KEY, JSON.stringify(next));
      setRegister(next);
    } catch (error) {
      setProblem(`Could not update the register: ${error.message}`);
    }
    setSyncing(false);
  }, []);

  const onScan = useCallback((text) => {
    setScanning(null);
    const trimmed = String(text ?? '').trim();
    if (scanning === 'roster' || trimmed.startsWith('RS1|')) {
      const plate = trimmed.split('|')[1] ?? '';
      const verdict = verifyRoster(trimmed, { vehiclePublicKey: register?.keys?.[plate] ?? null });
      if (!verdict.ok) {
        setProblem(verdict.message);
        return;
      }
      setProblem(null);
      setRoster(verdict.roster);
      setChecks([]);
      setHeads(0);
      return;
    }
    if (!roster) {
      setProblem('Scan the bus’s inspection code first.');
      return;
    }
    // A family shows one code for several people; each is checked.
    const codes = splitGroup(trimmed) ?? [trimmed];
    const results = codes.map((code) => {
      const result = checkRider(roster, code, { seenNonces: seen });
      if (result.tap?.nonce) seen.add(result.tap.nonce);
      return { at: Date.now(), result, key: result.tap?.passengerPublicKey?.slice(0, 6) ?? '—' };
    });
    setChecks((list) => [...results.reverse(), ...list]);
  }, [register, roster, scanning, seen]);

  const tally = roster ? tallyInspection(roster, heads) : null;
  const latest = checks[0]?.result ?? null;
  const onRecord = checks.filter((c) => c.result.ok).length;
  const notOnRecord = checks.filter((c) => c.result.reason === 'not_recorded').length;
  const plates = register ? Object.keys(register.keys).length : 0;

  return (
    <div className="insp">
      <header className="insp__head">
        <button type="button" className="insp__back" onClick={() => navigate('/')}>←</button>
        <div>
          <b>निरीक्षण</b>
          <span>Fare inspection</span>
        </div>
        <button type="button" className="insp__sync" onClick={syncRegister} disabled={syncing}>
          {syncing ? 'Updating…' : register ? `Register: ${plates} buses` : 'Download register'}
          <small>{register ? `updated ${new Date(register.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'needs signal once'}</small>
        </button>
      </header>

      {problem ? <p className="insp__problem" role="alert">{problem}</p> : null}

      {!roster ? (
        <section className="insp__step">
          <h1>1. Scan the bus</h1>
          <p>
            On the meter console, press <b>Inspection code</b>. It lists who has a ride open, signed by
            the bus, and is checked against the register on this phone — not against anything the bus says.
          </p>
          <button type="button" className="insp__go" onClick={() => setScanning('roster')} disabled={!register}>
            {register ? 'Scan the inspection code' : 'Download the register first'}
          </button>
        </section>
      ) : (
        <>
          <section className="insp__bus">
            <div><small>Bus</small><b>{roster.vehicleId}</b></div>
            <div><small>Rides open</small><b className="tabular">{roster.prefixes.length}</b></div>
            <div><small>Cash tickets</small><b className="tabular">{roster.cash}</b></div>
            <div><small>Door count</small><b className="tabular">{roster.counted ?? '—'}</b></div>
          </section>

          <section className="insp__heads">
            <span>
              <small>2. Heads you counted</small>
              <b className="tabular">{heads}</b>
            </span>
            <button type="button" onClick={() => setHeads((n) => Math.max(0, n - 1))} aria-label="One fewer">−</button>
            <button type="button" onClick={() => setHeads((n) => n + 1)} aria-label="One more">+</button>
            <button type="button" onClick={() => setHeads((n) => n + 5)} aria-label="Five more">+5</button>
          </section>

          {tally && heads > 0 ? (
            <p className={`insp__tally${tally.unrecorded > 0 ? ' is-short' : ''}`}>
              {tally.recorded} on the record ({tally.rides} rides + {tally.cash} cash) · {heads} counted ·{' '}
              <b>{tally.unrecorded > 0 ? `${tally.unrecorded} not on the record` : 'everyone accounted for'}</b>
            </p>
          ) : null}

          <section className={`insp__verdict insp__verdict--${!latest ? 'idle' : latest.ok ? 'ok' : latest.reason === 'not_recorded' ? 'no' : 'warn'}`}>
            <strong>{!latest ? '3. Scan a passenger' : latest.ok ? 'ON RECORD' : latest.reason === 'not_recorded' ? 'NOT ON RECORD' : 'CHECK AGAIN'}</strong>
            <span>{!latest ? 'Their live ride code, the one they show at the door.' : latest.ok ? 'This passenger has a ride open on this bus.' : REASON[latest.reason] ?? latest.message}</span>
            <button type="button" className="insp__go" onClick={() => setScanning('rider')}>Scan a passenger</button>
          </section>

          <p className="insp__count tabular">{onRecord} on record · {notOnRecord} not on record</p>
          <ol className="insp__list">
            {checks.map((c) => (
              <li key={`${c.at}-${c.key}`} className={c.result.ok ? 'is-ok' : c.result.reason === 'not_recorded' ? 'is-no' : 'is-warn'}>
                <b>{c.result.ok ? 'ON RECORD' : c.result.reason === 'not_recorded' ? 'NOT ON RECORD' : 'CHECK AGAIN'}</b>
                <span className="tabular">{c.key}… · {new Date(c.at).toLocaleTimeString('en-GB')}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="insp__again" onClick={() => setScanning('roster')}>Next stop: scan a fresh inspection code</button>
        </>
      )}

      {scanning ? (
        <Scanner
          label={scanning === 'roster' ? 'The meter’s inspection code' : 'The passenger’s ride code'}
          onText={onScan}
          onClose={() => setScanning(null)}
        />
      ) : null}
    </div>
  );
}
