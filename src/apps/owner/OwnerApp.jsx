// Owner — the bus company's app. Bhada onboards the company and invites its
// owner (0038); the owner joins with that code, then sees the company itself:
// today, buses, people, papers, money, reports, agreements.
//
// What a login sees follows its role (0033): an owner sees everything; a
// manager runs buses, people and papers but not money; a bus owner sees only
// their own buses and their own money; a conductor is sent to the Crew app.

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import AppFrame from '../../ui/AppFrame';
import AppSignIn from '../../ui/AppSignIn';
import { Button, Empty } from '../../ui';
import BusLoader from '../../components/BusLoader';
import { supabaseConfigured } from '../../lib/supabase';
import { navigate } from '../../lib/router';
import { useSession, signOut } from '../../portals/shared/session';
import { usePasswordRecovery, SetPassword } from '../../portals/shared/Recovery';
import { call, say } from './data';
import Start from './Start';
import Today from './Today';
import Buses from './Buses';
import People from './People';
import Papers from './Papers';
import Agreements from './Agreements';
import BusOwnerHome from './BusOwnerHome';
import './owner.css';

// Money pulls in the QR maker for nothing, Reports pulls in Recharts: each is
// fetched when first opened.
const Money = lazy(() => import('./Money'));
const Reports = lazy(() => import('./Reports'));

const ALL_TABS = [
  { id: 'today', label: 'आज', icon: 'home' },
  { id: 'buses', label: 'बसहरू', icon: 'bus' },
  { id: 'people', label: 'मानिस', icon: 'users' },
  { id: 'papers', label: 'कागजात', icon: 'statement' },
  { id: 'money', label: 'पैसा', icon: 'wallet', owner: true },
  { id: 'reports', label: 'रिपोर्ट', icon: 'chart' },
];

// A bus owner's app is three pages: their buses, their money, their agreement.
const BUS_OWNER_TABS = [
  { id: 'today', label: 'मेरो बस', icon: 'bus' },
  { id: 'money', label: 'पैसा', icon: 'wallet' },
  { id: 'agreements', label: 'सम्झौता', icon: 'statement' },
];
// Pages reached from a link rather than a tab.
const PAGES = ['agreements'];

export function ownerRoute(page) {
  const [tab = 'today', ...rest] = String(page ?? '').split('/').filter(Boolean);
  return { tab: ALL_TABS.some((t) => t.id === tab) || PAGES.includes(tab) ? tab : 'today', rest };
}

export default function OwnerApp({ page = '' }) {
  const session = useSession();
  const [recovering, recovered] = usePasswordRecovery();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  const loadMe = useCallback(async () => {
    if (!session) return;
    setError(null);
    const result = await call('my_operator');
    if (result?.ok === false) setError(say(result));
    else setMe(result);
  }, [session]);
  useEffect(() => { loadMe(); }, [loadMe]);

  const leave = async () => { await signOut(); setMe(null); };

  if (!supabaseConfigured) {
    return <Shell><Empty error title="No backend configured">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then reload.</Empty></Shell>;
  }
  if (session === undefined) return <BusLoader label="पर्खनुहोस्" sub="Checking your session" />;
  if (!session) {
    return (
      <AppSignIn
        app="Owner"
        title="साइन इन"
        lead="Your buses, their fares, their papers and your payouts."
        redirectPath="/owner"
        signUpLabel="Create a login"
      />
    );
  }
  if (recovering) return <Shell onSignOut={leave}><SetPassword onDone={recovered} /></Shell>;
  if (error) {
    return <Shell onSignOut={leave}><Empty error title="Could not open your company" action={<Button variant="secondary" onClick={loadMe}>Try again</Button>}>{error}</Empty></Shell>;
  }
  if (!me) return <BusLoader label="विवरण आउँदैछ" sub="Opening your company" />;
  if (!me.registered) return <Shell onSignOut={leave}><Start email={session.user?.email} onDone={loadMe} /></Shell>;
  if (me.suspended) {
    return (
      <Shell onSignOut={leave}>
        <Empty error title="This company is suspended">
          The dashboard is closed while the account is under review. Fares from your buses still settle. Contact Bhada support to reopen it.
        </Empty>
      </Shell>
    );
  }
  if (me.role === 'conductor') {
    return (
      <Shell onSignOut={leave}>
        <Empty icon="scan" title="This is a conductor’s login" action={<Button onClick={() => window.location.assign('/crew')}>Open Bhada Crew</Button>}>
          {me.name} added you as a conductor. Your work is in the Crew app, on the bus phone.
        </Empty>
      </Shell>
    );
  }

  const isOwner = me.role === 'owner';
  const busOwner = me.role === 'bus_owner';
  const tabs = busOwner ? BUS_OWNER_TABS : ALL_TABS.filter((t) => !t.owner || isOwner);
  const { tab, rest } = ownerRoute(page);
  const go = (path) => navigate(`/owner${path ? `/${path}` : ''}`);
  const ctx = { me, isOwner, go, reloadMe: loadMe };
  const ROLE_NAME = { owner: 'Owner', manager: 'Manager', bus_owner: 'Bus owner' };

  if (busOwner) {
    return (
      <AppFrame brand="भाडा" tabs={tabs} tab={BUS_OWNER_TABS.some((t) => t.id === tab) ? tab : 'today'} onTab={(id) => go(id === 'today' ? '' : id)} railed wide
        top={{ eyebrow: `Bus owner · ${me.name}`, title: me.display_name ?? me.name, end: <Button variant="ghost" icon="logout" onClick={leave} aria-label="Sign out" /> }}>
        <Suspense fallback={<BusLoader />}>
          {tab === 'money' ? <Money {...ctx} view={rest[0]} />
            : tab === 'agreements' ? <Agreements {...ctx} />
              : <BusOwnerHome {...ctx} />}
        </Suspense>
      </AppFrame>
    );
  }

  return (
    <AppFrame
      brand="भाडा"
      tabs={tabs}
      tab={tab}
      onTab={(id) => go(id === 'today' ? '' : id)}
      railed
      wide
      top={{
        eyebrow: ROLE_NAME[me.role] ?? 'Owner',
        title: me.name,
        end: <Button variant="ghost" icon="logout" onClick={leave} aria-label="Sign out" />,
      }}
    >
      <Suspense fallback={<BusLoader />}>
        {tab === 'today' ? <Today {...ctx} /> : null}
        {tab === 'buses' ? <Buses {...ctx} plate={rest[0]} /> : null}
        {tab === 'people' ? <People {...ctx} /> : null}
        {tab === 'papers' ? <Papers {...ctx} focus={rest[0]} /> : null}
        {tab === 'money' && isOwner ? <Money {...ctx} view={rest[0]} /> : null}
        {tab === 'reports' ? <Reports {...ctx} /> : null}
        {tab === 'agreements' ? <Agreements {...ctx} /> : null}
      </Suspense>
    </AppFrame>
  );
}

function Shell({ onSignOut, children }) {
  return (
    <AppFrame brand="भाडा" top={{ eyebrow: 'Owner', end: onSignOut ? <Button variant="ghost" icon="logout" onClick={onSignOut} aria-label="Sign out" /> : null }}>
      {children}
    </AppFrame>
  );
}
