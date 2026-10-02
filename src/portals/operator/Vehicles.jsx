// Buses and routes.
//
// A plate is the vehicle id inside every fare token and receipt, so
// registering a bus here is what makes a fare from that bus settle rather than
// bounce. The form asks for the plate the way it is painted — zone, lot,
// series, number — and spells the token form itself, so nobody has to know
// that बा २ ख ४४१२ travels as BA2KHA4412.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import BusLoader from '../../components/BusLoader';
import Plate from '../shared/Plate.jsx';
import { SERIES, ZONES, composePlate, isValidPlate, plateEn } from '../shared/plates';
import { toDevanagari } from '../../lib/nepali';
import { timeAgo } from '../shared/format';

const STALE_HOURS = 24;

export default function Vehicles({ operator, onChange }) {
  const [rows, setRows] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const [vehicles, directory] = await Promise.all([
      supabase.from('operator_vehicles').select('*').order('plate'),
      supabase.from('route_directory').select('*').order('name_en'),
    ]);
    if (vehicles.error) setError(vehicles.error.message);
    setRows(vehicles.data ?? []);
    // A backend from before migration 0020 has routes but no directory.
    if (directory.error) {
      const plain = await supabase.from('routes').select('*').order('name_en');
      setRoutes((plain.data ?? []).map((r) => ({ ...r, stops: null, via: null })));
    } else {
      setRoutes(directory.data ?? []);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const routeById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);

  if (rows === null) return <BusLoader label="बस खोज्दै" sub="Loading your fleet" />;

  const reporting = rows.filter((v) => v.last_sync && hoursSince(v.last_sync) < STALE_HOURS).length;

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>बसहरू</h1>
          <p>
            {rows.length === 0
              ? 'Register your first bus to start collecting fares.'
              : `${rows.length} ${rows.length === 1 ? 'bus' : 'buses'} registered, ${reporting} reported in the last ${STALE_HOURS} hours.`}
          </p>
        </div>
      </div>

      {error ? <p className="op-error" role="alert">{error}</p> : null}

      <div className="op-grid op-fleet-layout">
          <section className="op-section op-area-fleet">
            <div className="op-section__head">
              <h2>
                तपाईंको फ्लिट
                <small>Your fleet, and when each bus last reported</small>
              </h2>
            </div>
            {rows.length === 0 ? (
              <div className="op-empty">
                <b>No buses yet</b>
                <p>
                  Add a bus with the form. Its fares start appearing here once its meter or a door phone
                  uploads — they settle only for plates registered to you.
                </p>
              </div>
            ) : (
              <div className="op-fleet">
                {rows.map((v) => (
                  <FleetRow key={v.plate} vehicle={v} route={routeById.get(v.route_id)} />
                ))}
              </div>
            )}
          </section>

          <div className="op-sticky op-area-form">
            <RegisterBus
              operator={operator}
              routes={routes}
              onAdded={async () => { await load(); onChange?.(); }}
            />
          </div>

          <section className="op-section op-area-routes">
            <div className="op-section__head">
              <h2>
                रुटहरू
                <small>Routes a bus can be registered on</small>
              </h2>
              <span className="op-section__aside">{routes.length} routes</span>
            </div>
            <div className="op-routes">
              {routes.map((r) => (
                <div key={r.id}>
                  <div className="op-routes__top">
                    <b>
                      {r.name_ne}
                      <span className="op-tag">{r.id}</span>
                    </b>
                    <span>{r.stops ? `${r.stops} stops` : ''}</span>
                  </div>
                  <p className="op-routes__via">{r.via ?? r.name_en}</p>
                </div>
              ))}
            </div>
            <p className="op-note">
              Stop lists outside R11 are well-known corridors, not your DoTM permit. Check the stops
              against your permit before a bus on them charges stage fares; metered fares are priced by
              the kilometre and do not depend on them.
            </p>
          </section>
      </div>
    </>
  );
}

function FleetRow({ vehicle: v, route }) {
  const status = !v.last_sync
    ? { kind: 'never', text: 'Never reported' }
    : hoursSince(v.last_sync) < STALE_HOURS
      ? { kind: 'ok', text: `Reported ${timeAgo(v.last_sync)}` }
      : { kind: 'stale', text: `Silent since ${timeAgo(v.last_sync)}` };

  return (
    <div>
      <Plate plate={v.plate} />
      <div className="op-fleet__route">
        <b>{route ? route.name_en : v.route_id ?? 'No route'}</b>
        <span>
          {route?.id ?? v.route_id ?? '—'}
          {v.capacity ? ` · permit ${v.capacity} seats` : ''}
        </span>
        <span className={`op-status op-status--${status.kind}`}>{status.text}</span>
      </div>
      <div className="op-fleet__numbers tabular">
        <div>
          {v.lifetime_rides_metered ?? 0}
          <small>metered rides</small>
        </div>
        <div>
          {v.lifetime_fares}
          <small>stage fares</small>
        </div>
        <div>
          <span>Rs {v.lifetime_collected}</span>
          <small>stage collected</small>
        </div>
      </div>
    </div>
  );
}

function RegisterBus({ operator, routes, onAdded }) {
  const [zone, setZone] = useState('BA');
  const [lot, setLot] = useState('');
  const [series, setSeries] = useState('KHA');
  const [number, setNumber] = useState('');
  const [route, setRoute] = useState('R11');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState(null);

  const plate = composePlate({ zone, lot, series, number });
  const complete = lot !== '' && number !== '';
  const valid = complete && isValidPlate(plate);
  const chosen = routes.find((r) => r.id === route);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setAdded(null);
    if (!valid) {
      setError('Enter the lot number (1–2 digits) and the vehicle number (1–4 digits).');
      return;
    }
    setBusy(true);
    const { error: problem } = await supabase.from('vehicles').insert({
      plate,
      operator_id: operator.operator_id,
      route_id: route || null,
    });
    setBusy(false);
    if (problem) {
      setError(
        problem.code === '23505'
          ? `${plateEn(plate)} is already registered, to you or to another operator.`
          : problem.message,
      );
      return;
    }
    setAdded(plate);
    setLot('');
    setNumber('');
    await onAdded();
  }

  const digits = (setter, max) => (e) => setter(e.target.value.replace(/\D/g, '').slice(0, max));

  return (
    <form className="op-sheet" onSubmit={submit} noValidate>
      <h2>
        नयाँ बस दर्ता
        <small>Register a bus</small>
      </h2>

      <div className="op-form">
        <div className="op-plate-fields">
          <label className="op-field">
            <span>अञ्चल / Zone</span>
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              {ZONES.map((z) => (
                <option key={z.code} value={z.code}>{z.ne} {z.code}</option>
              ))}
            </select>
          </label>
          <label className="op-field">
            <span>लट / Lot</span>
            <input
              value={lot}
              onChange={digits(setLot, 2)}
              inputMode="numeric"
              placeholder="2"
              aria-invalid={error && lot === '' ? 'true' : undefined}
              className="tabular"
            />
          </label>
          <label className="op-field">
            <span>सिरिज / Series</span>
            <select value={series} onChange={(e) => setSeries(e.target.value)}>
              {SERIES.map((s) => (
                <option key={s.code} value={s.code}>{s.ne} {s.code}</option>
              ))}
            </select>
          </label>
          <label className="op-field">
            <span>नम्बर / Number</span>
            <input
              value={number}
              onChange={digits(setNumber, 4)}
              inputMode="numeric"
              placeholder="4412"
              aria-invalid={error && number === '' ? 'true' : undefined}
              className="tabular"
            />
          </label>
        </div>

        {complete ? (
          <Plate plate={plate} big />
        ) : (
          <span className="op-plate op-plate--big op-plate--empty" aria-live="polite">
            <b>
              {ZONES.find((z) => z.code === zone)?.ne} {lot ? toDevanagari(lot) : '–'}{' '}
              {SERIES.find((s) => s.code === series)?.ne} {number ? toDevanagari(number) : '––––'}
            </b>
            <small>Add the lot and number to see the plate</small>
          </span>
        )}

        <label className="op-field">
          <span>रुट / Route</span>
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name_en}{r.stops ? ` · ${r.stops} stops` : ''}
              </option>
            ))}
          </select>
        </label>

        {chosen?.via ? (
          <p className="op-routecard">
            <b>{chosen.name_ne}</b>
            <br />
            {chosen.via}
          </p>
        ) : null}

        {error ? <p className="op-error" role="alert">{error}</p> : null}
        {added ? <p className="op-success" role="status">{plateEn(added)} is registered. Pair its meter and door phones next.</p> : null}

        <button type="submit" className="op-btn op-btn--block" disabled={busy || !complete}>
          {busy ? 'Registering…' : complete ? `Register ${plateEn(plate)}` : 'Register bus'}
        </button>

        <p className="op-field__help">
          Every fare and receipt this bus signs carries its plate, so it must match the painted plate
          exactly. Fares from a plate not registered to you are refused at settlement.
        </p>
      </div>
    </form>
  );
}

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}
