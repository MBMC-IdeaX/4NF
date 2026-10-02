// A door terminal, on a phone.
//
// One target, one gesture. Everything else on this screen is there so the crew
// can tell, at a glance and in daylight, whether the machine is in a state where
// tapping will work: is it paired, does it have a fix, does it know how full the
// bus is. A validator that fails silently is worse than no validator, because
// the queue keeps moving.
//
// The tap itself is deliberately undifferentiated. There is no "board" button
// and no "alight" button — the terminal knows which one this is, because it
// knows whether that key has a ride open. Asking a passenger to press the right
// one on the step of a moving bus is a design that will be ignored.

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { terminal } from '../device/terminal';
import { DOORS } from '../device/meter';
import { rupees, STOPS, stageMetres } from '../lib/nepali';
import { priceDistance } from '../../protocol/meter.mjs';
import { FIX_QUALITY } from '../../protocol/meter.mjs';
import { feedbackForVerdict } from '../lib/feedback';
import { announceBoarded, announceFare, announceBusFull, warmVoices } from '../lib/voice';
import { navigate } from '../lib/router';
import Scanner from '../components/Scanner';
import { syncTerminal, syncConfigured } from '../device/sync';
import { createKeyboardWedge, createRepeatFilter, screenCode } from '../lib/scan-input';

const QUALITY_LABEL = {
  [FIX_QUALITY.NONE]: 'no fix',
  [FIX_QUALITY.WARMUP]: 'acquiring',
  [FIX_QUALITY.POOR]: 'degraded',
  [FIX_QUALITY.GOOD]: 'locked',
};

function doorFromUrl() {
  const value = new URLSearchParams(window.location.search).get('door');
  return value && DOORS[value.toUpperCase()] ? value.toUpperCase() : null;
}

export default function Terminal() {
  const [doorId, setDoorId] = useState(doorFromUrl);
  if (!doorId) return <DoorPicker onPick={setDoorId} />;
  return <Door key={doorId} doorId={doorId} onSwitch={() => setDoorId(null)} />;
}

function DoorPicker({ onPick }) {
  return (
    <div className="pick">
      <h1>
        ढोका छान्नुहोस्
        <span>Which door is this phone on?</span>
      </h1>
      {Object.values(DOORS).map((door) => (
        <button key={door.id} type="button" onClick={() => onPick(door.id)}>
          <b>{door.id}</b>
          <span>
            {door.ne}
            <small>{door.en}</small>
          </span>
        </button>
      ))}
      <p>
        The choice is only a label on the receipt and a role for the interlock. Either door can
        board and either can alight — the terminal works out which from the pass.
      </p>
      <button type="button" className="pick__away" onClick={() => navigate('/device')}>
        Open the meter console instead
      </button>
    </div>
  );
}

function Door({ doorId, onSwitch }) {
  const unit = terminal(doorId);
  const [snap, setSnap] = useState(() => unit.snapshot());
  const [scanning, setScanning] = useState(false);
  const [scanMode, setScanMode] = useState('pass'); // 'pass' | 'pairing'
  const [verdict, setVerdict] = useState(null);
  const [passImage, setPassImage] = useState(null);
  const [enrolling, setEnrolling] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [cashOpen, setCashOpen] = useState(false);

  useEffect(() => {
    unit.boot();
    warmVoices();
    return unit.subscribe(setSnap);
  }, [unit]);

  /*
    Transit mode. A door phone in daylight, on a bus that is moving, held by
    somebody with one hand on a rail: bigger figures, bigger targets, no
    mid-greys. Off by default because the ordinary layout says more, and
    remembered per device because a crew that turns it on wants it on tomorrow.
  */
  const [transit, setTransit] = useState(() => {
    try {
      return localStorage.getItem('bhada.transitMode') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('bhada.transitMode', transit ? '1' : '0');
    } catch {
      // A private window that refuses storage still gets the mode, just not
      // tomorrow.
    }
  }, [transit]);

  const settle = useCallback(async (result) => {
    feedbackForVerdict(Boolean(result?.ok));
    // Said aloud, because the conductor is watching the queue and the road. The
    // haptic is for the hand, the screen is for a glance, this is for everyone
    // in earshot — including the passenger, who otherwise has to take the fare
    // on trust until they look at their own phone.
    if (result?.reason === 'at_capacity') announceBusFull();
    else if (result?.ok && result.action === 'out') announceFare(result.price?.amount ?? result.leg?.amount ?? 0);
    else if (result?.ok && result.action === 'in') announceBoarded();
    else if (result?.ok && result.action === 'group') {
      if (result.alighted > 0) announceFare(result.amount);
      else announceBoarded();
    }
    setVerdict(result);
    setPassImage(null);
    if (result?.ok && result.action === 'in' && result.passQr) {
      // The pass is the passenger's copy. Drawing it immediately matters: on a
      // bus with no signal it is the only thing that will let them off again.
      const image = await QRCode.toDataURL(result.passQr, { margin: 1, width: 380, errorCorrectionLevel: 'M' });
      setPassImage(image);
    }
    if (result?.ok && result.action === 'out' && result.receipt) {
      // The receipt is the passenger's copy too. Their app reads it, checks the
      // arithmetic, and sets it beside the distance their own phone measured.
      const image = await QRCode.toDataURL(result.receipt, { margin: 1, width: 380, errorCorrectionLevel: 'L' });
      setPassImage(image);
    }
  }, []);

  const onScan = useCallback(async (text) => {
    if (scanMode === 'pairing') {
      const result = await unit.pair(text);
      setScanning(false);
      setVerdict({ ok: result.ok, message: result.message, action: 'pair' });
      return;
    }
    setScanning(false);
    await settle(await unit.present({ text }));
  }, [scanMode, settle, unit]);

  /*
    A USB scanner on OTG, in keyboard mode.

    The camera is the slow part of a door: a second and a half to aim in good
    light, six at dusk. A dedicated scanner reads the same screen in a fifth of
    a second, and on Android it needs no driver — it types the code and presses
    Enter. This listens for that, and only that: keys arriving faster than a
    person types, ending in Enter, outside any text field.

    It stays live over a verdict on purpose. The next passenger is already
    holding their phone up; making the crew clear the last result first would
    put the conductor's thumb back into the loop the scanner exists to remove.
  */
  const [wedgeSeen, setWedgeSeen] = useState(false);
  const sheetOpen = scanning || pasteOpen || enrolling || cashOpen;
  useEffect(() => {
    if (!snap.paired || sheetOpen) return undefined;
    const fresh = createRepeatFilter();
    const onKeyDown = createKeyboardWedge({
      onScan: async (raw) => {
        setWedgeSeen(true);
        const screened = screenCode(raw);
        if (!screened.ok) {
          await settle({ ok: false, reason: 'unreadable', message: 'The scanner read something that is not a ride code.' });
          return;
        }
        // The same screen read again while it is still held up. The first read
        // already did its work; the nonce check would refuse this one anyway.
        if (!fresh(screened.code)) return;
        await settle(await unit.present({ text: screened.code }));
      },
    });
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [snap.paired, sheetOpen, settle, unit]);

  const busy = !snap.paired;

  return (
    <div className={`term term--${snap.door.role}${transit ? ' term--transit' : ''}`}>
      <TermHead snap={snap} doorId={doorId} onSwitch={onSwitch} transit={transit} onTransit={() => setTransit((on) => !on)} scanner={wedgeSeen} />

      {busy ? (
        <Unpaired onScan={() => { setScanMode('pairing'); setScanning(true); }} onPaste={() => setPasteOpen(true)} />
      ) : verdict ? (
        <Verdict
          verdict={verdict}
          passImage={passImage}
          tariff={snap.tariff}
          onClear={() => { setVerdict(null); setPassImage(null); }}
        />
      ) : (
        <>
          <BusState snap={snap} />
          <button
            type="button"
            className="term__tap"
            onClick={() => { setScanMode('pass'); setScanning(true); }}
            disabled={snap.bus?.atCapacity && snap.role === 'boarding'}
          >
            <b>ट्याप गर्नुहोस्</b>
            <span>{snap.bus?.atCapacity && snap.role === 'boarding' ? 'Bus is full' : 'Scan the ride code on a phone, or a pass'}</span>
          </button>
          <button type="button" className="term__cash" onClick={() => setCashOpen(true)}>
            <b>नगद</b>
            <span>Cash rider — record the fare</span>
          </button>
          <Cards snap={snap} unit={unit} onResult={settle} onEnrol={() => setEnrolling(true)} />
          <Log snap={snap} />
          <DoorUpload snap={snap} />
          <button type="button" className="term__paste" onClick={() => setPasteOpen(true)}>
            Type a pass instead
          </button>
        </>
      )}

      {scanning ? (
        <Scanner
          label={scanMode === 'pairing' ? 'Scan the meter’s pairing code' : 'Hold the pass steady'}
          onText={onScan}
          onClose={() => setScanning(false)}
        />
      ) : null}

      {enrolling ? (
        <Enrol
          unit={unit}
          onClose={() => setEnrolling(false)}
        />
      ) : null}

      {cashOpen ? (
        <Cash
          onClose={() => setCashOpen(false)}
          onRecord={async (toStop, fromStop) => {
            setCashOpen(false);
            await settle(await unit.issueCash({ toStop, fromStop }));
          }}
        />
      ) : null}

      {pasteOpen ? (
        <Paste
          onClose={() => setPasteOpen(false)}
          onText={async (text) => {
            setPasteOpen(false);
            if (scanMode === 'pairing' || text.trim().startsWith('{')) {
              const result = await unit.pair(text);
              setVerdict({ ok: result.ok, message: result.message, action: 'pair' });
              return;
            }
            await settle(await unit.present({ text }));
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function TermHead({ snap, doorId, onSwitch, transit, onTransit, scanner }) {
  return (
    <header className="term__head">
      <button type="button" className="term__door" onClick={onSwitch}>
        <b>{doorId}</b>
        <small>{snap.door.en}</small>
      </button>
      <div className="term__flags">
        <span className={snap.paired && !snap.keyMismatch ? 'flag flag--ok' : 'flag flag--bad'}>
          {!snap.paired ? 'not paired' : snap.keyMismatch ? 're-pair: meter key changed' : 'paired'}
        </span>
        <span className={`flag flag--${snap.quality === FIX_QUALITY.GOOD ? 'ok' : snap.quality === FIX_QUALITY.NONE ? 'bad' : 'warn'}`}>
          {QUALITY_LABEL[snap.quality]}{snap.accuracy ? ` ±${Math.round(snap.accuracy)} m` : ''}
        </span>
        <span className={`flag flag--${snap.link === 'realtime' ? 'ok' : snap.link === 'local' ? 'warn' : 'bad'}`}>
          {snap.link}
        </span>
        {snap.nfc ? <span className="flag flag--ok">tap-and-go</span> : null}
        {scanner ? <span className="flag flag--ok">scanner</span> : null}
        <button
          type="button"
          className={`flag flag--toggle${transit ? ' flag--on' : ''}`}
          onClick={onTransit}
          aria-pressed={transit}
        >
          {transit ? 'transit mode on' : 'transit mode'}
        </button>
      </div>
    </header>
  );
}

function BusState({ snap }) {
  if (snap.keyMismatch) {
    return (
      <p className="term__state term__state--quiet">
        This door is paired to a different key than this bus&apos;s meter. Rides it closes will be
        refused at settlement. Scan the meter&apos;s pairing code again before taking fares.
      </p>
    );
  }
  /*
    Detached is the state worth spelling out.

    On a bus with no signal, two door phones cannot hear each other — there is no
    browser transport between two Android handsets, and the RS-485 that solves
    this properly is production hardware this build does not have. So the
    alighting door will not know about a ride the boarding door opened, and the
    only thing that closes it is the BO1 pass on the passenger's own phone.

    The crew needs that sentence, not a status word, because the action it
    implies is theirs: ask for the pass, and if the passenger cannot show one,
    the ride closes at the cap and they claim it back later.
  */
  if (snap.link === 'detached') {
    return (
      <p className="term__state term__state--quiet">
        No other unit on the vehicle bus — this door is on its own. Ask for the boarding pass on the
        passenger&apos;s phone; without it this door cannot close a ride it did not open, and the
        meter will charge the cap at the end of the trip.
      </p>
    );
  }
  if (!snap.bus) {
    return (
      <p className="term__state term__state--quiet">
        {snap.busStale
          ? 'The meter has gone quiet. Taps still work — the pass carries everything needed to price the ride.'
          : 'No meter on the vehicle bus. This terminal is pricing rides on its own.'}
      </p>
    );
  }
  return (
    <dl className="term__state">
      <div>
        <dt>Aboard</dt>
        <dd className={`tabular${snap.bus.atCapacity ? ' is-full' : ''}`}>{snap.bus.onboard}/{snap.bus.capacity}</dd>
      </div>
      <div><dt>Odometer</dt><dd className="tabular">{(snap.bus.odometerM / 1000).toFixed(2)} km</dd></div>
      <div><dt>Door</dt><dd className="tabular">{snap.bus.doors.A}{snap.bus.doors.B && snap.bus.doors.B !== 'closed' ? ` · rear ${snap.bus.doors.B}` : ''}</dd></div>
      <div><dt>This trip</dt><dd className="tabular">{rupees(snap.bus.accrued)}</dd></div>
    </dl>
  );
}

/* ----------------------------------------------------------------- verdict */

function Verdict({ verdict, passImage, tariff, onClear }) {
  if (!verdict.ok) {
    return (
      <button type="button" className="result result--no" onClick={onClear}>
        <b>अस्वीकृत</b>
        <span>{verdict.message ?? verdict.reason}</span>
        <small>Tap to clear</small>
      </button>
    );
  }

  if (verdict.action === 'pair') {
    return (
      <button type="button" className="result result--yes" onClick={onClear}>
        <b>Paired</b>
        <span>{verdict.message}</span>
        <small>Tap to clear</small>
      </button>
    );
  }

  if (verdict.action === 'group') {
    return (
      <button type="button" className={`result ${verdict.refused > 0 ? 'result--no' : 'result--yes'}`} onClick={onClear}>
        <b className="tabular">{verdict.size} जना</b>
        <span>
          Family of {verdict.size} on one phone:
          {verdict.boarded ? ` ${verdict.boarded} boarded.` : ''}
          {verdict.alighted ? ` ${verdict.alighted} off, ${rupees(verdict.amount)} to one wallet.` : ''}
          {verdict.refused ? ` ${verdict.refused} refused (${verdict.results.find((r) => !r.ok)?.reason}).` : ''}
        </span>
        <small>Tap to clear</small>
      </button>
    );
  }

  if (verdict.action === 'cash') {
    return (
      <button type="button" className="result result--yes" onClick={onClear}>
        <b className="tabular">{rupees(verdict.ticket.amount)} नगद</b>
        <span>
          Cash, {stopName(verdict.ticket.fromStop)} → {stopName(verdict.ticket.toStop)}, {(verdict.ticket.distanceM / 1000).toFixed(1)} km.
          On the record as ticket {verdict.ticket.ticketId}.
        </span>
        <small>Tap to clear</small>
      </button>
    );
  }

  if (verdict.action === 'in') {
    return (
      <div className="result result--in">
        <b>चढ्नुभयो</b>
        <span>Ride open — nothing charged yet</span>
        {passImage ? <img src={passImage} alt="Boarding pass QR" /> : null}
        <dl>
          <div><dt>Leg</dt><dd className="tabular">{verdict.legId}</dd></div>
          <div><dt>Boarding odometer</dt><dd className="tabular">{verdict.pass.boardOdoM} m</dd></div>
          <div><dt>Rate after {tariff.includedKm} km</dt><dd className="tabular">{rupees(tariff.perStep)}/km</dd></div>
        </dl>
        <p>The passenger keeps this. It is what lets them off at the other door with no signal.</p>
        <button type="button" onClick={onClear}>Next passenger</button>
      </div>
    );
  }

  const { leg, price } = verdict;
  return (
    <div className="result result--out">
      <b className="tabular">{rupees(leg.amount)}</b>
      <span>{(leg.distanceM / 1000).toFixed(2)} km, measured by {leg.distanceSource}</span>
      <ul>
        {price.breakdown.map((item) => (
          <li key={item.label}>
            <span>{item.label}</span>
            <b className="tabular">{item.value}</b>
          </li>
        ))}
      </ul>
      {leg.estimated ? (
        <p className="result__note">
          Estimated{leg.distanceNote ? ` — ${leg.distanceNote}` : ''}. The receipt says so, and the
          passenger can dispute it against the vehicle&apos;s own tape.
        </p>
      ) : null}
      {passImage ? (
        <div className="result__receipt">
          <img src={passImage} alt="Signed receipt QR" />
          <p>
            Passenger: scan this with the Bhada app to keep the signed receipt. It is set beside the
            distance your own phone measured on the way.
          </p>
        </div>
      ) : null}
      <button type="button" onClick={onClear}>Next passenger</button>
    </div>
  );
}

/* ------------------------------------------------------------------ upload */

function DoorUpload({ snap }) {
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!syncConfigured() || !snap.vehiclePublicKey) return null;

  async function upload() {
    setBusy(true);
    setNote(null);
    try {
      const r = await syncTerminal({ vehiclePublicKey: snap.vehiclePublicKey });
      setNote(`${r.settled} settled, ${r.awaiting} waiting for a tap from the other door, ${r.taps} tap(s) filed.`);
    } catch (error) {
      setNote(`Upload failed: ${error.message}. Nothing lost — it stays queued.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="term__upload">
      <button type="button" onClick={upload} disabled={busy}>
        {busy ? 'Uploading…' : 'Upload this door’s rides'}
      </button>
      {note ? <p>{note}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- cards */

function Cards({ snap, unit, onResult, onEnrol }) {
  const riding = new Set(snap.openLegs.map((l) => l.passengerPublicKey));
  return (
    <section className="cards">
      <h2>
        Rider cards
        <span>{snap.cards.length} issued, {snap.openLegs.length} riding</span>
      </h2>
      <div className="cards__list">
        {snap.cards.map((card) => {
          const aboard = riding.has(card.publicKey);
          return (
            <button
              key={card.publicKey}
              type="button"
              className={aboard ? 'cards__card cards__card--riding' : 'cards__card'}
              onClick={async () => onResult(await unit.tapCard(card))}
            >
              <b>{card.alias}</b>
              <small>{aboard ? 'aboard — tap to get off' : card.concession === 'none' ? 'full fare' : card.concession}</small>
            </button>
          );
        })}
        <button type="button" className="cards__card cards__card--new" onClick={onEnrol}>
          <b>+</b>
          <small>Issue a card</small>
        </button>
      </div>
      <p>
        For riders without a smartphone. Riders with one never need a card: the Bhada app holds
        their key and shows the ride code. On a real bus a card is an NFC card whose key never
        leaves its chip; in this build this phone holds the key on the card&apos;s behalf.
      </p>
    </section>
  );
}

function Enrol({ unit, onClose }) {
  const [alias, setAlias] = useState('');
  const [concession, setConcession] = useState('none');
  const [cardUid, setCardUid] = useState('');
  const [problem, setProblem] = useState(null);
  return (
    <div className="sheet" role="dialog" aria-label="Issue a rider card">
      <div className="sheet__body">
        <h3>Issue a rider card</h3>
        <label>
          <span>Label for the crew</span>
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Sita" autoFocus />
        </label>
        <label>
          <span>Concession</span>
          <select value={concession} onChange={(e) => setConcession(e.target.value)}>
            <option value="none">Full fare</option>
            <option value="student">Student — half</option>
            <option value="senior">Senior — half</option>
            <option value="staff">Staff — free</option>
          </select>
        </label>
        <label>
          <span>Card serial (optional)</span>
          <input
            value={cardUid}
            onChange={(e) => setCardUid(e.target.value.trim().toUpperCase())}
            placeholder="04:A2:1B:9C:33:80:00"
          />
        </label>
        <p>
          A serial ties this key to a physical tag, for a rider with no smartphone. The tag holds
          nothing but its serial — a card that could sign for itself costs more than twenty rides —
          so the key that stands for it lives on this terminal. Leave it blank for a card the crew
          picks off the list.
        </p>
        <p>
          A concession set here is a hint until the backend confirms it against the card that was
          checked. The console shows unverified ones as unverified.
        </p>
        {problem ? <p className="notice">{problem}</p> : null}
        <div className="sheet__row">
          <button
            type="button"
            onClick={async () => {
              const result = await unit.enrol({ alias, concession, cardUid: cardUid || null });
              if (result?.ok === false) { setProblem(result.message); return; }
              onClose();
            }}
          >
            Enrol
          </button>
          <button type="button" className="quiet" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- cash */

function stopName(code) {
  return STOPS.find((s) => s.code === code)?.en ?? code;
}

/*
  A cash fare, recorded by the conductor.

  Two taps: where they got on (the nearest stop is already chosen) and where
  they are going. The fare shown is the tariff's, not a number anyone types, and
  it is what the ticket will say — the backend refuses one that disagrees.
*/
function Cash({ onClose, onRecord }) {
  const [from, setFrom] = useState(STOPS[0].code);
  const [to, setTo] = useState(null);
  const metres = to ? stageMetres(from, to) : null;
  const fare = metres ? priceDistance(metres).amount : null;
  return (
    <div className="sheet" role="dialog" aria-label="Record a cash fare">
      <div className="sheet__body">
        <h3>Cash rider</h3>
        <label>
          <span>Got on at</span>
          <select value={from} onChange={(e) => { setFrom(e.target.value); setTo(null); }}>
            {STOPS.map((s) => <option key={s.code} value={s.code}>{s.en} · {s.ne}</option>)}
          </select>
        </label>
        <p>Going to</p>
        <div className="term__cash-stops">
          {STOPS.filter((s) => s.code !== from).map((s) => (
            <button key={s.code} type="button" className={to === s.code ? 'is-on' : ''} onClick={() => setTo(s.code)}>
              {s.en}
              <small>{s.ne}</small>
            </button>
          ))}
        </div>
        <p>
          The fare is the published tariff for the distance, the same as a tapped ride. The ticket is
          signed by this bus and counts toward the cash the crew hands in.
        </p>
        <div className="sheet__row">
          <button type="button" disabled={!fare} onClick={() => onRecord(to, from)}>
            {fare ? `Record ${rupees(fare)} cash` : 'Pick where they are going'}
          </button>
          <button type="button" className="quiet" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- paste */

function Paste({ onClose, onText }) {
  const [text, setText] = useState('');
  return (
    <div className="sheet" role="dialog" aria-label="Type a pass">
      <div className="sheet__body">
        <h3>Type or paste</h3>
        <p>A pairing code, a BT1 tap or a BO1 pass. Useful when a camera will not focus.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} autoFocus />
        <div className="sheet__row">
          <button type="button" onClick={() => onText(text)}>Use it</button>
          <button type="button" className="quiet" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- unpaired */

function Unpaired({ onScan, onPaste }) {
  return (
    <div className="term__unpaired">
      <h2>This terminal is not paired</h2>
      <p>
        Open <b>/device</b> on the meter, press <b>Pair a door terminal</b>, and scan the code it
        shows. The vehicle key crosses by camera and is never sent over a network.
      </p>
      <button type="button" onClick={onScan}>Scan the pairing code</button>
      <button type="button" className="quiet" onClick={onPaste}>Paste it instead</button>
    </div>
  );
}

/* --------------------------------------------------------------------- log */

function Log({ snap }) {
  if (snap.events.length === 0) return null;
  return (
    <ol className="term__log">
      {snap.events.slice(0, 6).map((event) => (
        <li key={event.at} className={event.severity !== 'info' ? `is-${event.severity}` : undefined}>
          <time className="tabular">{new Date(event.at).toLocaleTimeString('en-GB')}</time>
          <span>{event.text}</span>
        </li>
      ))}
    </ol>
  );
}
