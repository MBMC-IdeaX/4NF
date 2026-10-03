// Conductor surface: a tally board. Scan, verify on this phone, refuse replays,
// append to the local ledger. Nothing here contacts a server.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQrCamera } from '../lib/useQrCamera';
import { codeKind, KIND_LABEL } from '../lib/code-kind.mjs';
import { installRandomSource } from '../device/identity';
import { collectFare, tripTally } from '../device/collect';
import { endTrip } from '../storage/db';
import { rupees, stop } from '../lib/nepali';
import { syncConductor, syncConfigured } from '../device/sync';
import { feedbackForVerdict } from '../lib/feedback';
import { announceReceived, announceRefused } from '../lib/voice';
import { currentVehicle } from '../device/fleet';

// The bus this device is provisioned for. A phone moved to another vehicle
// is re-provisioned, not rebuilt.
// Provisioned per device, read at the moment of use.
const conductorId = () => currentVehicle().id;

export default function Conductor({ onBack, debug }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const busyRef = useRef(false);
  const [result, setResult] = useState(null);
  const [tally, setTally] = useState({ passengers: 0, total: 0, recent: [] });
  const [pasted, setPasted] = useState('');
  const [syncNote, setSyncNote] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [sighted, setSighted] = useState(false);

  const refresh = useCallback(async () => setTally(await tripTally()), []);

  const collect = useCallback(async (qrText) => {
    if (busyRef.current || !qrText) return;
    busyRef.current = true;
    // Acknowledge that a code was seen before ruling on it. Verification takes
    // a millisecond or two, and a viewfinder that reacts instantly is what
    // tells a conductor to stop holding the phone still.
    setSighted(true);
    try {
      const kind = codeKind(qrText);
      const verdict = kind === 'stage-ticket'
        ? await collectFare(qrText, { conductorId: conductorId() })
        : { ok: false, reason: 'wrong_kind', message: wrongKindMessage(kind) };
      feedbackForVerdict(verdict.ok);
      // Three signals for one event: the screen, the phone in the hand, and
      // the sound. Any one of them is enough to know what happened.
      if (verdict.ok) announceReceived(verdict.token.amount);
      else announceRefused(verdict.reason);
      setResult(verdict);
      if (verdict.ok) await refresh();
    } finally {
      setSighted(false);
      busyRef.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    installRandomSource();
    refresh();
  }, [refresh]);

  // Camera. Paused while a verdict is on screen so the loop is not decoding
  // behind a full-bleed panel.
  const { error: cameraError } = useQrCamera({ videoRef, canvasRef, paused: Boolean(result), onText: collect });

  return (
    <div className="board">
      <dl className="board__tally">
        <div className="board__stat">
          <dt>यात्रु / Passengers</dt>
          <dd className="tabular">
            <span key={tally.passengers}>{tally.passengers}</span>
            <small>this trip</small>
          </dd>
        </div>
        <div className="board__stat">
          <dt>उठेको / Collected</dt>
          <dd className="tabular">
            <span key={tally.total}>{tally.total}</span>
            <small>rupees</small>
          </dd>
        </div>
      </dl>

      <div className="board__viewfinder">
        <video ref={videoRef} muted playsInline />
        <canvas ref={canvasRef} hidden />
        <div className={`board__reticle${sighted ? ' board__reticle--hit' : ''}`}><i /><i /><i /><i /></div>
        <p className="board__hint">
          {cameraError ?? 'यात्रुको टिकट क्यामेरामा देखाउनुहोस्'}
          {cameraError ? null : <small>Hold the passenger ticket in frame</small>}
        </p>
      </div>

      <div className="board__log">
        {tally.recent.length === 0 ? (
          <p className="board__empty">No fares collected yet. Scan the first passenger to start the trip.</p>
        ) : (
          tally.recent.map((row) => (
            <div className="log-row" key={row.nonce}>
              <div className="log-row__route">
                {stop(row.boardingStop).ne} — {stop(row.alightingStop).ne}
                <small>{stop(row.boardingStop).en} to {stop(row.alightingStop).en}</small>
              </div>
              <div className="log-row__fare tabular">{rupees(row.amount)}</div>
            </div>
          ))
        )}
      </div>

      {debug ? (
        <div className="debug">
          <p>Debug entry. Not part of the demo.</p>
          <textarea value={pasted} onChange={(event) => setPasted(event.target.value)} rows={3} />
          <button type="button" onClick={() => collect(pasted.trim())}>Collect pasted ticket</button>
        </div>
      ) : null}

      {syncNote ? <p className="notice notice--quiet">{syncNote}</p> : null}

      {syncConfigured() ? (
        <button
          type="button"
          className={`action action--quiet${syncing ? ' action--working' : ''}`}
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            setSyncNote(null);
            try {
              const outcome = await syncConductor();
              setSyncNote(`Sent ${outcome.cleared} fares to the office.`);
            } catch (problem) {
              setSyncNote(`No connection yet. ${problem.message} The trip is saved on this phone.`);
            } finally {
              setSyncing(false);
            }
          }}
        >
          {syncing ? 'Sending' : 'Send trip to the office'}
        </button>
      ) : null}

      <button
        type="button"
        className="action action--quiet"
        onClick={async () => {
          // Ending a trip only resets the tally. Unsynced fares stay queued and
          // go up on the next sync, so ending a trip can never lose money.
          await endTrip();
          await refresh();
          onBack();
        }}
      >
        End trip
      </button>

      {result ? <Stamp result={result} tally={tally} onDismiss={() => setResult(null)} /> : null}
    </div>
  );
}

/*
  The one loud moment. Full-bleed, instant, readable across a bus. Accept is the
  stamp coming down in ink; refusal is plate red.
*/
function Stamp({ result, tally, onDismiss }) {
  const accepted = result.ok;
  const token = result.token;

  return (
    <div className={`stamp${accepted ? '' : ' stamp--refused'}`}>
      <div className="stamp__top">
        <span>{accepted ? 'तिरेको' : 'नलिनुहोस्'}</span>
        <span className="tabular">
          {accepted ? `यात्रु ${tally.passengers}` : conductorId()}
        </span>
      </div>

      {accepted ? (
        <>
          <div className="stamp__amount tabular">
            {rupees(token.amount)}
            <small>Ticket no. {token.sequenceNumber}</small>
          </div>
          <div className="stamp__route">
            {stop(token.boardingStop).ne} — {stop(token.alightingStop).ne}
            <small>{stop(token.boardingStop).en} to {stop(token.alightingStop).en}</small>
          </div>
        </>
      ) : (
        <>
          <div className="stamp__reason">{REFUSALS[result.reason] ?? 'नमिल्यो'}</div>
          <p className="stamp__detail">{result.message}</p>
        </>
      )}

      <div className="stamp__foot">
        <button type="button" className="action" onClick={onDismiss}>
          अर्को यात्रु
          <small>Next passenger</small>
        </button>
      </div>
    </div>
  );
}

const REFUSALS = {
  replay: 'दोहोरियो',
  bad_signature: 'नक्कली',
  wrong_conductor: 'अर्को बस',
  stale: 'पुरानो',
  unreadable: 'पढिएन',
  ledger_error: 'त्रुटि',
  wrong_kind: 'यो टिकट होइन',
};

// A good code shown to the wrong reader. Say what it is and where it goes.
function wrongKindMessage(kind) {
  const label = KIND_LABEL[kind] ?? KIND_LABEL.unknown;
  if (kind === 'ride-code' || kind === 'group-code') {
    return `This is a ${label.en}. On a metered bus it is read at the door, not by the stage-fare tally.`;
  }
  if (kind === 'unknown') return 'This is not a Bhada ticket. Ask the passenger to open their ticket in the Bhada app.';
  return `This is a ${label.en}, not a fare ticket. Ask the passenger for their ticket.`;
}
