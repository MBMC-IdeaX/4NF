// Routes — the screen a passenger opens before a trip, in the shape every
// Kathmandu bus app uses: search a station, pick a route card, then see its
// buses, its stops in order, or the map. A fare calculator sits on top,
// because the fare is the thing Bhada is about.
//
// The route lines and stops are real valley corridors. The buses on them are
// a simulated demo fleet (src/lib/fleet-simulator.js) and say so.

import { useEffect, useMemo, useState } from 'react';
import LiveBusStatusCard from '../../ui/LiveBusStatusCard';
import OsmFleetMap from '../../ui/OsmFleetMap';
import { fleetEngine } from '../../lib/fleet-simulator';
import { findRoutesByStation, VALLEY_ROUTES } from '../../data/valley-routes';
import { Icon, DemoTag, Segmented, Empty } from '../../ui';
import { CONCESSION_RATE } from '../../../protocol/meter.mjs';

/*
  A stage fare between two stops on a route, by the demo rule every seeded
  fare table uses: Rs 15 to the next stage, Rs 5 for each stage after, at most
  Rs 25. These valley routes have no published table in Bhada yet, so the
  calculator says it is a demo. The kilometres are shown, never charged.
*/
const DEMO_RULE = { first: 15, perStage: 5, cap: 25 };
function stageFare(fromIndex, toIndex, concession = 'none') {
  const gap = Math.abs(toIndex - fromIndex);
  const base = gap === 0 ? 0 : Math.min(DEMO_RULE.cap, DEMO_RULE.first + (gap - 1) * DEMO_RULE.perStage);
  return { base, amount: Math.ceil(base * (CONCESSION_RATE[concession] ?? 1)), stages: gap };
}
import './routes.css';

export default function RiderRoutes() {
  const [snapshot, setSnapshot] = useState(() => fleetEngine.getSnapshot());
  const [query, setQuery] = useState('');
  const [routeId, setRouteId] = useState(null);
  const [fareOpen, setFareOpen] = useState(false);

  useEffect(() => fleetEngine.subscribe(setSnapshot), []);

  const routes = useMemo(() => findRoutesByStation(query), [query]);
  const live = (id) => snapshot.routes.find((r) => r.id === id);

  if (fareOpen) return <FareCalculator onBack={() => setFareOpen(false)} />;
  if (routeId) return <RouteDetail route={live(routeId)} onBack={() => setRouteId(null)} />;

  return (
    <div className="rt">
      <header className="rt-head">
        <h1>मार्गहरू · Routes</h1>
        <p>Find a route by any stop on it.</p>
      </header>

      <label className="rt-search">
        <Icon name="search" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a stop — e.g. Tripureshwor"
          aria-label="Search routes by stop"
        />
      </label>

      <button type="button" className="rt-fare" onClick={() => setFareOpen(true)}>
        <span className="rt-fare__icon" aria-hidden="true"><Icon name="gauge" /></span>
        <span>
          <b>भाडा कति? · Fare calculator</b>
          <small>Pick where you get on and off — see the distance and the fare.</small>
        </span>
        <Icon name="chevron" />
      </button>

      {query && routes.length > 0 ? (
        <p className="rt-note">Routes that stop at “{query}”:</p>
      ) : null}

      {routes.length === 0 ? (
        <Empty icon="route" title="No route stops there">Try another spelling, or the name of a nearby chowk.</Empty>
      ) : (
        <ul className="rt-list">
          {routes.map((r) => (
            <li key={r.id}>
              <button type="button" className="rt-card" onClick={() => setRouteId(r.id)}>
                <span className="rt-card__tag">{r.number}</span>
                <span className="rt-ends">
                  <span><i aria-hidden="true" />{r.from}</span>
                  <span><i aria-hidden="true" />{r.to}</span>
                </span>
                <span className="rt-card__facts">
                  <span><Icon name="bus" />{(live(r.id)?.buses.length ?? r.buses.length)} demo bus{(live(r.id)?.buses.length ?? r.buses.length) === 1 ? '' : 'es'}</span>
                  <span><Icon name="pin" />{r.stops.length} stops</span>
                  <span><Icon name="route" />{r.distanceKm} km</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- one route */

function RouteDetail({ route, onBack }) {
  const [view, setView] = useState('buses');
  const [busId, setBusId] = useState(null);
  if (!route) return null;
  const end = route.stops[route.stops.length - 1];
  return (
    <div className="rt">
      <div className="rt-banner">
        <button type="button" className="rt-back" onClick={onBack} aria-label="Back to routes"><Icon name="back" /></button>
        <span className="rt-card__tag">{route.number}</span>
        <span className="rt-ends rt-ends--light">
          <span><i aria-hidden="true" />{route.from}</span>
          <span><i aria-hidden="true" />{route.to}</span>
        </span>
        <span className="rt-banner__count">{route.buses.length} bus{route.buses.length === 1 ? '' : 'es'}</span>
      </div>
      <p className="rt-note">
        {route.stops.length} stops · {end.km} km · end to end {rs(stageFare(0, route.stops.length - 1).amount)} (demo fare table)
      </p>

      <Segmented
        label="Show"
        value={view}
        onChange={setView}
        options={[{ value: 'buses', label: 'Buses' }, { value: 'stops', label: 'Stops' }, { value: 'map', label: 'Map' }]}
      />

      {view === 'buses' ? (
        <>
          <p className="rt-demo"><DemoTag>Demo fleet</DemoTag> These buses are simulated to show how live buses would appear.</p>
          <ul className="rt-buses">
            {route.buses.map((b) => (
              <li key={b.id} className="rt-bus">
                <span className="rt-bus__icon" aria-hidden="true"><Icon name="bus" /></span>
                <span className="rt-bus__body">
                  <span className="rt-bus__top">
                    <b>Bus {b.plateStr}</b>
                    <span className="rt-bus__speed">{Math.round(b.speedKmh)} km/h</span>
                  </span>
                  <small>{b.vendorInfo?.en}</small>
                  <span className="rt-bus__line"><span>Now at</span> {b.currentStop?.name ?? '—'}</span>
                  <span className="rt-bus__line"><span>Next stop</span> {b.nextStop?.name ?? '—'} · about {b.etaMinutes} min</span>
                  <span className={`rt-bus__seats rt-bus__seats--${b.crowdLevel ?? 'available'}`}>{b.crowdLabel}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {view === 'stops' ? (
        <ol className="rt-stops">
          {route.stops.map((s, i) => (
            <li key={s.code}>
              <span className="rt-stops__n">{i + 1}</span>
              <span className="rt-stops__name">{s.name}<small>{s.ne}</small></span>
              <span className="rt-stops__km">{s.km} km</span>
            </li>
          ))}
        </ol>
      ) : null}

      {view === 'map' ? (
        <div className="rt-map">
          <OsmFleetMap
            buses={route.buses}
            routes={[route]}
            selectedRouteId={route.id}
            selectedBusId={busId}
            onSelectBus={(b) => setBusId(b?.id ?? b)}
            height="60vh"
          />
          {busId ? <LiveBusStatusCard bus={route.buses.find((b) => b.id === busId)} /> : null}
          <p className="rt-demo"><DemoTag>Simulated</DemoTag> Bus positions are not live.</p>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------- fare calculator */

function FareCalculator({ onBack }) {
  const [routeId, setRouteId] = useState(VALLEY_ROUTES[0].id);
  const route = VALLEY_ROUTES.find((r) => r.id === routeId);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(route.stops.length - 1);
  const [who, setWho] = useState('none');

  const pickRoute = (id) => {
    const next = VALLEY_ROUTES.find((r) => r.id === id);
    setRouteId(id);
    setFrom(0);
    setTo(next.stops.length - 1);
  };

  const a = route.stops[Math.min(from, route.stops.length - 1)];
  const b = route.stops[Math.min(to, route.stops.length - 1)];
  const km = Math.abs(b.km - a.km);
  const price = stageFare(Math.min(from, route.stops.length - 1), Math.min(to, route.stops.length - 1), who);

  return (
    <div className="rt">
      <div className="rt-titlebar">
        <button type="button" className="rt-back rt-back--ink" onClick={onBack} aria-label="Back to routes"><Icon name="back" /></button>
        <h1>भाडा कति? · Fare</h1>
      </div>

      <div className="rt-calc">
        <label className="rt-field">
          <span>Route</span>
          <select value={routeId} onChange={(e) => pickRoute(e.target.value)}>
            {VALLEY_ROUTES.map((r) => <option key={r.id} value={r.id}>{r.number}: {r.from} – {r.to}</option>)}
          </select>
        </label>
        <label className="rt-field">
          <span><i className="rt-dot" aria-hidden="true" />Get on at</span>
          <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {route.stops.map((s, i) => <option key={s.code} value={i}>{s.name}</option>)}
          </select>
        </label>
        <label className="rt-field">
          <span><i className="rt-dot rt-dot--end" aria-hidden="true" />Get off at</span>
          <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {route.stops.map((s, i) => <option key={s.code} value={i}>{s.name}</option>)}
          </select>
        </label>
        <Segmented
          label="Fare type"
          value={who}
          onChange={setWho}
          options={[{ value: 'none', label: 'Adult' }, { value: 'student', label: 'Student' }, { value: 'senior', label: 'Senior' }]}
        />
      </div>

      <div className="rt-result" aria-live="polite">
        <div>
          <small>Fare</small>
          <b className="rt-result__fare">{price.stages === 0 ? '—' : rs(price.amount)}</b>
        </div>
        <div>
          <small>Stages · km</small>
          <b>{price.stages}<span>stages · {km.toFixed(1)} km</span></b>
        </div>
      </div>
      <p className="rt-demo"><DemoTag>Demo fare table</DemoTag></p>
      <p className="rt-note">
        A bus fare is a stage fare: {rs(DEMO_RULE.first)} to the next stage, {rs(DEMO_RULE.perStage)} for each stage after, never more
        than {rs(DEMO_RULE.cap)}. Students and seniors pay half. On the bus, its GPS finds the stage you get on and off at,
        and the fare comes from the route&rsquo;s fare table.
      </p>
    </div>
  );
}

const rs = (n) => `रु ${n}`;
