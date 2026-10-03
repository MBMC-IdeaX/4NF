// Staff — Bhada's own console. A reviewer onboards companies, enters their
// buses from the bluebook and permit, checks every paper and builds routes from
// permits. A platform admin also takes a company live, publishes the agreement
// texts, sets Bhada's rates and pays out.
//
// Not a public app: a login that is neither is told so and nothing else.

import { useCallback, useEffect, useState } from 'react';
import AppFrame from '../../ui/AppFrame';
import AppSignIn from '../../ui/AppSignIn';
import { Button, Empty } from '../../ui';
import BusLoader from '../../components/BusLoader';
import { supabaseConfigured } from '../../lib/supabase';
import { navigate } from '../../lib/router';
import { useSession, signOut } from '../../portals/shared/session';
import { usePasswordRecovery, SetPassword } from '../../portals/shared/Recovery';
import { call } from './data';
import Companies from './Companies';
import Company from './Company';
import Review from './Review';
import Requests from './Requests';
import Payouts from './Payouts';
import Platform from './Platform';
import '../owner/owner.css';
import './staff.css';

const ALL_TABS = [
  { id: 'companies', label: 'कम्पनी', icon: 'bus' },
  { id: 'review', label: 'कागजात', icon: 'statement' },
  { id: 'requests', label: 'अनुरोध', icon: 'inbox' },
  { id: 'payouts', label: 'भुक्तानी', icon: 'wallet', admin: true },
  { id: 'platform', label: 'दर', icon: 'settings', admin: true },
];

export function staffRoute(page) {
  const [tab = 'companies', ...rest] = String(page ?? '').split('/').filter(Boolean);
  return { tab: ALL_TABS.some((t) => t.id === tab) ? tab : 'companies', rest };
}

export default function StaffApp({ page = '' }) {
  const session = useSession();
  const [recovering, recovered] = usePasswordRecovery();
  const [me, setMe] = useState(null);
  const [counts, setCounts] = useState({});

  const loadMe = useCallback(async () => {
    if (!session) return;
    const [reviewer, admin] = await Promise.all([call('is_reviewer'), call('is_platform_admin')]);
    setMe({ reviewer: reviewer === true, admin: admin === true, failed: reviewer?.ok === false });
  }, [session]);
  useEffect(() => { loadMe(); }, [loadMe]);

  // What is waiting, for the tab badges.
  const loadCounts = useCallback(async () => {
    if (!me?.reviewer) return;
    const [docs, reqs, payouts] = await Promise.all([
      call('review_queue', { p_status: 'pending' }),
      call('review_requests', { p_status: 'pending' }),
      me.admin ? call('admin_payouts', { p_status: 'requested' }) : null,
    ]);
    setCounts({
      review: docs?.documents?.length || 0,
      requests: reqs?.requests?.length || 0,
      payouts: Array.isArray(payouts) ? payouts.length : 0,
    });
  }, [me]);
  useEffect(() => { loadCounts(); }, [loadCounts, page]);

  const leave = async () => { await signOut(); setMe(null); };

  if (!supabaseConfigured) {
    return <Shell><Empty error title="No backend configured">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then reload.</Empty></Shell>;
  }
  if (session === undefined) return <BusLoader label="पर्खनुहोस्" sub="Checking your session" />;
  if (!session) {
    return <AppSignIn app="Staff" title="Staff sign-in" lead="For Bhada’s onboarding officers, reviewers and admins." redirectPath="/staff" noSignUp />;
  }
  if (recovering) return <Shell onSignOut={leave}><SetPassword onDone={recovered} /></Shell>;
  if (!me) return <BusLoader label="पर्खनुहोस्" sub="Checking your access" />;
  if (me.failed) {
    return <Shell onSignOut={leave}><Empty error title="Could not check your access" action={<Button variant="secondary" onClick={loadMe}>Try again</Button>}>The server did not answer.</Empty></Shell>;
  }
  if (!me.reviewer) {
    return (
      <Shell onSignOut={leave}>
        <Empty icon="shield" title="This login is not Bhada staff">
          {session.user?.email} has no staff access. A platform admin can make it a reviewer. Bus companies use Bhada Owner.
        </Empty>
      </Shell>
    );
  }

  const tabs = ALL_TABS.filter((t) => !t.admin || me.admin).map((t) => ({ ...t, badge: counts[t.id] || null }));
  const { tab, rest } = staffRoute(page);
  const go = (path) => navigate(`/staff${path ? `/${path}` : ''}`);
  const ctx = { me, go, refreshCounts: loadCounts };

  return (
    <AppFrame
      brand="भाडा"
      tabs={tabs}
      tab={tab}
      onTab={(id) => go(id === 'companies' ? '' : id)}
      railed
      wide
      top={{
        eyebrow: me.admin ? 'Staff · Platform admin' : 'Staff · Reviewer',
        title: session.user?.email,
        end: <Button variant="ghost" icon="logout" onClick={leave} aria-label="Sign out" />,
      }}
    >
      {tab === 'companies' && rest[0] ? <Company {...ctx} id={rest[0]} /> : null}
      {tab === 'companies' && !rest[0] ? <Companies {...ctx} /> : null}
      {tab === 'review' ? <Review {...ctx} /> : null}
      {tab === 'requests' ? <Requests {...ctx} /> : null}
      {tab === 'payouts' && me.admin ? <Payouts {...ctx} /> : null}
      {tab === 'platform' && me.admin ? <Platform {...ctx} /> : null}
    </AppFrame>
  );
}

function Shell({ onSignOut, children }) {
  return (
    <AppFrame brand="भाडा" top={{ eyebrow: 'Staff', end: onSignOut ? <Button variant="ghost" icon="logout" onClick={onSignOut} aria-label="Sign out" /> : null }}>
      {children}
    </AppFrame>
  );
}
