// Local test fixture: uses the real map, ride screen, store and upload client.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { useLoad } from '../../src/apps/owner/data';
import OsmFleetMap from '../../src/ui/OsmFleetMap';
import Ride from '../../src/screens/Ride';
import { db } from '../../src/storage/db';
import { loadIdentity, installRandomSource } from '../../src/device/identity';
import { trustedBusKey } from '../../src/device/receipt-auth';
import { useSyncStatus } from '../../src/lib/useSyncStatus';
import { pendingPassenger } from '../../src/device/outbox';
import { syncPassenger } from '../../src/device/sync';
import { createKeypair } from '../../protocol/token.mjs';
import { buildPass, signPass, buildLeg, signLeg, buildTap, signTap } from '../../protocol/leg.mjs';
import { priceDistance, TARIFF } from '../../protocol/meter.mjs';
import '../../src/styles/app.css';
import '../../src/styles/meter.css';
registerSW({ immediate: true });
installRandomSource();
const busKeys = createKeypair();
const route = { id: 'R1', color: '#a8202f', stops: [{ name: '<unsafe stop>', ne: 'Stop A', lat: 27.70, lon: 85.31 }, { name: 'Stop B', ne: 'Stop B', lat: 27.72, lon: 85.33 }] };
function ReportProbe() {
  const [version, setVersion] = useState('A');
  const [draft, setDraft] = useState('');
  const [calls, setCalls] = useState(0);
  const { data, reload } = useLoad(async () => {
    setCalls((count) => count + 1);
    const snapshot = version;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return snapshot;
  }, [version]);
  return <><input aria-label="Unsaved operator edit" value={draft} onChange={(event) => setDraft(event.target.value)} /><button onClick={() => setVersion('B')}>Change report scope</button><button onClick={reload}>Refresh report</button><output data-testid="report">{data ?? 'Loading'}</output><output data-testid="report-calls">{calls}</output></>;
}
function App() {
  const [tick, setTick] = useState(0);
  const [busId, setBusId] = useState(null);
  const [clicked, setClicked] = useState(null);
  const [mounted, setMounted] = useState(true);
  const [shown, setShown] = useState(true);
  const [routeId, setRouteId] = useState('R1');
  const [mode, setMode] = useState('map');
  const [message, setMessage] = useState('');
  const [prepared, setPrepared] = useState(null);
  const [showProbe, setShowProbe] = useState(false);
  const [identity, setIdentity] = useState(null);
  useSyncStatus({ name: 'fixture-rider', pending: pendingPassenger, run: syncPassenger, enabled: mode === 'ride' && Boolean(identity) });
  useEffect(() => { loadIdentity().then(setIdentity); const timer = setInterval(() => setTick((n) => n + 1), 100); return () => clearInterval(timer); }, []);
  const buses = [{ id: 'BUS1', plateStr: 'Demo 01', speedKmh: tick, lat: 27.705 + tick * 0.000001, lon: 85.32 }];
  async function prepare() {
    const identity = await loadIdentity();
    const at = Math.floor(Date.now() / 1000);
    const legId = `LBROWSER${at}`;
    const tap = signTap(buildTap({ passengerPublicKey: identity.publicKey, vehicleId: 'DEMOBUS01', doorId: 'A', timestamp: at }), identity.secretKey);
    const pass = signPass(buildPass({ vehicleId: 'DEMOBUS01', tripId: 'TBROWSER', legId, passengerPublicKey: identity.publicKey, boardDoorId: 'A', unitId: 'TESTUNIT', boardOdoM: 0, boardAt: at }), busKeys.secretKey);
    const priced = priceDistance(1000);
    const leg = buildLeg({ vehicleId: 'DEMOBUS01', tripId: 'TBROWSER', legId, passengerPublicKey: identity.publicKey, boardDoorId: 'A', alightDoorId: 'B', boardOdoM: 0, alightOdoM: 1000, distanceM: 1000, distanceSource: 'odometer', boardAt: at, alightAt: at + 60, concession: 'none', amount: priced.amount, tariffCode: TARIFF.code });
    const receipt = signLeg(leg, busKeys.secretKey);
    const response = await fetch('/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devicePublicKey: busKeys.publicKey, meter: { vehicleId: 'DEMOBUS01', publicKey: busKeys.publicKey, capacity: 42 }, taps: [{ legId, tap }] }) });
    const result = await response.json();
    if (!result.tapResults?.[0]?.ok || !await trustedBusKey('DEMOBUS01')) throw new Error('Test key provisioning failed');
    const value = { pass, receipt, forged: signLeg(leg, createKeypair().secretKey) };
    await (await db()).put('meter', value, 'browserFixture');
    setPrepared(value); setMessage('Trusted bus key cached');
  }
  async function scan(kind) {
    const value = prepared ?? await (await db()).get('meter', 'browserFixture');
    window.dispatchEvent(new CustomEvent('bhada:test-scan', { detail: { text: value[kind], mode: kind === 'pass' ? 'pass' : 'receipt' } }));
  }
  return <><h1>Local browser regression fixture</h1><button onClick={() => setShowProbe(!showProbe)}>Operator refresh probe</button>{showProbe ? <ReportProbe /> : null}<button onClick={() => setMode(mode === 'map' ? 'ride' : 'map')}>Toggle surface</button><output data-testid="tick">{tick}</output><p>{message}</p>
    {mode === 'map' ? <><button onClick={() => setMounted(!mounted)}>Remount map</button><button onClick={() => setShown(!shown)}>Hide map</button><button onClick={() => setRouteId(routeId === 'R1' ? 'R2' : 'R1')}>Change route</button><output data-testid="clicked">{clicked ? `${clicked.speed}:${clicked.callbackTick}` : 'none'}</output><output data-testid="selected">{busId ? `${busId}:${tick}` : 'none'}</output><div hidden={!shown}>{mounted ? <OsmFleetMap buses={buses} routes={[{ ...route, id: routeId }]} selectedRouteId={routeId} selectedBusId={busId} onSelectBus={(bus) => { setBusId(bus.id); setClicked({ speed: bus.speedKmh, callbackTick: tick }); }} height="500px" /> : null}</div></>
    : <><button onClick={() => prepare().catch((error) => setMessage(error.message))}>Cache trusted bus key</button><button onClick={() => scan('pass')}>Receive boarding pass</button><button onClick={() => scan('receipt')}>Receive completion receipt</button><button onClick={() => scan('forged')}>Receive forged receipt</button><button onClick={async () => { await syncPassenger(); setMessage('Upload complete'); }}>Reconnect upload</button>{identity ? <Ride /> : null}</>}
  </>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
