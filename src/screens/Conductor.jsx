// Conductor surface: a tally board. Scan, verify on this phone, refuse replays,
// append to the local ledger. Nothing here contacts a server.

import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
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
const SCANS_PER_SECOND = 8;   // a full-res read every frame heats a cheap phone
const DECODE_WIDTH = 640;     // downscale before decoding; QR needs no more

export default function Conductor({ onBack, debug }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const busyRef = useRef(false);
  const [result, setResult] = useState(null);
  const [tally, setTally] = useState({ passengers: 0, total: 0, recent: [] });
  const [cameraError, setCameraError] = useState(null);
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
      const verdict = await collectFare(qrText, { conductorId: conductorId() });
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
  useEffect(() => {
    if (result) return undefined;
    let stream = null;
    let timer = null;
    let stopped = false;
    let detector = null;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch (error) {
        setCameraError(`Camera is blocked. Allow it in the browser bar, then reopen this screen. (${error.name})`);
        return;
      }
      // StrictMode runs effects twice; the second run must not leak the first stream.
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      if ('BarcodeDetector' in window) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }

      const tick = async () => {
        if (stopped) return;
        const text = detector
          ? await readNative(detector, video)
          : readCanvas(video, canvasRef.current);
        if (text) await collect(text);
        if (!stopped) timer = setTimeout(tick, 1000 / SCANS_PER_SECOND);
      };
      timer = setTimeout(tick, 1000 / SCANS_PER_SECOND);
    }

    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [result, collect]);

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
};

async function readNative(detector, video) {
  try {
    const codes = await detector.detect(video);
    return codes.length ? codes[0].rawValue : null;
  } catch {
    return null;
  }
}

function readCanvas(video, canvas) {
  if (!canvas || !video.videoWidth) return null;
  const scale = Math.min(1, DECODE_WIDTH / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  return found ? found.data : null;
}
