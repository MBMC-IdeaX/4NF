// The data product.
//
// No Nepali operator currently knows how many people rode which segment at
// which hour. They know how much cash came back, and that it is less than it
// should be. This screen is a timetable board, not a SaaS dashboard: ruled
// rows, one accent, numbers big enough to read standing up.

import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { supabase } from '../../lib/supabase';
import { stop as bundledStop } from '../../lib/nepali';
import BusLoader from '../../components/BusLoader';
import Stat from '../shared/Stat';
import Plate from '../shared/Plate.jsx';
import { plateEn } from '../shared/plates';

const INK = '#16130f';
const PLATE = '#a8202f';
const RULE = '#b8b2a4';

const OVERLOAD_KIND = {
  locked: 'Boarding door held at the permit',
  refused: 'Boarding refused, bus full',
  override_on: 'Interlock overridden by crew',
};

const when = (iso) => new Date(iso).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

export default function Overview({ onAddBus }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [vehicles, trips, segments, hourly, distance, overloads, bonuses, misses, tampers, stops] = await Promise.all([
        supabase.from('operator_vehicles').select('*'),
        supabase.from('operator_trips').select('*'),
        supabase.from('operator_segments').select('*'),
        supabase.from('operator_hourly').select('*'),
        // The metered rides (0011). A project without that migration answers
        // with an error here, which must not blank the stage-fare figures.
        supabase.from('operator_distance').select('*'),
        supabase.from('operator_overloads').select('*').order('at', { ascending: false }).limit(20),
        // The crew bonus and the pulled plug (0025). Same rule as the metered
        // rides above: a project without that migration answers with an error
        // here, and an error must not blank the rest of the dashboard.
        supabase.from('operator_crew_bonuses').select('*').order('day', { ascending: false }).limit(30),
        supabase.from('operator_bonus_misses').select('*').order('awarded_at', { ascending: false }).limit(20),
        supabase.from('operator_power_tamper').select('*').order('at', { ascending: false }).limit(20),
        // Stop names for every route, not only the bundled R11 corridor.
        supabase.from('stops').select('code, name_ne, name_en'),
      ]);
      if (cancelled) return;
      const problem = vehicles.error || trips.error || segments.error || hourly.error;
      setState({
        loading: false,
        error: problem?.message ?? null,
        vehicles: vehicles.data ?? [],
        trips: trips.data ?? [],
        segments: segments.data ?? [],
        hourly: hourly.data ?? [],
        distance: distance.error ? [] : distance.data ?? [],
        overloads: overloads.error ? [] : overloads.data ?? [],
        bonuses: bonuses.error ? [] : bonuses.data ?? [],
        misses: misses.error ? [] : misses.data ?? [],
        tampers: tampers.error ? [] : tampers.data ?? [],
        stops: new Map((stops.data ?? []).map((s) => [s.code, { ne: s.name_ne, en: s.name_en }])),
      });
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const stopName = (code) => state.stops?.get(code) ?? bundledStop(code);

  const totals = useMemo(() => {
    const trips = state.trips ?? [];
    return {
      passengers: trips.reduce((sum, t) => sum + t.passengers, 0),
      collected: trips.reduce((sum, t) => sum + t.collected, 0),
      trips: trips.length,
      buses: (state.vehicles ?? []).length,
    };
  }, [state]);

  /*
    What the bonus scheme cost and what it bought.

    Read as one line: this many trips ran with a crew signed on, this many came
    up clean, this much left the fare payable. An owner whose clean rate is low
    is usually not looking at a dishonest crew but at a bus whose meter keeps
    losing power, which is the section under this one.
  */
  const crew = useMemo(() => {
    const rows = state.bonuses ?? [];
    const sum = (field) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
    return {
      trips: sum('trips'),
      clean: sum('clean_trips'),
      bonus: sum('bonus_npr'),
      net: sum('net_npr'),
      unpaid: sum('unpaid_no_wallet'),
    };
  }, [state]);

  // The meter's numbers. Rupees per passenger-kilometre is the figure a fare
  // review turns on and the one no Nepali operator has ever been able to state.
  const metered = useMemo(() => {
    const rows = state.distance ?? [];
    const rides = rows.reduce((sum, r) => sum + r.rides, 0);
    const km = rows.reduce((sum, r) => sum + Number(r.passenger_km), 0);
    const collected = rows.reduce((sum, r) => sum + r.collected, 0);
    const measured = rows.reduce((sum, r) => sum + r.measured, 0);
    const unclosed = rows.reduce((sum, r) => sum + r.unclosed, 0);
    const byBus = new Map();
    for (const r of rows) {
      const bus = byBus.get(r.vehicle_plate) ?? { plate: r.vehicle_plate, rides: 0, km: 0, collected: 0 };
      bus.rides += r.rides;
      bus.km += Number(r.passenger_km);
      bus.collected += r.collected;
      byBus.set(r.vehicle_plate, bus);
    }
    return {
      rides,
      km,
      collected,
      perKm: km > 0 ? collected / km : 0,
      measuredShare: rides > 0 ? measured / rides : 0,
      unclosed,
      buses: [...byBus.values()].sort((a, b) => b.km - a.km),
    };
  }, [state.distance]);

  // Every hour of the service day, so a quiet hour reads as quiet rather than
  // as missing. A chart that only plots the hours with data lies about the day.
  const byHour = useMemo(() => {
    const map = new Map((state.hourly ?? []).map((r) => [r.hour, r]));
    return Array.from({ length: 18 }, (_, i) => {
      const hour = i + 5; // 05:00 to 22:00, the service day
      const row = map.get(hour);
      return {
        hour,
        label: `${String(hour).padStart(2, '0')}`,
        passengers: row?.passengers ?? 0,
        collected: row?.collected ?? 0,
      };
    });
  }, [state.hourly]);

  const busiest = Math.max(0, ...byHour.map((r) => r.passengers));

  const segments = useMemo(
    () => [...(state.segments ?? [])]
      .sort((a, b) => b.passengers - a.passengers)
      .slice(0, 8),
    [state.segments],
  );

  const trips = useMemo(
    () => [...(state.trips ?? [])]
      .sort((a, b) => new Date(b.started ?? 0) - new Date(a.started ?? 0))
      .slice(0, 10),
    [state.trips],
  );

  if (state.loading) return <BusLoader label="हिसाब आउँदैछ" sub="Loading your routes" />;
  if (state.error) {
    return (
      <div className="op-empty op-empty--page">
        <b>The figures did not load</b>
        <p>{state.error}</p>
        <button type="button" className="op-btn" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  if (totals.passengers === 0 && metered.rides === 0) {
    return (
      <>
        <div className="op-pagehead">
          <div>
            <h1>कारोबार</h1>
            <p>{today}</p>
          </div>
        </div>
        <div className="op-empty op-empty--page">
          <b>No rides yet</b>
          <p>
            {totals.buses === 0
              ? 'Register a bus, pair its meter and door phones, and the first ride appears here as soon as any of them finds a signal.'
              : `You have ${totals.buses} ${totals.buses === 1 ? 'bus' : 'buses'} registered. The first ride appears here as soon as a meter or door phone on one of them finds a signal.`}
          </p>
          <button type="button" className="op-btn" onClick={onAddBus}>
            {totals.buses === 0 ? 'Register a bus' : 'See your buses'}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>कारोबार</h1>
          <p>{today} · all settled rides to date</p>
        </div>
      </div>

      <dl className="op-stats">
        <Stat label="उठेको" sub="Collected" value={totals.collected + metered.collected} prefix="Rs" accent />
        <Stat label="यात्रु" sub="Passengers" value={totals.passengers + metered.rides} />
        <Stat label="फेरा" sub="Trips" value={totals.trips} />
        <Stat label="बस" sub="Buses" value={totals.buses} />
      </dl>

      {metered.rides > 0 ? (
        <section className="op-section">
          <div className="op-section__head">
            <h2>
              किलोमिटरमा
              <small>Metered rides, priced by stage fare</small>
            </h2>
          </div>
          <dl className="op-stats op-stats--inset">
            <Stat label="यात्रा" sub="Metered rides" value={metered.rides} />
            <Stat label="यात्रु-कि.मि." sub="Passenger-km" value={Math.round(metered.km)} />
            <Stat label="प्रति कि.मि." sub="per passenger-km" value={metered.perKm.toFixed(2)} prefix="Rs" accent />
            <Stat label="नापिएको" sub="measured by odometer" value={`${Math.round(metered.measuredShare * 100)}%`} />
          </dl>
          <div className="op-rows">
            {metered.buses.map((bus) => {
              const top = metered.buses[0].km || 1;
              return (
                <div key={bus.plate}>
                  <div className="op-row__name">
                    <Plate plate={bus.plate} />
                    <small>{bus.rides} rides · {bus.km.toFixed(1)} passenger-km on record</small>
                  </div>
                  <div className="op-row__bar" aria-hidden="true">
                    <span style={{ width: `${Math.round((bus.km / top) * 100)}%` }} />
                  </div>
                  <div className="op-row__value tabular">
                    {Math.round(bus.km)}
                    <small>passenger-km</small>
                  </div>
                </div>
              );
            })}
          </div>
          {metered.unclosed > 0 ? (
            <p className="op-note">
              <b>{metered.unclosed} {metered.unclosed === 1 ? 'ride was' : 'rides were'} never tapped out</b> and
              charged the route cap. A number that keeps growing points at a door where tapping out is
              being skipped.
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="op-grid op-grid--split op-section">
        <section className="op-section">
          <div className="op-section__head">
            <h2>
              घण्टाअनुसार
              <small>Stage-fare passengers by hour of day</small>
            </h2>
            {busiest > 0 ? (
              <span className="op-section__aside">
                Busiest {String(byHour.find((r) => r.passengers === busiest).hour).padStart(2, '0')}:00
              </span>
            ) : null}
          </div>
          <div className="op-chart">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={byHour} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
                <CartesianGrid stroke={RULE} strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: INK, fontSize: 12, fontFamily: 'Mukta' }}
                  axisLine={{ stroke: INK }}
                  tickLine={false}
                  interval={1}
                />
                <YAxis
                  tick={{ fill: INK, fontSize: 12, fontFamily: 'Mukta' }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<Printed />} cursor={{ fill: 'rgba(22,19,15,0.06)' }} />
                {/* One accent. The busiest hour is the only thing that needs finding. */}
                <Bar dataKey="passengers" isAnimationActive={false}>
                  {byHour.map((row) => (
                    <Cell key={row.hour} fill={row.passengers === busiest && busiest > 0 ? PLATE : INK} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="op-section">
          <div className="op-section__head">
            <h2>
              व्यस्त खण्ड
              <small>Stage segments that carry the most people</small>
            </h2>
          </div>
          {segments.length === 0 ? (
            <div className="op-empty"><p>No stage fares yet.</p></div>
          ) : (
            <div className="op-rows">
              {segments.map((row) => {
                const top = segments[0].passengers || 1;
                const a = stopName(row.boarding_stop);
                const b = stopName(row.alighting_stop);
                return (
                  <div key={`${row.boarding_stop}-${row.alighting_stop}`}>
                    <div className="op-row__name">
                      {a.ne} – {b.ne}
                      <small>{a.en} to {b.en}</small>
                    </div>
                    {/* The bar is a printed rule that happens to be measured. */}
                    <div className="op-row__bar" aria-hidden="true">
                      <span style={{ width: `${Math.round((row.passengers / top) * 100)}%` }} />
                    </div>
                    <div className="op-row__value tabular">
                      {row.passengers}
                      <small>Rs {row.collected}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <div className="op-grid op-grid--halves op-section">
        <section className="op-section">
          <div className="op-section__head">
            <h2>
              फेराहरू
              <small>Recent trips</small>
            </h2>
            <span className="op-section__aside">{totals.trips} in total</span>
          </div>
          {trips.length === 0 ? (
            <div className="op-empty"><p>No trips recorded yet.</p></div>
          ) : (
            <div className="op-rows op-rows--plain">
              {trips.map((trip) => (
                <div key={`${trip.vehicle_plate}-${trip.trip_id ?? 'none'}`}>
                  <div className="op-row__name">
                    {plateEn(trip.vehicle_plate)}
                    <small>
                      {trip.started ? when(trip.started) : 'Start time unknown'}
                      {trip.trip_id ? ` · ${trip.trip_id}` : ' · not assigned to a trip'}
                    </small>
                  </div>
                  <div className="op-row__value tabular">
                    {trip.passengers}
                    <small>Rs {trip.collected}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="op-section">
          <div className="op-section__head">
            <h2>
              अनुमति भन्दा बढी
              <small>Refusals and overrides at the permit</small>
            </h2>
          </div>
          {(state.overloads ?? []).length === 0 ? (
            <div className="op-empty">
              <b>Nothing to report</b>
              <p>No bus has been held at its permit or overridden by crew.</p>
            </div>
          ) : (
            <>
              <div className="op-rows op-rows--plain">
                {state.overloads.map((event) => (
                  <div key={`${event.vehicle_plate}-${event.at}-${event.kind}`}>
                    <div className="op-row__name">
                      {OVERLOAD_KIND[event.kind] ?? event.kind}
                      <small>{plateEn(event.vehicle_plate)} · {when(event.at)}</small>
                    </div>
                    <div className="op-row__value tabular">
                      {event.onboard ?? '—'}/{event.capacity ?? '—'}
                      <small>aboard / permit</small>
                    </div>
                  </div>
                ))}
              </div>
              <p className="op-note">
                These rows arrive with the fares and cannot be edited here. They show a bus was held at
                its permit — or that someone chose not to hold it.
              </p>
            </>
          )}
        </section>

        <section className="op-section">
          <div className="op-section__head">
            <h2>
              चालक दल बोनस
              <small>What the clean trips cost, and what the rest went wrong on</small>
            </h2>
          </div>
          {(state.bonuses ?? []).length === 0 ? (
            <div className="op-empty">
              <b>No trips scored yet</b>
              <p>A trip earns its crew a bonus once somebody signs on at the meter console.</p>
            </div>
          ) : (
            <>
              <dl className="op-stats op-stats--inset">
                <Stat label="सफा फेरा" sub="Trips clean" value={`${crew.clean}/${crew.trips}`} />
                <Stat label="बोनस" sub="Paid to crews" value={crew.bonus} prefix="Rs" accent />
                <Stat label="बाँकी भाडा" sub="Fares after bonuses" value={crew.net} prefix="Rs" />
                <Stat label="वालेट छैन" sub="Owed, no wallet yet" value={crew.unpaid} />
              </dl>

              {(state.misses ?? []).length > 0 ? (
                <div className="op-rows op-rows--plain">
                  {state.misses.map((miss) => (
                    <div key={miss.trip_id}>
                      <div className="op-row__name">
                        {(miss.reasons ?? []).map((reason) => reason.message).join(' ') || 'No reason recorded.'}
                        <small>{plateEn(miss.vehicle_plate)} · {when(miss.awarded_at)}</small>
                      </div>
                      <div className="op-row__value tabular">
                        {miss.legs}
                        <small>rides</small>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <p className="op-note">
                A bonus is paid out of the fares these buses collected, not on top of them. A crew that
                missed one can be shown exactly this line — it is the same wording their console gives.
              </p>
            </>
          )}
        </section>

        <section className="op-section">
          <div className="op-section__head">
            <h2>
              मिटरको बिजुली काटिएको
              <small>The meter losing its 12 V feed with the bus moving</small>
            </h2>
          </div>
          {(state.tampers ?? []).length === 0 ? (
            <div className="op-empty">
              <b>Every meter stayed powered</b>
              <p>No box has lost its supply while its bus was working.</p>
            </div>
          ) : (
            <>
              <div className="op-rows op-rows--plain">
                {state.tampers.map((event) => (
                  <div key={`${event.vehicle_plate}-${event.at}`}>
                    <div className="op-row__name">
                      Feed pulled
                      <small>{plateEn(event.vehicle_plate)} · {when(event.at)}</small>
                    </div>
                    {/*
                      A trip id is a reference, not a figure. Rendered at the
                      value slot's display weight it shouted over the thing that
                      actually happened, so it sits quiet on the right instead.
                    */}
                    <span className="op-pill" title={event.trip_id ?? undefined}>
                      {event.trip_id ? `Trip ${event.trip_id.slice(-6)}` : 'No trip'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="op-note">
                A bus parked with the ignition off loses the same socket, and the meter does not report
                that. These are the times the supply went away with the odometer still moving.
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}

// Recharts' default tooltip is a white card with a grey shadow, which is the
// exact thing the design system rules out. This is a printed slip instead.
function Printed({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="op-tip">
      <b>{label}:00</b>
      <span>{payload[0].value} passengers · Rs {payload[0].payload.collected}</span>
    </div>
  );
}
