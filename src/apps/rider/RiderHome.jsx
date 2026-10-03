// Rider home. The one thing a rider opens this app for on a bus is the code
// at the door, so boarding is the loudest thing on the screen; the balance
// sits above it and the rides below. Everything here is read from this phone,
// so it opens the same with no signal.

import { useEffect, useState } from 'react';
import { Button, Icon, Money, Plate, Stamp, SkeletonList, Empty } from '../../ui';
import { loadIdentity } from '../../device/identity';
import { plateFromId } from '../../device/fleet';
import { db } from '../../storage/db';
import { stop } from '../../lib/nepali';
import { OVERDRAFT_NPR } from '../../../protocol/policy.mjs';
import './rider.css';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

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
    flag: entry.arithmeticOk ? null : 'Fare does not match the distance',
  }));
  const staged = (await database.getAll('payments')).map((row) => ({
    id: `stage:${row.sequenceNumber}`,
    at: row.timestamp * 1000,
    plate: plateFromId(row.conductorId),
    title: `${stop(row.boardingStop)?.ne ?? row.boardingStop} → ${stop(row.alightingStop)?.ne ?? row.alightingStop}`,
    amount: row.amount,
    waiting: !row.settled,
  }));
  const trips = [...metered, ...staged].sort((a, b) => b.at - a.at).slice(0, 8);
  return { identity, ride, trips };
}

export default function RiderHome({ go }) {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadHome().then((next) => { if (live) setState(next); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const identity = state?.identity;
  const riding = state?.ride?.phase === 'riding';
  const balance = identity?.balance ?? null;
  const checkedAt = identity?.serverBalanceAt ? identity.serverBalanceAt * 1000 : null;

  return (
    <div className="rh">
      <section className="rh-balance" aria-label="Balance">
        <div>
          <p className="bx-eyebrow">खातामा · Balance</p>
          <p className="rh-amount bx-num">
            {balance === null ? <span className="bx-skel" style={{ width: 150, height: 52 }} /> : <><span className="rh-amount__cur">रु</span>{balance < 0 ? '−' : ''}{Math.abs(balance).toLocaleString('en-IN')}</>}
          </p>
          <p className="rh-asof">
            {checkedAt ? `Checked ${clock(checkedAt)} · works offline` : 'Kept on this phone · works offline'}
          </p>
        </div>
        <Button variant="secondary" icon="topup" onClick={() => go('wallet')}>Top up</Button>
      </section>

      {balance !== null && balance < 0 ? (
        <p className="rh-over">
          You are <b>रु {Math.abs(balance)}</b> into the <b>रु {OVERDRAFT_NPR}</b> a bus lets you ride on. Top up before your next ride.
        </p>
      ) : null}

      <button type="button" className={`rh-board bx-ticket${riding ? ' rh-board--riding' : ''}`} onClick={() => go('ride')}>
        <span className="rh-board__main">
          <span className="rh-board__kicker">{riding ? 'यात्रामा · On the bus' : 'मिटर बस · Metered bus'}</span>
          <span className="rh-board__verb">{riding ? 'ओर्लनुहोस्' : 'चढ्नुहोस्'}</span>
          <span className="rh-board__sub">
            {riding
              ? `Since ${clock(state.ride.startedAt ?? Date.now())}. Show your code at the door to get off.`
              : 'Show your code at the door. No signal needed.'}
          </span>
        </span>
        <span className="rh-board__stub">
          <Icon name="qr" />
          <span>कोड</span>
        </span>
      </button>

      <section className="rh-trips" aria-label="Recent rides">
        <div className="rh-trips__head">
          <p className="bx-eyebrow">हालका यात्रा · Recent rides</p>
        </div>
        {failed ? (
          <Empty error title="Could not read this phone's rides">Nothing is lost. Close the app and open it again.</Empty>
        ) : !state ? (
          <SkeletonList rows={3} />
        ) : state.trips.length === 0 ? (
          <div className="rh-empty">
            <span className="rh-empty__ticket" aria-hidden="true"><Icon name="ticket" /></span>
            <p><b>No rides yet.</b> Your first receipt lands here the moment you get off — even with no signal.</p>
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
                    {trip.waiting ? <Stamp small>पठाउन बाँकी</Stamp> : null}
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
