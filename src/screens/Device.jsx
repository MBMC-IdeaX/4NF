// The bus interface: what the box shows the crew, and what it would show an
// engineer with the lid off.
//
// This is deliberately not a dashboard. A dashboard summarises after the fact;
// this is an instrument panel, and every number on it is the live value the
// fare arithmetic is actually using at that instant. If the odometer here reads
// 4 312 m, that is the integer that goes into the next passenger's receipt.
// Showing anything softer than that would make the panel decorative.
//
// Laid out in the order a person interrogates a fare machine they do not trust:
// what does it think it is → where does it think it is → who does it think is
// aboard → what is it charging them → what did it just do → what is it saying
// on the radio.

import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { meter, VEHICLE, short } from '../device/meter';
import { syncMeter, syncConfigured } from '../device/sync';
import { priceDistance, FIX_QUALITY, CURRENT_TARIFF, stageNear, stageName } from '../../protocol/meter.mjs';
import { decodeFrame } from '../../protocol/frame.mjs';
import { STOPS, ROUTE_LENGTH_M, rupees } from '../lib/nepali';
import { navigate } from '../lib/router';
import { downloadText } from '../device/positioning';
import { useSyncStatus } from '../lib/useSyncStatus';
import { db } from '../storage/db';

const QUALITY_LABEL = {
  [FIX_QUALITY.NONE]: 'no fix',
  [FIX_QUALITY.WARMUP]: 'acquiring',
  [FIX_QUALITY.POOR]: 'degraded',
  [FIX_QUALITY.GOOD]: 'locked',
};

const LINK_LABEL = {
  realtime: 'uplink · live',
  local: 'vehicle bus only',
  detached: 'detached',
};

export function useMeter() {
  const [snap, setSnap] = useState(() => meter().snapshot());
  useEffect(() => {
    const unit = meter();
    unit.boot();
    return unit.subscribe(setSnap);
  }, []);
  return snap;
}

/*
  The meter sends by itself: receipts it signed, and — until the backend has
  bound this phone to the bus — the owner's setup code (0034). Nobody on a bus
  should have to press "upload"; the bench button stays for a unit on a desk.
*/
const HEARTBEAT_MS = 5 * 60_000;

function useMeterSync(snap, unit) {
  const latest = useRef(snap);
  latest.current = snap;
  return useSyncStatus({
    name: 'meter',
    enabled: syncConfigured(),
    pending: async () => {
      // Not yet confirmed, or not heard from for five minutes: check in. The
      // check-in is how a replaced phone learns it is no longer the bus, and
      // what the owner reads as "last seen".
      const status = await (await db()).get('meter', 'unitStatus');
      const stale = !status?.ok || Date.now() - (status.at ?? 0) > HEARTBEAT_MS;
      return (latest.current.queued ?? 0) + (stale ? 1 : 0);
    },
    run: async () => {
      // The first attempt can land before the meter has loaded its key.
      const now = latest.current.vehiclePublicKey ? latest.current : await unit.boot();
      if (!now?.vehiclePublicKey) throw new Error('The meter has not made its key yet.');
      await syncMeter({ vehicleId: now.vehicleId, publicKey: now.vehiclePublicKey, capacity: now.capacity, firmware: VEHICLE.firmware });
      await unit.refreshQueue();
    },
  });
}

export default function Device() {
  const snap = useMeter();
  const unit = meter();
  useMeterSync(snap, unit);
  const [pairing, setPairing] = useState(null);
  const [confirmOverride, setConfirmOverride] = useState(false);

  const [roster, setRoster] = useState(null);
  async function showRoster() {
    const payload = unit.rosterPayload();
    if (!payload) return;
    const image = await QRCode.toDataURL(payload, { margin: 1, width: 520, errorCorrectionLevel: 'L' });
    setRoster({ payload, image, at: Date.now() });
  }

  async function showPairing() {
    const payload = unit.pairingPayload();
    if (!payload) return;
    const image = await QRCode.toDataURL(payload, { margin: 1, width: 420, errorCorrectionLevel: 'M' });
    setPairing({ payload, image });
  }

  return (
    <div className="panel">
      <Masthead snap={snap} />

      <TripGlance snap={snap} unit={unit} />

      {/* Who is aboard, the doors, the crew: there when asked for, not in the way. */}
      <details className="panel__eng">
        <summary>थप विवरण · Passengers, doors and crew</summary>
        <div className="panel__grid">
          <Manifest snap={snap} />
          <Doors
            snap={snap}
            unit={unit}
            confirmOverride={confirmOverride}
            setConfirmOverride={setConfirmOverride}
          />
          <Completed snap={snap} />
          <Crew snap={snap} unit={unit} />
        </div>
      </details>

      {/* Everything an engineer or an inspector wants, one tap away from the crew. */}
      <details className="panel__eng">
        <summary>Engineering, inspection and bench controls</summary>
        <div className="panel__grid">
          <Readouts snap={snap} />
          <Corridor snap={snap} />
          <Accuracy snap={snap} unit={unit} />
          <Registry snap={snap} />
          <Telemetry snap={snap} />
          <Tape snap={snap} />
          <Bench snap={snap} unit={unit} onPair={showPairing} onRoster={showRoster} />
        </div>
      </details>

      {pairing ? <Pairing pairing={pairing} onClose={() => setPairing(null)} /> : null}
      {roster ? <Roster roster={roster} snap={snap} onRefresh={showRoster} onClose={() => setRoster(null)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Masthead({ snap }) {
  // The bus this phone was set up as, not the demo default.
  const vehicle = snap.vehicle ?? VEHICLE;
  const plate = vehicle.plate ?? VEHICLE.plate;
  return (
    <header className="panel__head">
      <div className="panel__plate">
        <span>{plate.province}</span>
        <span>{plate.number}</span>
        <span>{plate.series}</span>
        <b className="tabular">{plate.digits}</b>
      </div>

      <div className="panel__ident">
        <b>{vehicle.label || vehicle.routeName || vehicle.routeId}</b>
        {/* The phone is the meter here; the box this firmware string names is the
            design, not what is running. */}
        <small>This phone is the bus meter · {vehicle.firmware ?? VEHICLE.firmware}</small>
      </div>

      <div className="panel__chips">
        <Chip label="trip" value={snap.tripId ?? '—'} />
        <Chip label="uptime" value={formatUptime(snap.uptimeS)} />
        <Chip
          label="gnss"
          value={QUALITY_LABEL[snap.quality] ?? snap.quality}
          tone={snap.quality === FIX_QUALITY.GOOD ? 'ok' : snap.quality === FIX_QUALITY.NONE ? 'bad' : 'warn'}
        />
        <Chip
          label="link"
          value={LINK_LABEL[snap.link] ?? snap.link}
          tone={snap.link === 'realtime' ? 'ok' : snap.link === 'local' ? 'warn' : 'bad'}
        />
        <Chip label="queued" value={snap.queued} tone={snap.queued > 0 ? 'warn' : 'ok'} />
        <button type="button" className="panel__away" onClick={() => navigate('/app')}>
          exit
        </button>
      </div>
    </header>
  );
}

function Chip({ label, value, tone }) {
  return (
    <div className={`chip${tone ? ` chip--${tone}` : ''}`}>
      <small>{label}</small>
      <b className="tabular">{value}</b>
    </div>
  );
}

/* ------------------------------------------------------------- at a glance */

/*
  What a conductor holding a rail needs in one look: is the trip running, how
  far, how full, what has been taken, can the GPS be trusted, is anything
  waiting to upload — and the one button that ends the trip.
*/
const GPS_WORDS = {
  [FIX_QUALITY.NONE]: ['GPS छैन', 'No GPS. Distance waits at the last good reading.', 'bad'],
  [FIX_QUALITY.WARMUP]: ['GPS खोज्दै', 'Finding GPS. Distance starts in a moment.', 'warn'],
  [FIX_QUALITY.POOR]: ['GPS कमजोर', 'Weak GPS. Distance may count a little low here.', 'warn'],
  [FIX_QUALITY.GOOD]: ['GPS ठीक छ', 'GPS is good. Distance is being counted.', 'ok'],
};

function TripGlance({ snap, unit }) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const { onboard, atCapacity, nearCapacity } = snap.occupancy;
  const fill = snap.capacity ? Math.min(1, onboard / snap.capacity) : 0;
  const tone = atCapacity ? 'bad' : nearCapacity ? 'warn' : 'ok';
  const [gpsTitle, gpsNote, gpsTone] = snap.simulating
    ? ['डेमो यात्रा', 'Demo drive: simulated GPS, not a real road.', 'warn']
    : GPS_WORDS[snap.quality] ?? GPS_WORDS[FIX_QUALITY.NONE];
  const takings = snap.accrued + (snap.cash?.npr ?? 0);
  // The stage the bus is at, from its GPS: what a conductor would call out.
  const stage = stageName(CURRENT_TARIFF, stageNear(CURRENT_TARIFF, snap.fix));
  return (
    <section className="glance" aria-label="Current trip">
      <div className="glance__status">
        <span className={`glance__state glance__state--${snap.tripId ? 'on' : 'off'}`}>
          <i aria-hidden="true" />{snap.tripId ? 'यात्रा चलिरहेको · Trip running' : 'No trip running'}
        </span>
        {snap.simulating ? <span className="glance__demo">Simulated</span> : null}
      </div>

      <p className="glance__stage">
        <small>अहिले · Now at</small>
        <b>{stage ? `${stage.ne} · ${stage.en}` : 'Stage not known yet'}</b>
      </p>

      <div className="glance__figs">
        <div className="glance__fig">
          <small>भाडा · Fares</small>
          <b className="tabular glance__money">रु {takings}</b>
          <em>{snap.closed.length} ride{snap.closed.length === 1 ? '' : 's'} closed · रु {snap.cash?.npr ?? 0} cash</em>
        </div>
        <div className="glance__fig glance__fig--small">
          <small>दूरी · Distance</small>
          <b className="tabular">{(snap.odometerM / 1000).toFixed(1)}<span>km</span></b>
        </div>
      </div>

      <div className={`glance__load glance__load--${tone}`}>
        <div className="glance__loadhead">
          <small>यात्रु · Passengers</small>
          <b className="tabular">{onboard} / {snap.capacity}</b>
          <span>{atCapacity ? 'बस भरियो · FULL' : `${snap.occupancy.seatsLeft} ठाउँ बाँकी · places left`}</span>
        </div>
        <div className="glance__bar" role="meter" aria-valuemin={0} aria-valuemax={snap.capacity} aria-valuenow={onboard} aria-label="Passengers aboard">
          <i style={{ width: `${fill * 100}%` }} />
        </div>
      </div>

      <div className="glance__row">
        <span className={`glance__pill glance__pill--${gpsTone}`} title={gpsNote}><i aria-hidden="true" />{gpsTitle}</span>
        <span className={`glance__pill glance__pill--${snap.queued > 0 ? 'warn' : 'ok'}`}>
          <i aria-hidden="true" />{snap.queued > 0 ? `${snap.queued} पठाउन बाँकी · saved on this phone` : 'सबै पठाइयो · all sent'}
        </span>
      </div>
      <p className="glance__note">{gpsNote}</p>

      <div className="glance__actions">
        <button type="button" className="glance__btn glance__btn--go" onClick={() => navigate('/crew/door')}>
          स्क्यान गर्नुहोस्
          <small>Passenger getting on or off — scan their code</small>
        </button>
        <button type="button" className="glance__btn" onClick={() => navigate('/crew/door?cash')}>
          नगद यात्रु
          <small>Passenger paying cash</small>
        </button>
      </div>
      {confirmEnd ? (
        <div className="glance__confirm">
          <p>यात्रा सक्ने? End this trip? {onboard > 0 ? `${onboard} still aboard will be charged the full ${rupees(snap.tariff.unclosedLegFare)}.` : 'Nobody is aboard.'}</p>
          <button type="button" className="danger" onClick={() => { unit.endTrip(); setConfirmEnd(false); }}>हो, सक्नुहोस् · Yes, end trip</button>
          <button type="button" className="quiet" onClick={() => setConfirmEnd(false)}>होइन · Keep going</button>
        </div>
      ) : (
        <button type="button" className="glance__end" onClick={() => setConfirmEnd(true)}>यात्रा सकियो · End trip<small>the next trip starts at once</small></button>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- readouts */

function Readouts({ snap }) {
  const km = (snap.odometerM / 1000).toFixed(2);
  return (
    <section className="card card--wide">
      <h2 className="card__title">
        Live readout
        <span>the exact values the next fare will be computed from</span>
      </h2>
      <div className="readouts">
        <Readout
          label="Odometer"
          value={km}
          unit="km"
          sub={`${snap.odometerM} m, ${snap.doppler ? 'Doppler-gated' : snap.doppler === false ? 'position only' : 'no fix yet'}`}
          big
        />
        <Readout label="Speed" value={snap.speedKmh.toFixed(1)} unit="km/h" sub={snap.moving ? 'in motion' : 'stationary'} />
        <Readout
          label="Aboard"
          value={snap.occupancy.onboard}
          unit={`/ ${snap.capacity}`}
          sub={snap.occupancy.atCapacity ? 'AT CAPACITY' : `${snap.occupancy.seatsLeft} places left`}
          tone={snap.occupancy.atCapacity ? 'bad' : snap.occupancy.nearCapacity ? 'warn' : null}
        />
        <Readout label="Trip takings" value={snap.accrued + (snap.cash?.npr ?? 0)} unit="NPR" sub={`${snap.closed.length} rides closed · Rs ${snap.cash?.npr ?? 0} cash (${snap.cash?.tickets ?? 0})`} />
        <Readout
          label="Door count"
          value={snap.counted ?? '—'}
          sub={snap.counted === null
            ? 'no counter heard this trip'
            : `${snap.closed.length + snap.occupancy.onboard + (snap.cash?.tickets ?? 0)} of them on the record`}
        />
      </div>

      <div className="gauge" aria-label={`${snap.occupancy.onboard} of ${snap.capacity} aboard`}>
        {Array.from({ length: snap.capacity }, (_, i) => (
          <i key={i} className={i < snap.occupancy.onboard ? 'gauge__cell gauge__cell--full' : 'gauge__cell'} />
        ))}
      </div>
      <p className="card__note">
        {snap.vehicle?.seated ?? VEHICLE.seated} seated + {snap.vehicle?.standing ?? VEHICLE.standing} standing is the figure on this vehicle&apos;s route permit.
        On a one-door bus the door stays open at the permit for people getting off, and the next
        tap-in is refused. A second, rear door is never held shut by capacity.
      </p>
      <div className="card__row">
        <button type="button" className="quiet" onClick={() => meter().countBoarding(1)}>
          Door counter: +1 body (bench)
        </button>
      </div>
    </section>
  );
}

function Readout({ label, value, unit, sub, big, tone }) {
  return (
    <div className={`readout${big ? ' readout--big' : ''}${tone ? ` readout--${tone}` : ''}`}>
      <small>{label}</small>
      <b className="tabular">
        {value}
        <span>{unit}</span>
      </b>
      <em>{sub}</em>
    </div>
  );
}

/* ---------------------------------------------------------------- corridor */

function Corridor({ snap }) {
  const pct = Math.max(0, Math.min(1, snap.chainagePct));
  return (
    <section className="card card--wide">
      <h2 className="card__title">
        Route R11
        <span>nearest stage, from the live fix — not map-matched, and labelled as such</span>
      </h2>
      <div className="corridor">
        <div className="corridor__rail">
          <i className="corridor__bus" style={{ left: `${pct * 100}%` }} aria-hidden="true" />
          {STOPS.map((s) => (
            <span
              key={s.code}
              className="corridor__tick"
              style={{ left: `${(s.chainM / ROUTE_LENGTH_M) * 100}%` }}
            />
          ))}
        </div>
        <ol className="corridor__names">
          {STOPS.map((s) => (
            <li key={s.code} style={{ left: `${(s.chainM / ROUTE_LENGTH_M) * 100}%` }}>
              <b>{s.ne}</b>
              <small className="tabular">{(s.chainM / 1000).toFixed(1)}</small>
            </li>
          ))}
        </ol>
      </div>
      <dl className="kv">
        <div><dt>Fix</dt><dd className="tabular">{snap.fix ? `${snap.fix.lat.toFixed(5)}, ${snap.fix.lon.toFixed(5)}` : 'none'}</dd></div>
        <div><dt>Accuracy</dt><dd className="tabular">{snap.fix ? `±${Math.round(snap.fix.accuracy)} m` : '—'}</dd></div>
        <div><dt>Fixes</dt><dd className="tabular">{snap.odo.accepted} kept / {snap.odo.rejected} rejected</dd></div>
        <div><dt>Unverified</dt><dd className="tabular">{Math.round(snap.odo.unverifiedMetres)} m</dd></div>
      </dl>
    </section>
  );
}

/* ---------------------------------------------------------------- accuracy */

/*
  "How do you know the kilometres are right?" is the first question anyone with
  money in this asks, so the console answers it on the panel rather than in a
  document. Three parts: which grade of measurement the receiver allows right
  now, the bench drive's live error against a road whose length it knows, and a
  recorder for taking the meter onto a real road and checking it there.
*/
function Accuracy({ snap, unit }) {
  const [known, setKnown] = useState('');
  const grade = snap.doppler === null
    ? { label: 'waiting for a fix', tone: 'warn', note: 'No receiver output yet.' }
    : snap.doppler
      ? { label: 'measured grade', tone: 'ok', note: 'Receiver reports Doppler speed. Within ±2% at every traffic speed in simulation; a moving-bus trial is next, and the recorder below is how it is scored.' }
      : { label: 'conservative grade', tone: 'warn', note: 'No Doppler from this receiver. The meter may under-read in stop-and-go traffic; it never over-reads.' };

  function finish() {
    const text = unit.stopTrace();
    downloadText(`bhada-trace-${snap.vehicleId}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`, text);
  }

  function mark() {
    const metres = Number(known);
    unit.markTrace(`mark ${snap.marks.length}`, known.trim() && Number.isFinite(metres) ? metres : undefined);
    setKnown('');
  }

  return (
    <section className="card card--wide accuracy">
      <h2 className="card__title">
        Distance accuracy
        <span>how the kilometres on a receipt are known to be right</span>
      </h2>

      <div className="accuracy__row">
        <Chip label="receiver" value={grade.label} tone={grade.tone} />
        <Chip label="screen" value={snap.screenHeld ? 'held awake' : 'may sleep'} tone={snap.screenHeld ? 'ok' : 'warn'} />
        <Chip label="speed" value={snap.speedKmh.toFixed(1)} />
        {snap.power?.supported ? (
          <Chip
            label="power"
            value={snap.power.sinking ? 'losing charge' : snap.power.charging ? 'charging' : 'on battery'}
            tone={snap.power.sinking ? 'bad' : snap.power.charging ? 'ok' : 'warn'}
          />
        ) : null}
      </div>
      <p className="card__note">{grade.note}</p>
      {snap.power?.sinking ? (
        <p className="card__note">
          Plugged in and still losing charge — the box is hot enough that the charger cannot keep up.
          The screen has been released to shed load; the receiver keeps running, which is the half that
          meters the fare. Move the unit somewhere with air before the battery swells.
        </p>
      ) : null}

      {snap.bench ? (
        <div className="truth">
          <div>
            <small>Bench road, true</small>
            <b className="tabular">{(snap.bench.truthM / 1000).toFixed(3)} km</b>
          </div>
          <div>
            <small>Meter measured</small>
            <b className="tabular">{(snap.bench.meteredM / 1000).toFixed(3)} km</b>
          </div>
          <BenchError bench={snap.bench} />
        </div>
      ) : (
        <p className="card__empty">
          Run the bench drive below to watch the meter measured against a road of known length, live —
          stop-and-go traffic, receiver wander and all.
        </p>
      )}

      <div className="recorder">
        {snap.recording ? (
          <>
            <p>
              Recording — <b className="tabular">{snap.recordedFixes}</b> fixes, {snap.marks.length} mark(s).
              At a known point, enter the distance from the start if you know it, and drop a mark.
            </p>
            <div className="recorder__row">
              <input
                inputMode="numeric"
                placeholder="known metres from start (optional)"
                value={known}
                onChange={(e) => setKnown(e.target.value.replace(/[^0-9.]/g, ''))}
                aria-label="Known distance from the start, in metres"
              />
              <button type="button" onClick={mark}>Drop mark</button>
              <button type="button" className="quiet" onClick={finish}>Stop and save trace</button>
            </div>
          </>
        ) : (
          <>
            <p>
              Take this unit on a real road — a running track, a stretch between kilometre stones, or the
              whole of R11 — and record every fix. <code>npm run trace:replay</code> replays the file through
              this same odometer and scores it against the true distance.
            </p>
            <button type="button" onClick={() => unit.startTrace()}>Start recording a trace</button>
          </>
        )}
      </div>
    </section>
  );
}

/*
  Error against the bench road. Over the first few hundred metres a few metres
  of chord is a large percentage and means nothing, so short runs read in
  metres; past a kilometre the percentage is the honest figure. Within tolerance
  is ±2% or ±25 m, whichever is looser — the same allowance a fare can absorb.
*/
function BenchError({ bench }) {
  const diff = bench.meteredM - bench.truthM;
  const sign = diff >= 0 ? '+' : '−';
  const ok = Math.abs(bench.errorPct) <= 2 || Math.abs(diff) <= 25;
  const text = bench.truthM < 1000
    ? `${sign}${Math.abs(Math.round(diff))} m`
    : `${sign}${Math.abs(bench.errorPct).toFixed(2)}%`;
  return (
    <div className={ok ? 'truth--ok' : 'truth--off'}>
      <small>{bench.truthM < 1000 ? 'Error so far' : `Error, ${sign}${Math.abs(Math.round(diff))} m`}</small>
      <b className="tabular">{bench.truthM < 50 ? '—' : text}</b>
    </div>
  );
}

/* ------------------------------------------------------------------- doors */

function Doors({ snap, unit, confirmOverride, setConfirmOverride }) {
  return (
    <section className="card">
      <h2 className="card__title">
        Door interlock
        <span>the fare computer and the load limiter are the same box</span>
      </h2>

      {['A', 'B'].map((id) => {
        const door = snap.doors[id];
        return (
          <div key={id} className={`door door--${door.state}`}>
            <div className="door__id">
              <b>{id}</b>
              <small>{door.en}</small>
            </div>
            <div className="door__state">
              <b>{door.state.toUpperCase()}</b>
              <small>{reasonText(door.reason)}</small>
            </div>
            <button
              type="button"
              className="door__cmd"
              onClick={() => unit.commandDoor(id, !door.commanded)}
            >
              {door.commanded ? 'close' : 'open'}
            </button>
          </div>
        );
      })}

      <label className="stepper">
        <span>Permitted capacity</span>
        <div>
          <button type="button" onClick={() => unit.setCapacity(snap.capacity - 1)} aria-label="one fewer">−</button>
          <b className="tabular">{snap.capacity}</b>
          <button type="button" onClick={() => unit.setCapacity(snap.capacity + 1)} aria-label="one more">+</button>
        </div>
      </label>

      {snap.override ? (
        <button type="button" className="danger danger--on" onClick={() => { unit.setOverride(false); setConfirmOverride(false); }}>
          Interlock OVERRIDDEN — restore
        </button>
      ) : confirmOverride ? (
        <div className="confirm">
          <p>
            Overriding lets the bus board past its permitted capacity. The override is written to
            the device tape with a timestamp and travels with the trip record.
          </p>
          <div>
            <button type="button" className="danger" onClick={() => { unit.setOverride(true); setConfirmOverride(false); }}>
              Override anyway
            </button>
            <button type="button" className="quiet" onClick={() => setConfirmOverride(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="quiet" onClick={() => setConfirmOverride(true)}>
          Override interlock…
        </button>
      )}
    </section>
  );
}

function reasonText(reason) {
  return {
    clear: 'clear',
    at_capacity: 'held — bus is at permitted capacity',
    in_motion: 'held — vehicle above walking pace',
    manual_override: 'interlock overridden by crew',
    boot: 'powered up',
  }[reason] ?? reason;
}

/* ---------------------------------------------------------------- manifest */

function Manifest({ snap }) {
  const rows = useMemo(
    () => snap.onboard.map((leg) => {
      // What this passenger owes if they stepped off right now. Same function
      // the receipt uses, so nothing on screen can disagree with what is charged.
      // A ride boarded against a door's own odometer (the meter was down) cannot
      // be measured on this one — subtracting two rulers is how "39 km ridden"
      // appears for a ten-minute ride — so it is priced at the door instead.
      const sameRuler = !leg.boardUnitId || leg.boardUnitId === `M${snap.vehicleId}`;
      const metres = sameRuler ? Math.max(0, snap.odometerM - (leg.boardOdoM ?? 0)) : null;
      // The stage fare from where they got on to where the bus is now: what
      // they would pay stepping off here. Distance is shown, not charged.
      const boardStage = stageNear(CURRENT_TARIFF, leg.boardFix ?? leg.fix);
      const nowStage = stageNear(CURRENT_TARIFF, snap.fix);
      const running = boardStage && nowStage
        ? priceDistance(metres ?? 0, { concession: leg.concession, tariff: CURRENT_TARIFF, boardStage, alightStage: nowStage })
        : null;
      return { leg, running, metres, boardStage, nowStage };
    }),
    [snap.onboard, snap.odometerM, snap.vehicleId, snap.fix],
  );

  return (
    <section className="card card--wide">
      <h2 className="card__title">
        Aboard now
        <span>{snap.onboard.length} aboard · each owes the stage fare from where they got on</span>
      </h2>
      {rows.length === 0 ? (
        <p className="card__empty">Nobody aboard. The first tap at a door opens a leg.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Passenger</th>
              <th>Boarded</th>
              <th>Now at</th>
              <th>Ridden</th>
              <th>Concession</th>
              <th>Fare if off here</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ leg, running, metres, boardStage, nowStage }) => (
              <tr key={leg.legId}>
                <td>
                  <b>{leg.alias ?? short(leg.passengerPublicKey)}</b>
                  <small>{leg.legId}</small>
                </td>
                <td>{stageName(CURRENT_TARIFF, boardStage)?.en ?? '—'}</td>
                <td>{stageName(CURRENT_TARIFF, nowStage)?.en ?? '—'}</td>
                <td className="tabular">{metres === null ? 'another odometer' : `${(metres / 1000).toFixed(2)} km`}</td>
                <td>{leg.concession === 'none' ? '—' : leg.concession}</td>
                <td className="tabular grid__fare">{running ? rupees(running.amount) : 'at the door'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- completed */

function Completed({ snap }) {
  return (
    <section className="card card--wide">
      <h2 className="card__title">
        Closed this trip
        <span>every ride carries the measurement it was priced from</span>
      </h2>
      {snap.closed.length === 0 ? (
        <p className="card__empty">No completed rides yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Passenger</th>
              <th>Distance</th>
              <th>Measured by</th>
              <th>Doors</th>
              <th>Fare</th>
            </tr>
          </thead>
          <tbody>
            {snap.closed.slice(0, 14).map((leg) => (
              <tr key={leg.legId}>
                <td>
                  <b>{leg.alias ?? short(leg.passengerPublicKey)}</b>
                  <small>{leg.receipt ? 'signed by vehicle' : 'unsigned'}</small>
                </td>
                <td className="tabular">{(leg.distanceM / 1000).toFixed(2)} km</td>
                <td>
                  <span className={`badge badge--${leg.distanceSource}`}>{leg.distanceSource}</span>
                  {leg.distanceNote ? <small>{leg.distanceNote}</small> : null}
                </td>
                <td className="tabular">{leg.boardDoorId} → {leg.alightDoorId ?? '—'}</td>
                <td className="tabular grid__fare">{rupees(leg.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- crew */

/*
  Who is working this bus, and therefore who the clean-trip bonus belongs to.

  A conductor is not an employee record here: they hold an ordinary Bhada
  wallet, the same one they ride on, and show the console a CR1 their own phone
  signed. The console checks that signature itself — this is the one moment a
  screenshot of somebody else's sign-on could be held up to a camera — and the
  backend checks it again when the batch goes up.

  The sign-on outlives the trip. A conductor runs eight of them before going
  home, and asking for a fresh scan at every terminus is how a feature gets
  switched off in week one.
*/
function Crew({ snap, unit }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);

  async function signOn() {
    const verdict = await unit.signOnCrew(text);
    setError(verdict?.ok ? null : (verdict?.message ?? 'That is not a sign-on this bus can read.'));
    if (verdict?.ok) setText('');
  }

  return (
    <section className="card">
      <h2 className="card__title">
        Crew on this shift
        <span>a clean trip pays the conductor Rs 50 — the bonus follows this key</span>
      </h2>

      {snap.crew ? (
        <>
          <dl className="kv kv--tight">
            <div><dt>signed on</dt><dd className="tabular">{short(snap.crew.publicKey)}</dd></div>
            <div>
              <dt>since</dt>
              <dd className="tabular">{new Date(snap.crew.signedOnAt * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</dd>
            </div>
            <div><dt>trips this shift</dt><dd className="tabular">{snap.crew.trips?.length ?? 0}</dd></div>
          </dl>
          <button type="button" className="quiet" onClick={() => unit.signOffCrew()}>Sign off</button>
        </>
      ) : (
        <>
          <p className="card__empty">Nobody is signed on. Trips run now earn no bonus.</p>
          <textarea
            value={text}
            onChange={(event) => { setText(event.target.value); setError(null); }}
            rows={3}
            placeholder="CR1|…"
            aria-label="Crew sign-on code"
          />
          <button type="button" onClick={signOn} disabled={!text.trim()}>Sign on</button>
          {error ? <p className="card__note">{error}</p> : null}
        </>
      )}

      {snap.powerPulled ? (
        <p className="card__note">
          The 12&nbsp;V feed is out with the bus moving. This is on the tape, and this trip will not
          pay a bonus until the meter is plugged back in and a fresh trip starts.
        </p>
      ) : null}
    </section>
  );
}

/* ---------------------------------------------------------------- registry */

function Registry({ snap }) {
  return (
    <section className="card">
      <h2 className="card__title">
        Passengers known to this unit
        <span>a key registers itself the first time it taps — no sign-up, no phone number</span>
      </h2>
      {snap.registry.length === 0 ? (
        <p className="card__empty">No keys seen yet.</p>
      ) : (
        <ul className="people">
          {snap.registry.slice(0, 12).map((person) => (
            <li key={person.publicKey}>
              <b>{person.alias ?? short(person.publicKey)}</b>
              <small>
                {person.rides} ride(s) · {rupees(person.spent)} ·{' '}
                {person.concession === 'none'
                  ? 'full fare'
                  : `${person.concession}${person.concessionVerified ? '' : ' (unverified)'}`}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- telemetry */

function Telemetry({ snap }) {
  const decoded = useMemo(() => {
    if (!snap.frameBytes) return null;
    try {
      return decodeFrame(snap.frameBytes);
    } catch {
      return null;
    }
  }, [snap.frameBytes]);

  return (
    <section className="card">
      <h2 className="card__title">
        Uplink frame
        <span>32 bytes, once a second — sized for a 2G SIM and a LoRa duty cycle</span>
      </h2>
      <pre className="hex">{snap.frameHex || '—'}</pre>
      {decoded ? (
        <dl className="kv kv--tight">
          <div><dt>occupancy</dt><dd className="tabular">{decoded.occupancy} / {decoded.capacity}</dd></div>
          <div><dt>odometer</dt><dd className="tabular">{decoded.odometerMetres} m</dd></div>
          <div><dt>position</dt><dd className="tabular">{(decoded.latMicro / 1e6).toFixed(5)}, {(decoded.lonMicro / 1e6).toFixed(5)}</dd></div>
          <div><dt>speed</dt><dd className="tabular">{(decoded.speedCmS / 100).toFixed(1)} m/s</dd></div>
          <div><dt>accrued</dt><dd className="tabular">{rupees(decoded.accrued)}</dd></div>
          <div><dt>flags</dt><dd>{decoded.flagNames.length ? decoded.flagNames.join(' · ') : 'none'}</dd></div>
        </dl>
      ) : null}
      <p className="card__note">
        The same 32 bytes as JSON run to about 210. On a bus doing 14 hours a day that is the
        difference between a data SIM an operator renews and one they cancel.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------- tape */

function Tape({ snap }) {
  return (
    <section className="card card--wide">
      <h2 className="card__title">
        Device tape
        <span>append-only, kept on the box — the record an operator disputes a fare against</span>
      </h2>
      <ol className="tape">
        {snap.events.slice(0, 40).map((event) => (
          <li key={`${event.at}-${event.seq}`} className={event.severity ? `tape--${event.severity}` : undefined}>
            <time className="tabular">{new Date(event.at).toLocaleTimeString('en-GB')}</time>
            <b>{event.kind}</b>
            <span>{event.text}</span>
          </li>
        ))}
        {snap.events.length === 0 ? <li><span>Nothing logged yet.</span></li> : null}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------- bench */

function Bench({ snap, unit, onPair, onRoster }) {
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    setBusy(true);
    setNote(null);
    try {
      const result = await syncMeter({
        vehicleId: snap.vehicleId,
        publicKey: snap.vehiclePublicKey,
        capacity: snap.capacity,
        firmware: VEHICLE.firmware,
      });
      await unit.refreshQueue();
      setNote(
        `${result.settled} settled, ${result.rejected} refused, ${result.awaiting} waiting for the passenger's tap, ${result.tape} door events filed.`,
      );
    } catch (error) {
      // A failed upload is not a lost fare. The receipts stay queued on the box
      // and the next window retries them, which is the whole reason they are
      // signed on the vehicle rather than computed by the server.
      setNote(`Upload failed: ${error.message}. Nothing lost — receipts stay queued.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="card__title">
        Bench controls
        <span>for a unit on a desk rather than under a seat</span>
      </h2>
      <div className="bench">
        <button
          type="button"
          className={snap.simulating ? 'bench__on' : undefined}
          onClick={() => unit.simulate(!snap.simulating)}
        >
          {snap.simulating ? 'Stop bench drive' : 'Run bench drive'}
          <small>feeds scripted fixes through the same gates as the receiver</small>
        </button>
        <button type="button" onClick={onRoster}>
          Inspection code
          <small>who is on the record, signed by this bus — for an inspector’s phone</small>
        </button>
        <button type="button" onClick={onPair}>
          Pair a door terminal
          <small>shows the provisioning code — camera only, never sent anywhere</small>
        </button>
        <button type="button" onClick={() => unit.markTamper(!snap.tamper)}>
          {snap.tamper ? 'Clear tamper flag' : 'Trip tamper switch'}
          <small>sets the TAMPER bit in the uplink frame</small>
        </button>
        <button type="button" onClick={upload} disabled={busy || !syncConfigured()}>
          {busy ? 'Uploading…' : 'Upload to backend'}
          <small>
            {syncConfigured()
              ? `${snap.queued} signed receipt(s) queued · re-verified and re-priced server side`
              : 'No sync endpoint configured — set VITE_SYNC_URL'}
          </small>
        </button>
        <button type="button" className="bench__end" onClick={() => unit.endTrip()}>
          End trip
          <small>anyone still aboard is charged the {rupees(snap.tariff.unclosedLegFare)} cap, half for concessions</small>
        </button>
      </div>
      {note ? <p className="card__note">{note}</p> : null}
      <p className="card__note">
        A bench drive is not a shortcut into the odometer. The scripted fixes are handed to the same
        fusion function a receiver&apos;s are, and they are rejected by the same gates.
      </p>
    </section>
  );
}

function Roster({ roster, snap, onRefresh, onClose }) {
  return (
    <div className="sheet" role="dialog" aria-label="Inspection code">
      <div className="sheet__body">
        <h3>Inspection code</h3>
        <p>
          {snap.onboard.length} ride{snap.onboard.length === 1 ? '' : 's'} open, {snap.cash?.tickets ?? 0} cash
          ticket{(snap.cash?.tickets ?? 0) === 1 ? '' : 's'} this trip
          {snap.counted !== null && snap.counted !== undefined ? `, ${snap.counted} counted through the door` : ''}.
          The inspector scans this on <b>/inspect</b>, then each passenger’s ride code. Good for three minutes.
        </p>
        <img src={roster.image} alt="Inspection roster QR code" />
        <div className="sheet__row">
          <button type="button" onClick={onRefresh}>Fresh code</button>
          <button type="button" className="quiet" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Pairing({ pairing, onClose }) {
  return (
    <div className="sheet" role="dialog" aria-label="Terminal pairing code">
      <div className="sheet__body">
        <h3>Pair a door terminal</h3>
        <p>
          Open <b>/terminal</b> on the door phone, choose its door, and scan this. The vehicle key
          crosses by camera and goes no further.
        </p>
        <img src={pairing.image} alt="Pairing QR code" />
        <textarea readOnly value={pairing.payload} rows={4} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
