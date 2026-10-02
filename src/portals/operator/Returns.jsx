// The regulator's return, as a file.
//
// An operator holding a route permit has to be able to show the Department of
// Transport Management what they did with it: how many rides, how many
// passenger-kilometres, and how often the bus was over its permitted capacity.
// Today that is a register and a pen, which means the number the regulator sees
// is the number the operator chose to write down.
//
// Everything here is computed from rows nobody edits — settled legs with the
// distance each was measured by, and the door tape with the occupancy at the
// moment each event fired. This screen reads the two views in migration 0015
// and hands them over as CSV. It submits nothing anywhere: the pilot has to be
// filed with DoTM under Section 153 before any of this is a legal return rather
// than a spreadsheet. What it removes is the retyping.

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import BusLoader from '../../components/BusLoader';
import Stat from '../shared/Stat';
import { plateEn } from '../shared/plates';

const RETURN_COLUMNS = [
  ['service_date', 'Date'],
  ['vehicle_plate', 'Vehicle'],
  ['route_id', 'Route'],
  ['rides', 'Rides'],
  ['rides_measured', 'Measured'],
  ['rides_estimated', 'Estimated'],
  ['passenger_km', 'Passenger-km'],
  ['passenger_km_measured', 'Passenger-km measured'],
  ['fare_npr', 'Fare NPR'],
  ['concession_rides', 'Concession rides'],
  ['concession_npr', 'Concession NPR'],
  ['permitted_capacity', 'Permitted capacity'],
  ['peak_onboard', 'Peak onboard'],
  ['peak_over_capacity', 'Peak over capacity'],
  ['interlock_refusals', 'Interlock refusals'],
  ['override_events', 'Overrides'],
];

const REGISTER_COLUMNS = [
  ['at', 'At'],
  ['vehicle_plate', 'Vehicle'],
  ['route_id', 'Route'],
  ['kind', 'Event'],
  ['door', 'Door'],
  ['onboard', 'Onboard'],
  ['capacity', 'Capacity'],
  ['over_by', 'Over by'],
  ['trip_id', 'Trip'],
  ['note', 'Note'],
];

/*
  CSV, by the book rather than by string concatenation.

  A note field carries whatever a crew typed, and a conductor writing
  "full, Koteshwor" would otherwise split a row into two columns and quietly
  corrupt a regulatory filing. Quote everything, double the quotes inside.
*/
function toCsv(columns, rows) {
  const cell = (value) => {
    if (value === null || value === undefined) return '""';
    return `"${String(value).replace(/"/g, '""')}"`;
  };
  return [
    columns.map(([, label]) => cell(label)).join(','),
    ...rows.map((row) => columns.map(([key]) => cell(row[key])).join(',')),
  ].join('\r\n');
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Returns() {
  const [rows, setRows] = useState(null);
  const [register, setRegister] = useState([]);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      supabase.from('dotm_daily_return').select('*').order('service_date', { ascending: false }).limit(200),
      supabase.from('dotm_overload_register').select('*').limit(500),
    ])
      .then(([daily, overload]) => {
        if (!live) return;
        if (daily.error) throw daily.error;
        setRows(daily.data ?? []);
        setRegister(overload.data ?? []);
      })
      .catch((error) => live && setProblem(error.message));
    return () => { live = false; };
  }, []);

  if (problem) {
    return (
      <div className="op-empty op-empty--page">
        <b>The return did not load</b>
        <p>{problem}</p>
      </div>
    );
  }
  if (!rows) return <BusLoader label="विवरण तयार हुँदै" sub="Reading the return" />;

  const totals = rows.reduce(
    (sum, row) => ({
      rides: sum.rides + Number(row.rides ?? 0),
      km: sum.km + Number(row.passenger_km ?? 0),
      npr: sum.npr + Number(row.fare_npr ?? 0),
      overrides: sum.overrides + Number(row.override_events ?? 0),
    }),
    { rides: 0, km: 0, npr: 0, overrides: 0 },
  );
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>DoTM विवरण</h1>
          <p>
            The regulator's return, per bus and service day, computed from settled rides and the
            door tape. Nothing here was typed by anyone.
          </p>
        </div>
        <div className="op-actions">
          <button
            type="button"
            className="op-btn"
            disabled={rows.length === 0}
            onClick={() => download(`bhada-dotm-return-${stamp}.csv`, toCsv(RETURN_COLUMNS, rows))}
          >
            Download return (CSV)
          </button>
          <button
            type="button"
            className="op-btn op-btn--ghost"
            disabled={register.length === 0}
            onClick={() => download(`bhada-overload-register-${stamp}.csv`, toCsv(REGISTER_COLUMNS, register))}
          >
            Overload register ({register.length})
          </button>
        </div>
      </div>

      <dl className="op-stats">
        <Stat label="रुपैयाँ" sub="Fares" value={totals.npr} prefix="Rs" accent />
        <Stat label="यात्रा" sub="Rides" value={totals.rides} />
        <Stat label="यात्रु-कि.मि." sub="Passenger-km" value={totals.km.toFixed(1)} />
        <Stat label="ओभरराइड" sub="Crew overrides" value={totals.overrides} warn={totals.overrides > 0} />
      </dl>

      <section className="op-section">
        <div className="op-section__head">
          <h2>
            दैनिक विवरण
            <small>Most recent service days first</small>
          </h2>
          <span className="op-section__aside">{rows.length} bus-days</span>
        </div>

        {rows.length === 0 ? (
          <div className="op-empty">
            <b>Nothing to return yet</b>
            <p>The return fills in from settled metered rides. Once a bus uploads its first ride, its day appears here.</p>
          </div>
        ) : (
          <div className="op-table-scroll">
            <table className="op-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Bus</th>
                  <th>Route</th>
                  <th className="num">Rides</th>
                  <th className="num">Measured</th>
                  <th className="num">Passenger-km</th>
                  <th className="num">Fares</th>
                  <th className="num">Peak / permit</th>
                  <th className="num">Overrides</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 60).map((row) => {
                  const over = row.permitted_capacity && row.peak_onboard > row.permitted_capacity;
                  return (
                    <tr key={`${row.vehicle_plate}-${row.service_date}`}>
                      <td className="tabular">{row.service_date}</td>
                      <td className="tabular">{plateEn(row.vehicle_plate)}</td>
                      <td>{row.route_id ?? '—'}</td>
                      <td className="num tabular">{row.rides}</td>
                      <td className="num tabular">{row.rides_measured ?? '—'}</td>
                      <td className="num tabular">{Number(row.passenger_km ?? 0).toFixed(1)}</td>
                      <td className="num tabular">Rs {row.fare_npr}</td>
                      <td className={`num tabular${over ? ' warn' : ''}`}>
                        {row.peak_onboard ?? '—'} / {row.permitted_capacity ?? '—'}
                      </td>
                      <td className={`num tabular${Number(row.override_events) > 0 ? ' warn' : ''}`}>{row.override_events}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="op-note">
          Passenger-km is the sum of measured distances. Rides the odometer could not measure are counted in
          their own column of the download rather than folded into the total, because a figure a regulator
          cannot take apart is one they are being asked to trust.
        </p>
        <p className="op-note">
          This is a spreadsheet; it files nothing. Bhada has to be registered with DoTM as an automated
          distance-meter pilot under Section 153 before a metered return is a return rather than a
          description of one.
        </p>
      </section>
    </>
  );
}
