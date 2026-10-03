// Rider — the app a passenger installs as "Bhada". Home is new; the other tabs
// still mount the screens that already do the job until they are rebuilt.

import { lazy, Suspense } from 'react';
import AppFrame from '../../ui/AppFrame';
import BusLoader from '../../components/BusLoader';
import { navigate } from '../../lib/router';
import { useSyncStatus } from '../../lib/useSyncStatus';
import { pendingPassenger } from '../../device/outbox';
import { syncPassenger } from '../../device/sync';
import RiderHome from './RiderHome';

const Ride = lazy(() => import('../../screens/Ride'));
const Passenger = lazy(() => import('../../screens/Passenger'));
const Account = lazy(() => import('../../portals/account/Account'));

const TABS = [
  { id: 'home', label: 'गृह', icon: 'home' },
  { id: 'ride', label: 'यात्रा', icon: 'qr' },
  { id: 'ticket', label: 'टिकट', icon: 'ticket' },
  { id: 'wallet', label: 'खाता', icon: 'wallet' },
];

export function riderTab(page) {
  const first = page.split('/')[0];
  return TABS.some((tab) => tab.id === first) ? first : 'home';
}

export default function RiderApp({ page }) {
  const tab = riderTab(page);
  const sync = useSyncStatus({ name: 'rider', pending: pendingPassenger, run: syncPassenger });
  const go = (id) => navigate(id === 'home' ? '/app' : `/app/${id}`);
  return (
    <AppFrame tabs={TABS} tab={tab} onTab={go} sync={sync} railed glance={tab === 'ride'}>
      <Suspense fallback={<BusLoader />}>
        {tab === 'home' ? <RiderHome go={go} /> : null}
        {tab === 'ride' ? <Ride onBack={() => go('home')} onStageFare={() => go('ticket')} /> : null}
        {tab === 'ticket' ? <Passenger onBack={() => go('home')} /> : null}
        {tab === 'wallet' ? <Account /> : null}
      </Suspense>
    </AppFrame>
  );
}
