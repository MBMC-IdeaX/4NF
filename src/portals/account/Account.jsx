// The passenger's account: balance, statement, top-up, settings.
//
// Online only, like any banking screen. Riding never needs it — a phone that
// has never signed in still taps on and off — but this is where a passenger
// sees where their money went and puts more in.

import { useCallback, useEffect, useState } from 'react';
import { supabaseConfigured } from '../../lib/supabase';
import { navigate } from '../../lib/router';
import BusLoader from '../../components/BusLoader';
import Shell, { PageError } from '../shared/Shell';
import AppSignIn from '../../ui/AppSignIn';
import { usePasswordRecovery, SetPassword } from '../shared/Recovery';
import { useSession, signOut, call } from '../shared/session';
import { explain, rupees, METHOD_NAMES } from '../shared/format';
import { passkeyEnrolled, unlockWithPasskey } from '../shared/passkey';
import { linkWalletToAccount, walletKey } from '../../device/sync';
import { applyServerBalance } from '../../device/identity';
import { finishGatewayReturn } from './payments';
import Home from './Home';
import Statement from './Statement';
import TopUp from './TopUp';
import Settings from './Settings';

const TABS = [
  { id: 'home', ne: 'गृह', en: 'Home' },
  { id: 'statement', ne: 'विवरण', en: 'Statement' },
  { id: 'topup', ne: 'रिचार्ज', en: 'Top up' },
  { id: 'settings', ne: 'सेटिङ', en: 'Settings' },
];

export default function Account() {
  const session = useSession();
  const [recovering, recovered] = usePasswordRecovery();
  const [account, setAccount] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('home');
  const [unlocked, setUnlocked] = useState(false);
  const [banner, setBanner] = useState(null);
  // Back from a gateway: nothing is shown until the payment has been settled,
  // or the screen would list the request as it was before.
  const [settling, setSettling] = useState(() => /\/app\/account\/(esewa|esewa-failed)$/.test(window.location.pathname));
  const [epoch, setEpoch] = useState(0);

  const userId = session?.user?.id;

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    const result = await call('my_account');
    if (result?.reason === 'server_error') { setError(result.message); return; }
    // A login linked to a different phone's wallet: this phone is new, or the
    // old one was lost. Its balance must not be copied onto this phone.
    const here = await walletKey().catch(() => null);
    const elsewhere = Boolean(result?.linked && here && result.wallet !== here);
    setAccount({ ...result, elsewhere });
    if (result?.linked && !result.suspended && !elsewhere) applyServerBalance(result.balance).catch(() => {});
  }, [session]);

  useEffect(() => { load(); }, [load]);

  // Back from eSewa: finish the payment before anything else.
  useEffect(() => {
    if (!session) return;
    let live = true;
    finishGatewayReturn({ accessToken: session.access_token }).then((result) => {
      if (!live) return;
      setSettling(false);
      if (!result) return;
      window.history.replaceState({}, '', '/app/wallet');
      const name = METHOD_NAMES[result.method];
      setBanner(result.ok
        ? { tone: 'ok', text: `${name} payment received. ${result.balance !== undefined ? `Your balance is ${rupees(result.balance)}.` : ''}` }
        : { tone: 'error', text: `${name}: ${explain(result, 'The payment did not go through.')}` });
      setTab('home');
      setEpoch((n) => n + 1);
      load();
    });
    return () => { live = false; };
  }, [session, load]);

  const leave = async () => { await signOut(); setAccount(null); setUnlocked(false); };

  if (!supabaseConfigured) {
    return <Shell label="My account"><PageError title="No backend configured" /></Shell>;
  }
  if (session && recovering) {
    return <Shell label="My account"><SetPassword onDone={recovered} /></Shell>;
  }
  if (session === undefined) return <BusLoader label="पर्खनुहोस्" sub="Opening your account" />;
  if (!session) {
    return (
      <AppSignIn
        embedded
        app="Rider"
        title="मेरो खाता"
        lead="Riding needs no account. Sign in to top up with eSewa and see every ride on one statement."
        redirectPath="/app/wallet"
        allowPhone
      />
    );
  }
  if (error) return <Shell label="My account" onSignOut={leave}><PageError title="Could not open your account" detail={error} onRetry={load} /></Shell>;
  if (!account) return <BusLoader label="खाता खुल्दै" sub="Loading your wallet" />;
  if (settling) return <BusLoader label="भुक्तानी जाँच" sub="Checking your payment" />;

  const who = { name: account.email ?? session.user.phone ?? 'My account', sub: account.linked ? rupees(account.balance) : 'Phone not linked' };

  if (!account.linked || account.elsewhere) {
    const linked = (amount) => {
      if (amount !== null && amount !== undefined) {
        setBanner({ tone: 'ok', text: `Your money is on this phone now: ${rupees(amount)} moved. The old phone can no longer pay.` });
      }
      load();
    };
    return (
      <Shell label="My account" who={who} onSignOut={leave}>
        <LinkWallet session={session} onLinked={linked} elsewhere={account.elsewhere} balance={account.balance} />
      </Shell>
    );
  }
  if (account.suspended) {
    return (
      <Shell label="My account" who={who} onSignOut={leave}>
        <PageError
          title="This account is suspended"
          detail="Top-ups and the statement are closed while the account is reviewed. Rides you already took still settle. Contact Bhada support."
        />
      </Shell>
    );
  }
  if (passkeyEnrolled(userId) && !unlocked) {
    return (
      <Shell label="My account" who={{ name: who.name }} onSignOut={leave}>
        <Locked userId={userId} onUnlock={() => setUnlocked(true)} />
      </Shell>
    );
  }

  return (
    <Shell label="My account" who={who} onSignOut={leave} tabs={TABS} tab={tab} onTab={setTab}>
      {banner ? (
        <p className={banner.tone === 'ok' ? 'op-success op-banner' : 'op-error op-banner'} role="status">
          {banner.text}
          <button type="button" aria-label="Dismiss" onClick={() => setBanner(null)}>×</button>
        </p>
      ) : null}
      {tab === 'home' ? <Home key={epoch} account={account} onTab={setTab} /> : null}
      {tab === 'statement' ? <Statement /> : null}
      {tab === 'topup' ? <TopUp session={session} account={account} onDone={load} /> : null}
      {tab === 'settings' ? <Settings session={session} account={account} onSignOut={leave} /> : null}
    </Shell>
  );
}

function LinkWallet({ session, onLinked, elsewhere: startElsewhere = false, balance = null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set when this login's money is on another phone: the question is then
  // whether to move it here, which is a different and bigger thing than a link.
  const [elsewhere, setElsewhere] = useState(startElsewhere);

  async function link(move = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await linkWalletToAccount({ accessToken: session.access_token, userId: session.user.id, move });
      if (result?.ok) onLinked(result.moved ? result.amount : null);
      else if (result?.reason === 'account_has_wallet') setElsewhere(true);
      else setError(explain(result, 'This phone could not be linked.'));
    } catch (problem) {
      setError(problem.message);
    }
    setBusy(false);
  }

  if (elsewhere) {
    return (
      <div className="op-auth">
        <div className="op-auth__pitch">
          <h1>पैसा यो फोनमा सार्ने?</h1>
          <p>
            Your money{balance !== null ? ` (${rupees(balance)})` : ''} is on another phone. If that
            phone is lost, broken or replaced, move the money here. Your balance, any amount owed
            and your history come with it.
          </p>
          <ul>
            <li><b>The old phone stops paying.</b> A ride someone starts on it after this is refused, so nobody can spend your balance with it.</li>
            <li><b>Rides you already took still count.</b> If the old phone uploads them later, they are paid from here.</li>
          </ul>
        </div>
        <div className="op-sheet">
          <h2>
            यो फोनमा सार्नुहोस्
            <small>Move my money to this phone</small>
          </h2>
          <div className="op-form">
            {error ? <p className="op-error" role="alert">{error}</p> : null}
            <button type="button" className="op-btn op-btn--block" onClick={() => link(true)} disabled={busy}>
              {busy ? 'Moving…' : 'Move my money to this phone'}
            </button>
            {startElsewhere ? null : (
              <button type="button" className="op-btn op-btn--block op-btn--ghost" onClick={() => setElsewhere(false)} disabled={busy}>
                Not now
              </button>
            )}
            <p className="op-field__help">Only do this if you no longer use the other phone.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="op-auth">
      <div className="op-auth__pitch">
        <h1>यो फोन खातामा जोड्नुहोस्</h1>
        <p>
          Your rides and ride balance belong to a key on this phone. Linking it to your login lets you
          see your statement, top up through eSewa from anywhere, and move your balance to a new phone
          if this one is lost.
        </p>
        <ul>
          <li><b>Lost your phone?</b> Sign in on a new one and your balance moves with you.</li>
          <li><b>Nothing changes on the bus.</b> Tapping on and off works the same.</li>
        </ul>
      </div>
      <div className="op-sheet">
        <h2>
          फोन जोड्ने
          <small>Link this phone’s ride account</small>
        </h2>
        <div className="op-form">
          {error ? <p className="op-error" role="alert">{error}</p> : null}
          <button type="button" className="op-btn op-btn--block" onClick={() => link(false)} disabled={busy}>
            {busy ? 'Linking…' : 'Link this phone’s ride account'}
          </button>
          <p className="op-field__help">Needs a network connection for a few seconds.</p>
        </div>
      </div>
    </div>
  );
}

function Locked({ userId, onUnlock }) {
  const [error, setError] = useState(null);

  async function unlock() {
    setError(null);
    try {
      if (await unlockWithPasskey(userId)) onUnlock();
      else setError('Your phone did not confirm it was you.');
    } catch {
      setError('Unlock was cancelled. Try again.');
    }
  }

  return (
    <div className="op-lock">
      <div className="op-lock__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
          <path d="M9 9v1M15 9v1M12 9v4h-1M9.5 15.5a3.5 3.5 0 0 0 5 0" />
        </svg>
      </div>
      <h1>खाता बन्द छ</h1>
      <p>Unlock with Face ID, your fingerprint or your phone’s PIN.</p>
      {error ? <p className="op-error" role="alert">{error}</p> : null}
      <button type="button" className="op-btn" onClick={unlock}>Unlock</button>
    </div>
  );
}
