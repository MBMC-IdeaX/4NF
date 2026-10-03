// Crew — the conductor's phone is the bus. For now each tab mounts the screen
// that already does the job; phase 4 folds them into one trip screen.
//
// The meter is kept mounted once it has been opened: leaving its tab must not
// stop the odometer mid-trip. The camera screens are not kept, so only the one
// in front holds the camera.
//
// A phone that has not been told which bus it is opens on Setup (0034): scan
// the owner's code, or choose the demo bus. A phone the backend has not
// confirmed says so on top, with a way to set up again.

import { lazy, Suspense, useEffect, useState } from 'react';
import AppFrame from '../../ui/AppFrame';
import BusLoader from '../../components/BusLoader';
import { navigate } from '../../lib/router';
import { useSyncStatus } from '../../lib/useSyncStatus';
import { pendingConductor } from '../../device/outbox';
import { syncConductor } from '../../device/sync';
import { isProvisioned } from '../../device/fleet';
import Setup from './Setup';
import UnitStatus from './UnitStatus';
import './crew.css';

const Conductor = lazy(() => import('../../screens/Conductor'));
const Device = lazy(() => import('../../screens/Device'));
const Terminal = lazy(() => import('../../screens/Terminal'));
const Crew = lazy(() => import('../../screens/Crew'));

const TABS = [
  { id: 'trip', label: 'यात्रा', icon: 'scan' },
  { id: 'bus', label: 'मिटर', icon: 'gauge' },
  { id: 'door', label: 'ढोका', icon: 'door' },
  { id: 'shift', label: 'सिफ्ट', icon: 'user' },
];

export function crewTab(page) {
  const first = page.split('/')[0];
  return TABS.some((tab) => tab.id === first) ? first : 'trip';
}

const debug = new URLSearchParams(window.location.search).has('debug');

// A phone someone chose to run as the demo bus does not ask again. Per device,
// and only a convenience: losing it means the setup screen once more.
const DEMO_KEY = 'bhada-crew-demo';
const demoChosen = () => { try { return localStorage.getItem(DEMO_KEY) === '1'; } catch { return false; } };
const chooseDemo = () => { try { localStorage.setItem(DEMO_KEY, '1'); } catch { /* private window */ } };

export default function CrewApp({ page }) {
  const tab = crewTab(page);
  const [meterOn, setMeterOn] = useState(tab === 'bus');
  useEffect(() => { if (tab === 'bus') setMeterOn(true); }, [tab]);
  const sync = useSyncStatus({ name: 'crew', pending: pendingConductor, run: syncConductor });
  const go = (id) => navigate(id === 'trip' ? '/crew' : `/crew/${id}`);
  const [setup, setSetup] = useState(() => !isProvisioned() && !demoChosen());

  if (setup) {
    return (
      <AppFrame brand="खलासी" tone="night">
        <Setup
          onDone={() => { setSetup(false); go('bus'); }}
          onDemo={() => { chooseDemo(); setSetup(false); }}
        />
      </AppFrame>
    );
  }

  return (
    <AppFrame brand="खलासी" tone="night" tabs={TABS} tab={tab} onTab={go} sync={sync} railed glance={tab === 'trip'}>
      <UnitStatus onSetupAgain={() => setSetup(true)} />
      <Suspense fallback={<BusLoader />}>
        {meterOn ? <div hidden={tab !== 'bus'}><Device /></div> : null}
        {tab === 'trip' ? <Conductor onBack={() => go('shift')} debug={debug} /> : null}
        {tab === 'door' ? <Terminal /> : null}
        {tab === 'shift' ? <Crew /> : null}
      </Suspense>
    </AppFrame>
  );
}
