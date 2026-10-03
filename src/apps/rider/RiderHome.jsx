// Rider home. One question decides the whole screen: is this person on a bus?
//
// On a bus, the ride is the screen — the plate, how long, how far, the fare so
// far, and the way to get off. Not on a bus, boarding is the loudest thing,
// with the balance and the last rides under it. Everything here is read from
// this phone, so it opens the same with no signal.

import { useEffect, useState } from 'react';
import { Button, Icon, Money, Plate, Status, DemoTag, SkeletonList, Empty } from '../../ui';
import { loadIdentity } from '../../device/identity';
import { plateFromId } from '../../device/fleet';
import { db } from '../../storage/db';
import { stop } from '../../lib/nepali';
import { priceDistance } from '../../../protocol/meter.mjs';
import { OVERDRAFT_NPR } from '../../../protocol/policy.mjs';
import './rider.css';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'शुभ प्रभात · Good morning';
  if (h < 17) return 'नमस्ते · Good afternoon';
  return 'शुभ साँझ · Good evening';
}

function elapsed(fromMs, nowMs) {
  const min = Math.max(0, Math.floor((nowMs - fromMs) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

async function loadHome() {
  const identity = await loadIdentity();
  const database = await db();
  const ride = (await database.get('meter', 'passengerRide')) ?? { phase: 'idle' };
  const metered = ((await database.get('meter', 'passengerReceipts')) ?? []).map((entry) => ({
    id: `leg:${entry.legId}`,
    at: entry.leg.alightAt * 1000,
    plate: plateFromId(entry.leg.vehicleId),
    title: `${(entry.leg.distanceM / 1000).toFixed(1)} km`,
    amount: entry.leg.amount,
    kind: 'metered',
    // Checked again here against the tariff the receipt names: receipts saved
    // before that fix were judged against the current tariff.
    flag: priceDistance(entry.leg.distanceM, { concession: entry.leg.concession, tariffCode: entry.leg.tariffCode }).amount === entry.leg.amount
      ? null : 'Fare does not match the distance',
  }));
  const staged = (await database.getAll('payments')).map((row) => ({
    id: `stage:${row.sequenceNumber}`,
    at: row.timestamp * 1000,
    plate: plateFromId(row.conductorId),
    title: `${stop(row.boardingStop)?.ne ?? row.boardingStop} → ${stop(row.alightingStop)?.ne ?? row.alightingStop}`,
    amount: row.amount,
    kind: 'stage',
    waiting: !row.settled,
  }));
  const trips = [...metered, ...staged].sort((a, b) => b.at - a.at).slice(0, 8);
  return { identity, ride, trips };
}

export default function RiderHome({ go }) {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const read = () => loadHome().then((next) => { if (live) setState(next); }).catch(() => { if (live) setFailed(true); });
    read();
    // The ride screen saves the phone's distance as it goes; read it again so
    // the journey card here keeps up.
    const timer = setInterval(() => { setNow(Date.now()); read(); }, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const identity = state?.identity;
  const ride = state?.ride;
  const riding = ride?.phase === 'riding';
  const balance = identity?.balance ?? null;
  const checkedAt = identity?.serverBalanceAt ? identity.serverBalanceAt * 1000 : null;

  return (
    <div className="rh">
      {riding ? (
        <Journey ride={ride} now={now} onOpen={() => go('ride')} />
      ) : (
        <>
          <header className="rh-hello">
            <p className="bx-eyebrow">{greeting()}</p>
            <h1 className="rh-hello__q">Getting on a bus?</h1>
          </header>
          <button type="button" className="rh-board bx-ticket" onClick={() => go('ride')}>
            <span className="rh-board__main">
              <span className="rh-board__kicker">मिटर बस · Metered bus</span>
              <span className="rh-board__verb">चढ्नुहोस्</span>
              <span className="rh-board__sub">Show your ride code at the door. Works without internet.</span>
            </span>
            <span className="rh-board__stub">
              <Icon name="qr" />
              <span>कोड</span>
            </span>
          </button>
        </>
      )}

      <section className="rh-balance" aria-label="Ride balance">
        <div>
          <p className="bx-eyebrow">Ride balance</p>
          <p className="rh-amount bx-num">
            {balance === null ? <span className="bx-skel" style={{ width: 120, height: 40 }} /> : <><span className="rh-amount__cur">रु</span>{balance < 0 ? '−' : ''}{Math.abs(balance).toLocaleString('en-IN')}</>}
          </p>
          <p className="rh-asof">
            {checkedAt ? `Checked ${clock(checkedAt)} · topped up through eSewa` : 'Topped up through eSewa · read from this phone'}
          </p>
        </div>
        <Button variant="secondary" icon="topup" onClick={() => go('wallet')}>Top up</Button>
      </section>

      {balance !== null && balance < 0 ? (
        <p className="rh-over">
          <b>रु {Math.abs(balance)} short.</b> A bus still lets you ride while you are less than रु {OVERDRAFT_NPR} short. Top up before your next ride.
        </p>
      ) : null}

      <button type="button" className="rh-link" onClick={() => go('routes')}>
        <span className="rh-link__icon" aria-hidden="true"><Icon name="route" /></span>
        <span className="rh-link__body">
          <b>Routes and buses <DemoTag title="Bus positions on this screen are simulated">Demo fleet</DemoTag></b>
          <small>Valley routes, stops and fares. Bus positions are simulated.</small>
        </span>
        <Icon name="chevron" />
      </button>

      <section className="rh-trips" aria-label="Recent rides">
        <div className="rh-trips__head">
          <p className="bx-eyebrow">हालका यात्रा · Recent rides</p>
        </div>
        {failed ? (
          <Empty error title="Could not read this phone's rides">Nothing is lost — the rides are still stored. Close the app and open it again.</Empty>
        ) : !state ? (
          <SkeletonList rows={3} />
        ) : state.trips.length === 0 ? (
          <div className="rh-empty">
            <span className="rh-empty__ticket" aria-hidden="true"><Icon name="ticket" /></span>
            <p><b>No rides yet.</b> When you get off, the bus's signed receipt is saved here — even with no signal.</p>
          </div>
        ) : (
          <ol className="rh-list">
            {state.trips.map((trip) => {
              const when = new Date(trip.at);
              return (
                <li key={trip.id} className="rh-trip">
                  <span className="rh-trip__date">
                    <b className="bx-num">{when.getDate()}</b>
                    <small>{MONTHS[when.getMonth()]}</small>
                  </span>
                  <span className="bx-perf" aria-hidden="true" />
                  <span className="rh-trip__body">
                    <span className="rh-trip__title">{trip.title}</span>
                    <span className="rh-trip__sub">
                      {trip.plate ? <Plate plate={trip.plate} line size={12} /> : null}
                      <span>{clock(trip.at)}</span>
                    </span>
                    {trip.flag ? <span className="rh-trip__flag"><Icon name="alert" />{trip.flag}</span> : null}
                  </span>
                  <span className="rh-trip__end">
                    <Money value={-trip.amount} signed />
                    {trip.kind === 'metered'
                      ? <Status tone={trip.flag ? 'bad' : 'ok'}>{trip.flag ? 'Check' : 'Verified'}</Status>
                      : trip.waiting
                        ? <Status tone="wait">To send</Status>
                        : <Status tone="ok">Sent</Status>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

/*
  The journey card. Distance and fare are what this phone last measured — the
  ride screen keeps measuring — and the bus's own figure is the one charged,
  which the receipt shows at the door.
*/
function Journey({ ride, now, onOpen }) {
  const metres = Number.isFinite(ride.witnessM) ? ride.witnessM : 0;
  const fare = priceDistance(metres).amount;
  const plate = ride.vehicleId ? plateFromId(ride.vehicleId) : null;
  const online = typeof navigator === 'undefined' || navigator.onLine;
  return (
    <section className="rh-journey" aria-label="Your ride">
      <div className="rh-journey__top">
        <Status tone="live">यात्रामा · On ride</Status>
        {plate ? <Plate plate={plate} size={16} /> : null}
      </div>
      <p className="rh-journey__since">Since {clock(ride.startedAt ?? now)} · {elapsed(ride.startedAt ?? now, now)}</p>
      <div className="rh-journey__figs">
        <div>
          <small>Distance</small>
          <b className="bx-num">{(metres / 1000).toFixed(1)}<span>km</span></b>
        </div>
        <div>
          <small>Fare so far</small>
          <b className="bx-num">रु {fare}</b>
        </div>
      </div>
      <p className="rh-journey__note">Measured by your phone · the bus's meter sets the final fare</p>
      <Button block onClick={onOpen} icon="qr">Get off — show code</Button>
      <p className="rh-journey__net">
        <Icon name={online ? 'check' : 'offline'} />
        {online ? 'Saved on this phone' : 'Offline · the ride continues normally'}
      </p>
    </section>
  );
}
