import Stat from '../shared/Stat';
import { rupees } from '../shared/format';

export default function Overview({ overview: o, onTab }) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kathmandu' });

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>सारांश</h1>
          <p>{today} · the whole platform, from settled rows</p>
        </div>
        {o.pending_requests > 0 ? (
          <button type="button" className="op-btn" onClick={() => onTab('requests')}>
            Review {o.pending_requests} top-up {o.pending_requests === 1 ? 'request' : 'requests'}
          </button>
        ) : null}
      </div>

      <dl className="op-stats">
        <Stat label="भित्रिएको" sub="Money loaded" value={rupees(o.loaded_npr)} accent />
        <Stat label="भाडा" sub="Fares settled" value={rupees(o.fares_npr)} />
        <Stat label="वालेटमा" sub="Held in wallets" value={rupees(o.wallet_npr)} />
        <Stat label="उधारो" sub="Owed in overdraft" value={rupees(o.overdraft_npr)} warn={o.overdraft_npr > 0} />
      </dl>

      <div className="op-grid op-grid--halves">
        <section className="op-section">
          <div className="op-section__head"><h2>मानिस<small>People</small></h2></div>
          <dl className="op-facts">
            <div><dt>Wallets</dt><dd>{o.wallets}</dd></div>
            <div><dt>Linked to a login</dt><dd>{o.accounts}</dd></div>
            <div><dt>Bus companies</dt><dd>{o.operators}</dd></div>
            <div><dt>Buses</dt><dd>{o.buses} · {o.buses_reporting} reported in 24 h</dd></div>
          </dl>
        </section>
        <section className="op-section">
          <div className="op-section__head"><h2>पैसा<small>Money</small></h2></div>
          <dl className="op-facts">
            <div><dt>Waiting to load</dt><dd>{o.pending_requests} · {rupees(o.pending_npr)}</dd></div>
            <div><dt>Rides settled</dt><dd>{o.rides}</dd></div>
            <div><dt>Refunded to riders</dt><dd>{rupees(o.refunded_npr)}</dd></div>
            <div><dt>Welcome credit issued</dt><dd>{rupees(o.welcome_npr)}</dd></div>
          </dl>
        </section>
      </div>
    </>
  );
}
