// First run on a bus phone: become the bus.
//
// The owner shows a setup QR in Bhada Owner (0034). Scanning it here stores the
// bus — plate, route, seats — and the one-time code; the meter sends the code
// with its first sync, and the backend binds this phone's key to the bus. Until
// then the phone works offline as that bus, and its fares wait to be sent.

import { useRef, useState } from 'react';
import { Button, Field, Icon, Note, Plate } from '../../ui';
import { useQrCamera } from '../../lib/useQrCamera';
import { codeKind } from '../../lib/code-kind.mjs';
import { provisionVehicle, plateFromId } from '../../device/fleet';

export function parseSetup(text) {
  if (codeKind(text) !== 'bus-setup') return null;
  const code = JSON.parse(text);
  if (!code.plate || !code.code) return null;
  return code;
}

async function becomeBus(setup) {
  return provisionVehicle({
    id: setup.plate,
    plate: plateFromId(setup.plate),
    routeId: setup.routeId ?? undefined,
    routeName: setup.label || setup.routeId || undefined,
    label: setup.label ?? null,
    ...(setup.seated ? { seated: setup.seated, standing: setup.standing ?? 0, capacity: setup.capacity ?? setup.seated + (setup.standing ?? 0) } : {}),
    enrolCode: setup.code,
    setupAt: Date.now(),
  });
}

function Camera({ onSetup, onWrong }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const { error } = useQrCamera({
    videoRef,
    canvasRef,
    onText: (text) => {
      const setup = parseSetup(text);
      if (setup) onSetup(setup);
      else onWrong(codeKind(text));
    },
  });
  return (
    <div className="cs-camera">
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} hidden />
      <span className="cs-camera__frame" aria-hidden="true" />
      {error ? <p className="cs-camera__error">{error}</p> : null}
    </div>
  );
}

export default function Setup({ onDone, onDemo }) {
  const [mode, setMode] = useState('intro');
  const [plate, setPlate] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);

  async function finish(setup) {
    const result = await becomeBus(setup);
    if (!result.ok) { setProblem(result.message); return; }
    setDone(result.vehicle);
  }

  if (done) {
    return (
      <div className="cs">
        <div className="cs-hero">
          <Plate plate={done.plate} size={30} />
          <h1>This phone is now the bus</h1>
          <p>Start the meter. The first time it finds a signal, Bhada confirms it with your owner’s code.</p>
        </div>
        <Button size="lg" block onClick={onDone}>Start the meter</Button>
      </div>
    );
  }

  return (
    <div className="cs">
      <div className="cs-hero">
        <span className="cs-icon"><Icon name="bus" /></span>
        <h1>Set up this phone as your bus</h1>
        <p>Ask the bus owner to open <b>Bhada Owner → Buses → your bus → Set up a phone</b>, then scan the code.</p>
      </div>

      {mode === 'scan' ? (
        <Camera
          onSetup={finish}
          onWrong={(kind) => setProblem(kind === 'unknown' ? 'That is not a Bhada code.' : 'That is not a bus setup code. Scan the one in Bhada Owner.')}
        />
      ) : null}

      {mode === 'type' ? (
        <form className="bx-stack" onSubmit={(e) => { e.preventDefault(); finish({ plate: plate.toUpperCase().replace(/\s/g, ''), code: code.toUpperCase().replace(/[^A-Z0-9]/g, '') }); }}>
          <Field label="नम्बर प्लेट · Plate" hint="Letters and numbers, like BA2KHA4412.">
            <input className="bx-input" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} autoCapitalize="characters" required />
          </Field>
          <Field label="कोड · Setup code" hint="Twelve letters and numbers, shown under the QR.">
            <input className="bx-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" required />
          </Field>
          <Button type="submit" size="lg" block disabled={plate.length < 6 || code.replace(/[^A-Za-z0-9]/g, '').length < 12}>Set up</Button>
          <p className="bx-small bx-muted" style={{ margin: 0 }}>Typed codes carry no seat count; the phone uses its default until the owner’s seats arrive with a scanned code.</p>
        </form>
      ) : null}

      {problem ? <Note tone="bad">{problem}</Note> : null}

      {mode !== 'scan' ? <Button size="lg" block icon="scan" onClick={() => { setProblem(null); setMode('scan'); }}>Scan setup code</Button> : null}
      {mode !== 'type' ? <Button size="lg" block variant="secondary" onClick={() => { setProblem(null); setMode('type'); }}>Type it instead</Button> : null}
      <button type="button" className="cs-demo" onClick={onDemo}>{import.meta.env.VITE_LOCAL_DB_URL && new URLSearchParams(location.search).has('presentation') ? 'Start local presentation - DEMOBUS01 - simulated GPS' : 'Just trying it? Use the demo bus'}</button>
    </div>
  );
}
