// The super admin console.
//
// Everything here goes through admin_* functions that check platform_admins
// themselves; this screen only decides what to show. A login that is not an
// admin sees a closed door, and the database would refuse it anyway.

import { useCallback, useEffect, useState } from 'react';
import BusLoader from '../../components/BusLoader';
import Shell, { PageError } from '../shared/Shell';
import SignIn from '../shared/SignIn';
import { usePasswordRecovery, SetPassword } from '../shared/Recovery';
import { useSession, signOut, call } from '../shared/session';
import { supabaseConfigured } from '../../lib/supabase';
import Overview from './Overview';
import Requests from './Requests';
import Passengers from './Passengers';
import Operators from './Operators';
import Settings from './Settings';
import Errors from './Errors';

export default function Admin() {
  const session = useSession();
  const [recovering, recovered] = usePasswordRecovery();
  const [overview, setOverview] = useState(null);
  const [tab, setTab] = useState('overview');

  const refresh = useCallback(async () => {
    if (!session) return;
    setOverview(await call('admin_overview'));
  }, [session]);

  useEffect(() => { refresh(); }, [refresh]);

  const leave = async () => { await signOut(); setOverview(null); };

  if (!supabaseConfigured) return <Shell label="Super admin"><PageError title="No backend configured" /></Shell>;
  if (session && recovering) {
    return <Shell label="Super admin"><SetPassword onDone={recovered} /></Shell>;
  }
  if (session === undefined) return <BusLoader label="पर्खनुहोस्" sub="Checking your session" />;
  if (!session) {
    return (
      <Shell label="Super admin" bare>
        <SignIn
          title="सुपर एड्मिन"
          subtitle="Platform administrators only"
          redirectPath="/admin"
          pitch={(
            <>
              <h1>भाडा<br />नियन्त्रण कक्ष</h1>
              <p>
                Load top-ups, look up any wallet or bus company, post corrections and suspend
                accounts. Every action is checked by the database against the admin list, and
                every money movement is a new row with a reason.
              </p>
            </>
          )}
        />
      </Shell>
    );
  }
  if (!overview) return <BusLoader label="नियन्त्रण कक्ष" sub="Loading the platform" />;
  if (overview.reason === 'not_admin') {
    return (
      <Shell label="Super admin" who={{ name: session.user.email }} onSignOut={leave}>
        <PageError
          title="This login is not a super admin"
          detail="Admin access is granted in the database, not from this screen. Sign in with an admin account."
        />
      </Shell>
    );
  }
  if (!overview.ok) {
    return <Shell label="Super admin" onSignOut={leave}><PageError title="The console did not load" detail={overview.message} onRetry={refresh} /></Shell>;
  }

  const tabs = [
    { id: 'overview', ne: 'सारांश', en: 'Overview' },
    { id: 'requests', ne: 'रिचार्ज', en: 'Top-up requests', badge: overview.pending_requests || null },
    { id: 'passengers', ne: 'यात्रु', en: 'Passengers' },
    { id: 'operators', ne: 'कम्पनी', en: 'Operators' },
    { id: 'errors', ne: 'त्रुटि', en: 'Errors' },
    { id: 'settings', ne: 'सेटिङ', en: 'Settings' },
  ];

  return (
    <Shell
      label="Super admin"
      who={{ name: session.user.email, sub: 'Platform administrator' }}
      onSignOut={leave}
      tabs={tabs}
      tab={tab}
      onTab={(next) => { setTab(next); refresh(); }}
    >
      {tab === 'overview' ? <Overview overview={overview} onTab={setTab} /> : null}
      {tab === 'requests' ? <Requests onChange={refresh} /> : null}
      {tab === 'passengers' ? <Passengers onChange={refresh} /> : null}
      {tab === 'operators' ? <Operators /> : null}
      {tab === 'errors' ? <Errors /> : null}
      {tab === 'settings' ? <Settings /> : null}
    </Shell>
  );
}
