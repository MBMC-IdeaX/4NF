// The operator surface: sign in, register the company, add buses, read the data.
//
// This is the only part of Bhada that requires a network, and that is correct.
// It is an office tool. Nothing here can stop a fare being collected on a bus.

import { useCallback, useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from '../../lib/supabase';
import BusLoader from '../../components/BusLoader';
import Shell, { PageError } from '../shared/Shell';
import Icon from '../shared/Icon';
import SignIn from '../shared/SignIn';
import { usePasswordRecovery, SetPassword } from '../shared/Recovery';
import { useSession, signOut } from '../shared/session';
import Overview from './Overview';
import Vehicles from './Vehicles';
import Returns from './Returns';

const TABS = [
  { id: 'overview', ne: 'कारोबार', en: 'Overview' },
  { id: 'vehicles', ne: 'बसहरू', en: 'Buses & routes' },
  { id: 'returns', ne: 'विवरण', en: 'DoTM return' },
];

export default function Operator() {
  const session = useSession();
  const [recovering, recovered] = usePasswordRecovery();
  const [operator, setOperator] = useState(null);
  const [tab, setTab] = useState('overview');
  const [error, setError] = useState(null);

  const loadOperator = useCallback(async () => {
    if (!session) return;
    setError(null);
    const { data, error: problem } = await supabase.rpc('my_operator');
    if (problem) setError(problem.message);
    else setOperator(data);
  }, [session]);

  useEffect(() => { loadOperator(); }, [loadOperator]);

  const leave = async () => { await signOut(); setOperator(null); };

  if (!supabaseConfigured) {
    return <Shell label="Operator"><PageError title="No backend configured" detail="Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then reload." /></Shell>;
  }
  if (session && recovering) {
    return <Shell label="Operator"><SetPassword onDone={recovered} /></Shell>;
  }
  if (session === undefined) return <BusLoader label="पर्खनुहोस्" sub="Checking your session" />;
  if (!session) {
    return (
      <Shell label="Operator" bare>
        <SignIn
          title="अपरेटर लगइन"
          subtitle="Sign in to your bus company"
          redirectPath="/operator"
          pitch={(
            <>
              <h1>तपाईंको बस,<br />किलोमिटरमा।</h1>
              <p>
                Every ride your buses carry, priced by the kilometre and settled once — with the
                overload record the regulator asks for, computed rather than written up.
              </p>
              <ul>
                <li><Icon name="check" size={20} /><span><b>Rides and rupees</b> by bus, hour and segment</span></li>
                <li><Icon name="check" size={20} /><span><b>Rs per passenger-km</b>, the number a fare review turns on</span></li>
                <li><Icon name="check" size={20} /><span><b>DoTM return</b> as a spreadsheet, straight from settled rides</span></li>
                <li><Icon name="check" size={20} /><span><b>Crew bonuses</b>, what each clean trip cost and what the rest went wrong on</span></li>
              </ul>
            </>
          )}
        />
      </Shell>
    );
  }
  if (error && !operator) {
    return <Shell label="Operator" onSignOut={leave}><PageError title="Could not load your company" detail={error} onRetry={loadOperator} /></Shell>;
  }
  if (!operator) return <BusLoader label="विवरण आउँदैछ" sub="Loading your company" />;

  if (!operator.registered) {
    return <Shell label="Operator" onSignOut={leave}><RegisterOperator onDone={loadOperator} /></Shell>;
  }
  if (operator.suspended) {
    return (
      <Shell label="Operator" who={{ name: operator.name, sub: operator.operator_id }} onSignOut={leave}>
        <PageError
          title="This company is suspended"
          detail="The dashboard is closed while the account is under review. Fares from your buses still settle. Contact Bhada support to reopen it."
        />
      </Shell>
    );
  }

  return (
    <Shell
      label="Operator"
      who={{ name: operator.name, sub: `${operator.operator_id} · ${operator.vehicles} ${operator.vehicles === 1 ? 'bus' : 'buses'}` }}
      onSignOut={leave}
      tabs={TABS}
      tab={tab}
      onTab={setTab}
    >
      {tab === 'overview' ? <Overview onAddBus={() => setTab('vehicles')} /> : null}
      {tab === 'vehicles' ? <Vehicles operator={operator} onChange={loadOperator} /> : null}
      {tab === 'returns' ? <Returns /> : null}
    </Shell>
  );
}

function RegisterOperator({ onDone }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: problem } = await supabase.rpc('register_operator', {
      p_name: name,
      p_display_name: null,
    });
    setBusy(false);
    if (problem) { setError(problem.message); return; }
    if (!data?.ok) { setError(`Could not register: ${data?.reason ?? 'unknown'}`); return; }
    onDone();
  }

  return (
    <div className="op-auth">
      <div className="op-auth__pitch">
        <h1>कम्पनीको नाम</h1>
        <p>
          One last step. Name your bus company, then add your buses by plate and route — the
          dashboard fills in as soon as their meters and door phones find a signal.
        </p>
      </div>
      <form className="op-sheet" onSubmit={submit}>
        <h2>
          कम्पनी दर्ता
          <small>Register your company</small>
        </h2>
        <div className="op-form">
          <label className="op-field">
            <span>कम्पनीको नाम / Company name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mayur Yatayat"
              autoComplete="organization"
              required
            />
          </label>
          {error ? <p className="op-error" role="alert">{error}</p> : null}
          <button type="submit" className="op-btn op-btn--block" disabled={busy || !name.trim()}>
            {busy ? 'Registering…' : 'Register company'}
          </button>
        </div>
      </form>
    </div>
  );
}
