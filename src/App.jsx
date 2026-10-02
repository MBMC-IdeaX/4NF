// Role selection, then the offline handshake. Two modes, one codebase.

import { lazy, Suspense, useEffect, useState } from 'react';
import Landing from './pages/Landing';
import { unlockAudio, warmVoices } from './lib/voice';
import { useRoute, navigate } from './lib/router';
import BusLoader from './components/BusLoader';

// The operator dashboard pulls in Recharts and the Supabase client. Neither
// belongs in the bundle a conductor's phone precaches before going offline, so
// it is split out and only fetched when someone actually opens /operator.
const Operator = lazy(() => import('./portals/operator/Operator'));

// The passenger account and the super admin console are online tools for the
// same reason, and are fetched the same way.
const Account = lazy(() => import('./portals/account/Account'));
const Admin = lazy(() => import('./portals/admin/Admin'));

// The meter console and the door terminals are separate downloads for the same
// reason, in reverse: a passenger's phone should never carry the vehicle unit's
// code. Both chunks are still precached, so a door terminal that has been opened
// once keeps working with the radio off.
const Device = lazy(() => import('./screens/Device'));
const Terminal = lazy(() => import('./screens/Terminal'));

// The passenger and conductor screens carry the QR reader, the signing library
// and the odometer. Someone reading the landing page needs none of that, so they
// are split out too. The service worker precaches every chunk, so a phone that
// has opened /app once still runs all three with the radio off.
const Ride = lazy(() => import('./screens/Ride'));
const Passenger = lazy(() => import('./screens/Passenger'));
const Conductor = lazy(() => import('./screens/Conductor'));

// The conductor's own sign-on screen. Small, and on their phone rather than the
// bus, because the key it signs with is theirs and never leaves the handset.
const Crew = lazy(() => import('./screens/Crew'));

// The whole system on one screen, for a pitch. It brings Postgres with it
// (about 16 MB), so it is never precached and no phone ever downloads it.
const Demo = lazy(() => import('./screens/Demo'));

// A fare inspector's phone. Precached like the door: an inspector is exactly
// the person on a bus with no signal.
const Inspect = lazy(() => import('./screens/Inspect'));

const debug = new URLSearchParams(window.location.search).has('debug');

// The vehicle this device is bound to. Real plates read बा २ ख ४४१२.
const PLATE = { province: 'बा', number: '२', series: 'ख', digits: '४४१२' };

export default function App() {
  const [path, crossing] = useRoute();

  // The dashboard is a separate download, so its wait is real rather than
  // decorative. The route crossing rides on top of whatever is underneath.
  const surface = path.startsWith('/demo') ? (
    <Suspense fallback={<BusLoader label="प्रदर्शन" sub="Loading the demonstration" />}>
      <Demo />
    </Suspense>
  ) : path.startsWith('/inspect') ? (
    <Suspense fallback={<BusLoader label="निरीक्षण" sub="Fare inspection" />}>
      <Inspect />
    </Suspense>
  ) : path.startsWith('/admin') ? (
    <Suspense fallback={<BusLoader label="नियन्त्रण कक्ष" sub="Opening the console" />}>
      <Admin />
    </Suspense>
  ) : path.startsWith('/app/account') ? (
    <Suspense fallback={<BusLoader label="मेरो खाता" sub="Opening your account" />}>
      <Account />
    </Suspense>
  ) : path.startsWith('/operator') ? (
    <Suspense fallback={<BusLoader label="डास्बोर्ड आउँदैछ" sub="Opening the dashboard" />}>
      <Operator />
    </Suspense>
  ) : path.startsWith('/device') ? (
    <Suspense fallback={<BusLoader label="मिटर सुरु हुँदै" sub="Powering up the meter" />}>
      <Device />
    </Suspense>
  ) : path.startsWith('/crew') ? (
    <Suspense fallback={<BusLoader label="खलासी" sub="Crew sign-on" />}>
      <Crew />
    </Suspense>
  ) : path.startsWith('/terminal') ? (
    <Suspense fallback={<BusLoader label="ढोका टर्मिनल" sub="Door terminal" />}>
      <Terminal />
    </Suspense>
  ) : path.startsWith('/app') ? (
    <AppShell />
  ) : (
    <Landing />
  );

  return (
    <>
      {surface}
      {crossing ? <BusLoader /> : null}
    </>
  );
}

function AppShell() {
  const [mode, setMode] = useState(null);
  const [back, setBack] = useState(false);
  const [ready, setReady] = useState(null);

  // Whether this device can already run with no signal is the single most
  // useful thing to know before boarding, so it is stated on the first screen.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      const installed = (await caches.keys()).some((key) => key.startsWith('workbox-precache'));
      if (!cancelled) setReady(installed);
    }
    check();
    return () => { cancelled = true; };
  }, []);

  // Forward pushes in from the right, back returns from the left, so moving
  // through the app has a direction you can feel rather than a cross-fade.
  const leave = () => { setBack(true); setMode(null); };
  const enter = (next) => {
    // Browsers refuse audio until a user gesture. Choosing a role is the first
    // tap in every flow, so the audio context is warm well before a fare lands.
    unlockAudio();
    warmVoices();
    setBack(false);
    setMode(next);
  };

  if (mode === 'ride') {
    return (
      <div className="screen" key="ride">
        <Suspense fallback={<BusLoader />}>
          <Ride onBack={leave} onStageFare={() => enter('passenger')} />
        </Suspense>
      </div>
    );
  }
  if (mode === 'passenger') {
    return (
      <div className="screen" key="passenger">
        <Suspense fallback={<BusLoader />}>
          <Passenger onBack={leave} />
        </Suspense>
      </div>
    );
  }
  if (mode === 'conductor') {
    return (
      <div className="screen" key="conductor">
        <Suspense fallback={<BusLoader />}>
          <Conductor onBack={leave} debug={debug} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className={`launch screen${back ? ' screen--back' : ''}`} key="launch">
      <h1 className="launch__mark">
        भाडा
        <span>Fares that work with no signal</span>
      </h1>

      <div className="plate" aria-label="Vehicle बा २ ख ४४१२">
        <div className="plate__row">
          <span>{PLATE.province}</span>
          <span>{PLATE.number}</span>
          <span>{PLATE.series}</span>
        </div>
        <div className="plate__digits tabular">{PLATE.digits}</div>
      </div>

      <p className="launch__status">
        {ready === null
          ? 'Checking offline readiness.'
          : ready
            ? 'Ready offline. Fares up to Rs 500 work with no signal.'
            : 'Not saved for offline yet. Stay on the network for a moment, then add this to your home screen.'}
      </p>

      <div className="launch__roles">
        <button type="button" className="launch__role" onClick={() => enter('ride')}>
          <b>यात्रु</b>
          <small>Passenger, pay by the kilometre</small>
        </button>
        <button type="button" className="launch__role" onClick={() => navigate('/app/account')}>
          <b>मेरो खाता</b>
          <small>Wallet, statement and top-up</small>
        </button>
        <button type="button" className="launch__role" onClick={() => enter('conductor')}>
          <b>खलासी</b>
          <small>Conductor, collect stage fares</small>
        </button>
      </div>

      <p className="launch__group">On the bus</p>
      <div className="launch__aways">
        <button type="button" className="launch__away" onClick={() => navigate('/device')}>
          Meter
          <small>under the seat</small>
        </button>
        <button type="button" className="launch__away" onClick={() => navigate('/terminal')}>
          Door terminal
          <small>at each door</small>
        </button>
        <button type="button" className="launch__away" onClick={() => navigate('/crew')}>
          Crew
          <small>sign on for a shift</small>
        </button>
        <button type="button" className="launch__away" onClick={() => navigate('/inspect')}>
          Inspector
          <small>check a bus</small>
        </button>
        <button type="button" className="launch__away" onClick={() => navigate('/operator')}>
          Owner
          <small>dashboard</small>
        </button>
      </div>
    </div>
  );
}
