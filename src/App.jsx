// The public site build: landing, the demo, the inspector and the admin
// console. The Rider, Crew and Owner apps are separate builds (src/apps/).

import { lazy, Suspense, useEffect } from 'react';
import Home from './pages/Home';
import { unlockAudio, warmVoices } from './lib/voice';
import { useRoute } from './lib/router';
import { resolveSurface } from './lib/surface.mjs';
import BusLoader from './components/BusLoader';

// The super admin console, an online office tool.
const Admin = lazy(() => import('./portals/admin/Admin'));

// The whole system on one screen, for a pitch. It brings Postgres with it
// (about 16 MB), so it is never precached and no phone ever downloads it.
const Demo = lazy(() => import('./screens/Demo'));

// A fare inspector's phone. Precached like the door: an inspector is exactly
// the person on a bus with no signal.
const Inspect = lazy(() => import('./screens/Inspect'));

// The UI kit on one page. Development only; a production build drops it.
const Kit = import.meta.env.DEV ? lazy(() => import('./ui/Kit')) : null;

export default function App() {
  const [path, crossing] = useRoute();

  // Browsers refuse audio until a user gesture. The first tap anywhere warms
  // the audio context, well before a fare is spoken at the door.
  useEffect(() => {
    const warm = () => { unlockAudio(); warmVoices(); };
    window.addEventListener('pointerdown', warm, { once: true });
    return () => window.removeEventListener('pointerdown', warm);
  }, []);

  // The dashboard is a separate download, so its wait is real rather than
  // decorative. The route crossing rides on top of whatever is underneath.
  const { app } = resolveSurface(path);
  const surface = (() => {
    switch (app) {
      case 'kit':
        if (Kit) return <Suspense fallback={null}><Kit /></Suspense>;
        return <Home />;
      case 'demo':
        return <Suspense fallback={<BusLoader label="प्रदर्शन" sub="Loading the demonstration" />}><Demo /></Suspense>;
      case 'inspect':
        return <Suspense fallback={<BusLoader label="निरीक्षण" sub="Fare inspection" />}><Inspect /></Suspense>;
      case 'admin':
        return <Suspense fallback={<BusLoader label="नियन्त्रण कक्ष" sub="Opening the console" />}><Admin /></Suspense>;
      default:
        return <Home />;
    }
  })();

  return (
    <>
      {surface}
      {crossing ? <BusLoader /> : null}
    </>
  );
}
