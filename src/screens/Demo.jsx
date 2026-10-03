// /demo — a whole one-door bus on one screen, for a room with no bus in it.
//
// Built for a projector and a presenter with a clicker: one scene at a time,
// one sentence of narration each, the space bar or → for the next. Everything
// that happens is the real code (see src/demo/stage.js). The numbers a
// sceptical judge should watch are in the header — requests to the internet,
// and the backend's state — and in the crew panel: bodies the door counted
// against rides and cash on the record.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import Scanner from '../components/Scanner';
import { STOPS, ROUTE_LENGTH_M } from '../lib/nepali';
import { unlockAudio, warmVoices, announceBoarded, announceFare, announceBusFull, cueRefused } from '../lib/voice';
import { navigate } from '../lib/router';
import '../styles/demo.css';

const REASON = {
  replay: 'Already used',
  bad_signature: 'Not signed by that phone',
  wrong_vehicle: 'Code for another bus',
  stale: 'Code expired',
  unreadable: 'Not a ride code',
  at_capacity: 'Bus full — getting on refused',
  unknown_card: 'Card not issued',
  no_tap_counted: 'Counted at the step, no ride code',
  not_recorded: 'No ride on this bus',
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function rupees(n) {
  return `Rs ${Number(n ?? 0).toLocaleString('en-IN')}`;
}

/*
  The scenes, in the order that answers what a judge will ask: does it work
  offline, does it survive a rush, what about people with no phone, families,
  people who do not tap, cheats, overloading, inspection, fares, people who
  never tap out, and does the money actually move — to the crew as well.
*/
function buildScenes(stage) {
  const aboard = () => stage.meter.snapshot().onboard.length;
  return [
    {
      key: 'ready',
      title: 'One bus. One door. No internet.',
      say: 'This laptop is the whole bus: the meter, the door, a counter at the step — and the backend. The internet is off. Watch the number top left.',
      run: async () => {},
    },
    {
      key: 'first',
      title: 'Amrita taps in',
      say: 'Her phone shows a signed ride code. The door checks the signature itself, with no server, in milliseconds. Nothing is charged yet: the fare depends on how far she rides.',
      run: async () => { await stage.board(0); },
    },
    {
      key: 'rush',
      title: 'Rush hour at Ratna Park',
      say: 'Ten people in six seconds, through one door. The code stays valid for five minutes, so people can tap once they are inside and nobody blocks the step.',
      run: async () => { await stage.rush([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); },
    },
    {
      key: 'cash',
      title: 'Hajurama pays in coins',
      say: 'No phone, no card. The conductor records her cash fare in two taps: priced by the same tariff, signed by the bus. It is what he owes the owner tonight.',
      run: async () => { await stage.cashRider(17); },
    },
    {
      key: 'family',
      title: 'Gita and her two children',
      say: 'One phone, one code, three people. Each child rides under a key made from Gita’s phone, and all three fares are charged to her one account.',
      run: async () => { await stage.familyCode(); },
    },
    {
      key: 'dodger',
      title: 'Bikash slips in without tapping',
      say: 'In the crush, one man does not tap. The door never sees him — but the counter at the step does. Watch the crew panel: counted one more than on the record.',
      run: async () => { await stage.dodger(18); },
    },
    {
      key: 'drive1',
      title: 'The bus moves',
      say: 'The meter measures the road from GPS, stop-and-go along the real R11 corridor. Every fare on this bus is priced against this one odometer.',
      run: async () => { await stage.driveFor(2200); },
    },
    {
      key: 'cheats',
      title: 'Three ways to cheat',
      say: 'Sita boards. Her friend holds up a screenshot of the same code: refused. A code forged with somebody else’s key: refused. A code made for another bus: refused.',
      run: async () => {
        await stage.board(11);
        await pause(1400);
        await stage.screenshot(11, 'Sita’s friend (screenshot)');
        await pause(1400);
        await stage.forged();
        await pause(1400);
        await stage.wrongBus(12);
      },
    },
    {
      key: 'full',
      title: 'The permit, not the conductor',
      say: 'This bus is licensed for one more. The next person boards; the one after is refused by the count, not by anyone’s mood. It is the only door, so it stays open — and Amrita gets off.',
      run: async () => {
        stage.setCapacity(aboard() + 1);
        await pause(1200);
        await stage.board(12);
        await pause(1500);
        await stage.board(13);
        await pause(1800);
        await stage.alight(0);
      },
    },
    {
      key: 'inspect',
      title: 'An inspector boards',
      say: 'Her phone scans the meter’s signed roster and checks it against the bus register she downloaded this morning — no signal needed. Bishal: on record. Bikash: not on record. He pays cash on the spot, and the count balances.',
      run: async () => {
        await stage.inspect([1, 18], 1);
        await pause(3500);
        await stage.settleDodger(18);
      },
    },
    {
      key: 'alight',
      title: 'Tap out, pay by the kilometre',
      say: 'Three kilometres on, people tap out at the same door. Each fare is the published tariff for the kilometres actually ridden, spoken aloud, with a signed receipt on the passenger’s phone.',
      run: async () => {
        await stage.driveFor(3100);
        for (const id of [1, 2, 3, 4, 5]) {
          await stage.alight(id);
          await pause(900);
        }
      },
    },
    {
      key: 'end',
      title: 'Koteshwor. Two never tapped out.',
      say: 'End of the line. Gita’s family taps out together. Two people walked off without tapping: their rides close at the Rs 25 cap — the reason everyone taps out.',
      run: async () => {
        await stage.driveFor(1500);
        for (const id of [6, 7, 8, 11, 12]) {
          await stage.alight(id);
          await pause(700);
        }
        await stage.familyCode();
        await pause(900);
        await stage.endTrip();
      },
    },
    {
      key: 'signal',
      title: 'Signal. The money moves.',
      say: 'The bus reaches signal and uploads — the same code a real bus runs — to the real backend on Postgres, inside this laptop. Every account charged once. The count matched the record, so the conductor earns his Rs 50.',
      run: async () => { await stage.signalBack(); },
    },
    {
      key: 'replay',
      title: 'Send it all again',
      say: 'Someone replays the entire upload. Every ride and every cash ticket comes back as a replay, and not one rupee moves.',
      run: async () => { await stage.replayUpload(); },
    },
    {
      key: 'you',
      title: 'Your turn',
      say: 'Open bhada-one.vercel.app/app on your own phone, tap यात्रु, and show your ride code to this laptop’s camera. Your phone, this bus, no internet.',
      run: async () => {},
      you: true,
    },
  ];
}

export default function Demo() {
  const [stage, setStage] = useState(null);
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState(null);

  const start = useCallback(async () => {
    unlockAudio();
    warmVoices();
    setBooting(true);
    try {
      const { createStage } = await import('../demo/stage');
      setStage(await createStage());
    } catch (problem) {
      setError(problem.message);
    }
    setBooting(false);
  }, []);

  if (!stage) {
    return (
      <div className="demo demo--cover">
        <div className="demo-cover">
          <p className="demo-cover__eyebrow">Live demonstration</p>
          <h1>भाडा</h1>
          <p className="demo-cover__line">Bus fares by the kilometre. Loads by the permit. No signal needed for either.</p>
          <ul className="demo-cover__facts">
            <li>A real one-door bus: meter, door, a counter at the step</li>
            <li>Cash riders, families, fare dodgers and an inspector</li>
            <li>Real Postgres backend, running in this browser</li>
            <li>Zero requests to the internet — counted on screen</li>
          </ul>
          {error ? <p className="demo-cover__error">{error}</p> : null}
          <button type="button" className="demo-cover__go" onClick={start} disabled={booting}>
            {booting ? 'Starting the bus…' : 'Start the bus'}
          </button>
          <p className="demo-cover__hint">Space or → for the next scene · Turn Wi-Fi off first, for effect</p>
          <button type="button" className="demo-cover__back" onClick={() => navigate('/')}>← bhada-one.vercel.app</button>
        </div>
      </div>
    );
  }
  return <Show stage={stage} />;
}

function Show({ stage }) {
  const scenes = useMemo(() => buildScenes(stage), [stage]);
  const [demo, setDemo] = useState(stage.state());
  const [bus, setBus] = useState(stage.meter.snapshot());
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [camera, setCamera] = useState(false);
  const [yours, setYours] = useState(null);
  const heard = useRef(0);

  useEffect(() => stage.subscribe(setDemo), [stage]);
  useEffect(() => stage.meter.subscribe(setBus), [stage]);

  // Sound: the door speaks, as it does on a bus.
  useEffect(() => {
    const latest = demo.feed[0];
    if (!latest || latest.at === heard.current) return;
    heard.current = latest.at;
    const { result } = latest;
    if (latest.counterOnly) return;
    if (result.reason === 'at_capacity') announceBusFull();
    else if (result.ok && (result.action === 'in' || (result.action === 'group' && result.boarded))) announceBoarded();
    else if (result.ok && result.action === 'out') announceFare(result.price?.amount ?? result.leg?.amount ?? 0);
    else if (result.ok && result.action === 'group' && result.alighted) announceFare(result.amount);
    else if (result.ok && result.action === 'cash') announceFare(result.ticket.amount);
    else if (!result.ok) cueRefused();
  }, [demo.feed]);

  const scene = scenes[index];

  const next = useCallback(async () => {
    if (running) return;
    const upcoming = scenes[index + 1];
    if (!upcoming) return;
    setIndex(index + 1);
    setRunning(true);
    try {
      await upcoming.run();
    } finally {
      setRunning(false);
    }
  }, [index, running, scenes]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA') return;
      if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next]);

  // A judge's own phone, through the laptop camera.
  const onYourCode = useCallback(async (text) => {
    setCamera(false);
    const { result } = await stage.present(text, 'Your phone');
    const qr = result.ok ? (result.action === 'in' ? result.passQr : result.receipt) : null;
    const image = qr ? await QRCode.toDataURL(qr, { margin: 1, width: 520, errorCorrectionLevel: result.action === 'in' ? 'M' : 'L' }) : null;
    setYours({ result, image });
  }, [stage]);

  const progress = Math.min(1, (bus.odometerM ?? 0) / ROUTE_LENGTH_M);
  const aboard = bus.onboard.length;
  const full = aboard >= bus.capacity;
  const fares = demo.passengers.reduce((sum, p) => sum + (['done', 'unclosed', 'cash', 'caught'].includes(p.status) ? p.fare ?? 0 : 0), 0);

  return (
    <div className="demo">
      <header className="demo-head">
        <div className="demo-head__brand">
          <b>भाडा</b>
          <span>Live · {stage.vehicleId} · one door</span>
        </div>
        <Stat
          label="Requests to the internet"
          value={demo.internetRequests}
          tone={demo.internetRequests === 0 ? 'good' : demo.signal ? 'quiet' : 'bad'}
          note={demo.signal ? 'signal is back' : 'no signal'}
        />
        <Stat label="Backend" value={demo.backend ? 'Postgres, in this laptop' : 'starting…'} note={demo.backendStep} tone={demo.backend ? 'good' : 'quiet'} small />
        <Stat label="Signal" value={demo.signal ? 'ON' : 'OFF'} tone={demo.signal ? 'good' : 'bad'} note={demo.signal ? `${demo.backendRequests} uploads answered` : 'everything waits on the bus'} />
      </header>

      <section className="demo-route" aria-label="Route R11">
        <div className="demo-route__line">
          {STOPS.map((s) => (
            <span key={s.code} className="demo-route__stop" style={{ left: `${(s.chainM / ROUTE_LENGTH_M) * 100}%` }}>
              <i />
              <small>{s.en}</small>
            </span>
          ))}
          <span className={`demo-route__bus${demo.warping ? ' is-moving' : ''}`} style={{ left: `${progress * 100}%` }} aria-hidden="true">▶</span>
          <span className="demo-route__done" style={{ width: `${progress * 100}%` }} />
        </div>
        <dl className="demo-readouts">
          <div><dt>Odometer</dt><dd className="tabular">{((bus.odometerM ?? 0) / 1000).toFixed(2)}<small> km</small></dd></div>
          <div className={full ? 'is-full' : ''}>
            <dt>Tapped in / permit</dt>
            <dd className="tabular">{aboard}<small> / {bus.capacity}</small></dd>
            <meter min={0} max={bus.capacity} value={aboard} />
          </div>
          <div><dt>Fares taken</dt><dd className="tabular">{rupees(fares)}</dd></div>
          <div><dt>Waiting to upload</dt><dd className="tabular">{bus.queued}<small> {bus.queued === 1 ? 'ride' : 'rides'}</small></dd></div>
        </dl>
      </section>

      <section className="demo-grid">
        <Door entry={demo.feed.find((e) => e.who !== 'Meter' && !e.counterOnly) ?? null} rush={demo.rush} onCamera={() => setCamera(true)} />
        <Crew demo={demo} bus={bus} />
        <Backend demo={demo} bus={bus} />
      </section>

      <section className="demo-people" aria-label="Passengers">
        {demo.passengers.map((p) => (
          <div key={p.id} className={`demo-person demo-person--${p.status}`}>
            <b>{p.name}</b>
            <span>{personLine(p)}</span>
            {p.balance ? (
              <small className="tabular">{p.balance.shared ? 'on Gita’s account' : `${rupees(p.balance.before)} → ${rupees(p.balance.after)}`}</small>
            ) : null}
          </div>
        ))}
      </section>

      <footer className="demo-say">
        <div className="demo-say__count tabular">{index + 1}/{scenes.length}</div>
        <div className="demo-say__text">
          <h2>{scene.title}</h2>
          <p>{scene.say}</p>
        </div>
        <div className="demo-say__controls">
          {scene.you ? (
            <button type="button" className="demo-btn demo-btn--go" onClick={() => setCamera(true)}>Open the camera</button>
          ) : (
            <button type="button" className="demo-btn demo-btn--go" onClick={next} disabled={running || index === scenes.length - 1}>
              {running ? 'Running…' : 'Next ▶'}
            </button>
          )}
          <button type="button" className="demo-btn" onClick={() => window.location.reload()}>Restart</button>
        </div>
      </footer>

      {camera ? (
        <Scanner label="Show your ride code to the door" onText={onYourCode} onClose={() => setCamera(false)} />
      ) : null}

      {yours ? (
        <div className="demo-yours" role="dialog" aria-label="Your ride">
          <div className="demo-yours__card">
            <h2 className={yours.result.ok ? 'is-ok' : 'is-no'}>
              {yours.result.ok ? (yours.result.action === 'in' ? 'You boarded' : `You paid ${rupees(yours.result.price?.amount ?? yours.result.leg?.amount)}`) : `Refused — ${REASON[yours.result.reason] ?? yours.result.reason}`}
            </h2>
            {yours.image ? (
              <>
                <img src={yours.image} alt={yours.result.action === 'in' ? 'Your boarding pass' : 'Your receipt'} />
                <p>{yours.result.action === 'in' ? 'Scan this with your ride card: your boarding pass, signed by this bus.' : 'Scan this with your ride card: your signed receipt, to check against your own phone’s kilometres.'}</p>
              </>
            ) : null}
            <button type="button" className="demo-btn demo-btn--go" onClick={() => setYours(null)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function stopName(code) {
  return STOPS.find((s) => s.code === code)?.en ?? code;
}

function personLine(p) {
  switch (p.status) {
    case 'waiting': return 'waiting';
    case 'aboard': return 'aboard';
    case 'held': return 'refused: bus full';
    case 'cash': return `cash · ${rupees(p.fare)}`;
    case 'dodger': return 'no tap — counted';
    case 'caught': return `caught · paid ${rupees(p.fare)} cash`;
    case 'unclosed': return `no tap-out · ${rupees(p.fare)}`;
    default: return `${p.km?.toFixed(1)} km · ${rupees(p.fare)}`;
  }
}

function Stat({ label, value, note, tone = 'quiet', small = false }) {
  return (
    <div className={`demo-stat demo-stat--${tone}${small ? ' demo-stat--small' : ''}`}>
      <small>{label}</small>
      <b className="tabular">{value}</b>
      {note ? <span>{note}</span> : null}
    </div>
  );
}

function Door({ entry, rush, onCamera }) {
  const result = entry?.result ?? null;
  const tone = !result ? 'idle' : result.reason === 'at_capacity' ? 'held' : result.ok ? 'ok' : 'no';
  let headline = 'Waiting';
  let detail = 'Scan a ride code, tap a card, or record cash';
  if (result) {
    if (result.reason === 'at_capacity') headline = 'FULL';
    else if (!result.ok) headline = 'REFUSED';
    else if (result.action === 'in') headline = 'IN';
    else if (result.action === 'out') headline = rupees(result.price?.amount ?? result.leg?.amount);
    else if (result.action === 'cash') headline = `${rupees(result.ticket.amount)} cash`;
    else if (result.action === 'group') headline = result.alighted ? `${result.alighted} × OUT` : `${result.boarded} × IN`;
    else headline = 'OK';

    if (!result.ok) detail = REASON[result.reason] ?? result.message ?? result.reason;
    else if (result.action === 'out') detail = `${((result.leg?.distanceM ?? 0) / 1000).toFixed(2)} km by ${result.leg?.distanceSource ?? 'odometer'}`;
    else if (result.action === 'in') detail = 'Ride open · nothing charged yet';
    else if (result.action === 'cash') detail = `${stopName(result.ticket.fromStop)} → ${stopName(result.ticket.toStop)}, signed by the bus`;
    else if (result.action === 'group') detail = result.alighted ? `${rupees(result.amount)} on one account` : 'one code, three people, one account';
    else detail = result.message ?? '';
  }
  return (
    <article className={`demo-door demo-door--${tone}`}>
      <header>
        <b>Door</b>
        <span>the only one — in and out</span>
        <button type="button" className="demo-door__cam" onClick={onCamera} title="Board with your own phone">📷</button>
      </header>
      <div className="demo-door__verdict" key={entry?.at ?? 'none'}>
        <strong>{headline}</strong>
        <em>{entry?.who ?? ''}</em>
        <span>{detail}</span>
      </div>
      <footer className="tabular">
        {entry && entry.ms ? `checked in ${entry.ms < 1 ? '<1' : Math.round(entry.ms)} ms, offline` : 'offline'}
        {rush ? ` · rush: ${rush.count} in ${(rush.ms / 1000).toFixed(1)} s` : ''}
      </footer>
    </article>
  );
}

/*
  The crew panel: what the owner never had before. The counter's bodies against
  the record, live; the inspector's check; and after the upload, whether the
  conductor earned the bonus that rides on the two agreeing.
*/
function Crew({ demo, bus }) {
  const closed = Boolean(demo.crew.tripId);
  const counted = closed ? demo.crew.counted : bus.counted;
  const recorded = closed ? demo.crew.recorded : bus.closed.length + bus.onboard.length + (bus.cash?.tickets ?? 0);
  const gap = counted === null || counted === undefined ? null : counted - recorded;
  const bonus = demo.crew.bonus;
  const insp = demo.inspection;
  return (
    <article className={`demo-crew${gap > 0 ? ' is-short' : ''}`}>
      <header>
        <b>Crew</b>
        <span>conductor {demo.crew.name} · signed on</span>
      </header>
      <dl className="demo-crew__count">
        <div><dt>Counted at the step</dt><dd className="tabular">{counted ?? '—'}</dd></div>
        <div><dt>On the record</dt><dd className="tabular">{recorded}</dd></div>
        <div className={gap > 0 ? 'is-gap' : ''}><dt>Not recorded</dt><dd className="tabular">{gap ?? '—'}</dd></div>
      </dl>
      {insp ? (
        <div className="demo-crew__insp">
          <small>Inspector · roster {insp.ok ? 'verified' : insp.reason} · {insp.rosterChars} chars in one QR</small>
          {insp.checks.map((c) => (
            <p key={c.name} className={c.ok ? 'is-ok' : 'is-no'}>
              <b>{c.ok ? 'ON RECORD' : 'NOT ON RECORD'}</b> {c.name}
            </p>
          ))}
          {insp.tally ? <p className="demo-crew__tally">{insp.tally.headcount} heads · {insp.tally.recorded} on record{insp.resolved ? ' · settled in cash' : ''}</p> : null}
        </div>
      ) : null}
      {bonus ? (
        <div className={`demo-crew__bonus${bonus.amount > 0 ? ' is-paid' : ''}`}>
          <strong className="tabular">{bonus.amount > 0 ? `+${rupees(bonus.amount)}` : 'No bonus'}</strong>
          <span>
            {bonus.amount > 0
              ? `${demo.crew.name}: ${rupees(bonus.before)} → ${rupees(bonus.after)} · the count matched the record`
              : bonus.reasons.map((r) => r.message).join(' ') || bonus.outcome}
          </span>
        </div>
      ) : (
        <p className="demo-crew__rule">A trip pays its crew Rs 50 only if rides and cash tickets cover 90% of the bodies counted.</p>
      )}
    </article>
  );
}

function Backend({ demo, bus }) {
  const s = demo.settlement;
  return (
    <article className={`demo-backend${s ? ' is-live' : ''}`}>
      <header>
        <b>Backend</b>
        <span>{demo.backend ? demo.backend.version : 'starting'}</span>
      </header>
      {!s ? (
        <div className="demo-backend__wait">
          <strong className="tabular">{bus.queued}</strong>
          <span>{bus.queued === 1 ? 'ride' : 'rides'} signed and waiting on the bus</span>
          <small>Nothing needs the internet until the money moves.</small>
        </div>
      ) : (
        <dl className="demo-backend__done">
          <div><dt>Settled</dt><dd className="tabular">{s.takings.rides}<small> rides</small></dd></div>
          <div><dt>Cash on record</dt><dd className="tabular">{s.evidence?.cash ?? 0}<small> · {rupees(s.evidence?.cashNpr ?? 0)}</small></dd></div>
          <div><dt>To the operator</dt><dd className="tabular">{rupees((s.evidence?.fares ?? s.takings.rupees))}</dd></div>
          <div><dt>Closed at the cap</dt><dd className="tabular">{s.takings.unclosed}</dd></div>
          {demo.replay ? (
            <div className="demo-backend__replay">
              <dt>Replayed upload</dt>
              <dd className="tabular">{demo.replay.replays}/{demo.replay.sent} replay · Rs {demo.replay.moved} moved</dd>
            </div>
          ) : null}
          {s.takings.flagged > 0 ? (
            <p className="demo-backend__note">{s.takings.flagged} ride(s) flagged for review. Flagged, never refused.</p>
          ) : null}
        </dl>
      )}
    </article>
  );
}
