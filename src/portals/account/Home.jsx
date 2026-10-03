import { useEffect, useState } from 'react';
import { call } from '../shared/session';
import { navigate } from '../../lib/router';
import { rupees, when, METHOD_NAMES, shortKey } from '../shared/format';
import Entries, { RequestStatus } from '../shared/Entries';
import Icon from '../shared/Icon';

export default function Home({ account, onTab }) {
  const [recent, setRecent] = useState(null);
  const [requests, setRequests] = useState([]);

  useEffect(() => {
    let live = true;
    Promise.all([call('my_statement', { p_limit: 6 }), call('my_topup_requests')]).then(([statement, mine]) => {
      if (!live) return;
      setRecent(statement?.entries ?? []);
      setRequests(Array.isArray(mine) ? mine.filter((r) => ['pending', 'initiated'].includes(r.status)) : []);
    });
    return () => { live = false; };
  }, []);

  const owed = account.balance < 0;

  return (
    <>
      <section className={`op-wallet${owed ? ' op-wallet--owed' : ''}`} aria-label="Ride balance">
        <div className="op-wallet__top">
          <span>मौज्दात · Ride balance</span>
          <span className="tabular">{shortKey(account.wallet)}</span>
        </div>
        <div className="op-wallet__figure tabular">{rupees(account.balance)}</div>
        <p className="op-wallet__note">
          {owed
            ? `You are ${rupees(account.owed)} short. A bus still takes you while you are less than ${rupees(account.overdraft)} short — top up to clear it.`
            : `Top-ups are paid through eSewa. A bus still takes you if a fare leaves you up to ${rupees(account.overdraft)} short, and the next top-up clears it.`}
        </p>
        <div className="op-wallet__actions">
          <button type="button" className="op-btn" onClick={() => onTab('topup')}>
            <Icon name="topup" size={19} />टप-अप
          </button>
          <button type="button" className="op-btn" onClick={() => onTab('statement')}>
            <Icon name="statement" size={19} />Statement
          </button>
        </div>
      </section>

      {/*
        The four things a passenger opens this screen to do, where a thumb
        already is. A grid of labelled discs is the pattern every wallet in
        Nepal uses, which is the reason to use it: nobody has to learn it.
      */}
      <nav className="op-quick" aria-label="Quick actions">
        <button type="button" onClick={() => onTab('topup')}>
          <i><Icon name="topup" /></i>टप-अप<span className="op-quick__en">Top up</span>
        </button>
        <button type="button" onClick={() => onTab('statement')}>
          <i><Icon name="statement" /></i>विवरण<span className="op-quick__en">Statement</span>
        </button>
        <button type="button" onClick={() => navigate('/app')}>
          <i><Icon name="qr" /></i>यात्रा<span className="op-quick__en">Ride code</span>
        </button>
        <button type="button" onClick={() => onTab('settings')}>
          <i><Icon name="settings" /></i>सेटिङ<span className="op-quick__en">Settings</span>
        </button>
      </nav>

      {requests.length ? (
        <section className="op-section">
          <div className="op-section__head">
            <h2>
              प्रक्रियामा
              <small>Top-ups in progress</small>
            </h2>
          </div>
          <div className="op-rows op-rows--plain">
            {requests.map((r) => (
              <div key={r.id}>
                <div className="op-row__name">
                  {METHOD_NAMES[r.method]} · {rupees(r.amount)}
                  <small>{when(r.created_at)} · {r.reference}</small>
                </div>
                <RequestStatus status={r.status} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="op-section">
        <div className="op-section__head">
          <h2>
            हालैको कारोबार
            <small>Recent activity</small>
          </h2>
          <button type="button" className="op-link" onClick={() => onTab('statement')}>See all</button>
        </div>
        {recent === null
          ? <div className="op-skeleton" aria-hidden="true"><span /><span /><span /></div>
          : <Entries entries={recent} empty="No rides or top-ups yet. Your first ride will show here once a bus uploads it." />}
      </section>
    </>
  );
}
