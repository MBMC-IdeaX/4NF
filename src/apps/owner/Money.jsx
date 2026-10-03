// Money, for whoever is paid: the company's owner, or a bus owner for their
// own buses (0035). What can be withdrawn, a payout to eSewa or a bank
// account, and the statement day by day. The company's levy on a member's bus
// shows on both sides: received by the company, paid by the bus owner.
//
// Bhada does not hold this money. A licensed partner does; Bhada keeps the
// ledger and instructs the payout, and marks it paid with the partner's
// reference. The screen says so where it matters, once.

import { useState } from 'react';
import { Button, Field, Icon, Note, Segmented, Sheet, SkeletonList, Empty, Stats, Stat } from '../../ui';
import { call, useLoad, rs, dateOf, timeOf, say } from './data';

const PAYOUT = {
  requested: { label: 'Waiting', tone: 'warn' },
  paid: { label: 'Paid', tone: 'ok' },
  rejected: { label: 'Refused', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: '' },
};
const CHARGE = { app_fee: 'App fee', payout_fee: 'Payout fee', adjustment: 'Adjustment' };

export default function Money({ go, view }) {
  const [tab, setTab] = useState(view === 'statement' ? 'statement' : 'balance');
  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">पैसा · Money</p>
          <h1>{tab === 'statement' ? 'Statement' : 'Balance'}</h1>
        </div>
        <Segmented label="View" value={tab} onChange={(v) => { setTab(v); go(v === 'statement' ? 'money/statement' : 'money'); }}
          options={[{ value: 'balance', label: 'Balance' }, { value: 'statement', label: 'Statement' }]} />
      </header>
      {tab === 'statement' ? <Statement /> : <Balance />}
    </div>
  );
}

function Balance() {
  const { data, error, loading, reload } = useLoad(async () => {
    const result = await call('owner_money');
    if (result?.ok === false) throw new Error(say(result));
    return result;
  });
  const [withdrawing, setWithdrawing] = useState(false);

  if (error) return <Empty error title="Could not load money" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={5} />;
  const p = data.payable;
  const open = data.payouts.find((x) => x.status === 'requested');

  return (
    <>
      <div className="ow-grid-2">
        <section className="bx-stack">
          <div>
            <p className="bx-eyebrow">झिक्न मिल्ने · You can withdraw</p>
            <p className={`ow-figure${p.available < 0 ? ' ow-figure--neg' : ''}`}><small>रु</small>{p.available < 0 ? '−' : ''}{Math.abs(p.available).toLocaleString('en-IN')}</p>
          </div>
          {data.party === 'bus_owner' ? (
            <p className="bx-small bx-muted" style={{ margin: 0 }}>Your buses’ fares, less the company’s levy of {rs(data.levy_per_day)} for each day a bus runs.</p>
          ) : null}
          {!data.live ? (
            <Note tone="warn">Payouts open once Bhada has your company live — agreements signed and company papers checked. Fares keep adding up meanwhile.</Note>
          ) : open ? (
            <Note tone="warn">
              <b>{rs(open.amount_npr)}</b> to {open.method === 'esewa' ? 'eSewa' : open.bank_name} {open.account_number} is waiting, asked {timeOf(open.requested_at)}.
              {' '}<button type="button" className="bx-auth__link" style={{ minHeight: 0 }} onClick={async () => { await call('cancel_payout', { p_id: open.id }); reload(); }}>Cancel it</button>
            </Note>
          ) : (
            <div className="ow-actions">
              <Button size="lg" icon="download" disabled={p.available < 100} onClick={() => setWithdrawing(true)}>Withdraw</Button>
            </div>
          )}
          <p className="bx-small bx-muted" style={{ margin: 0 }}>
            Rider money is held by Bhada’s licensed payment partner, not by Bhada. A payout is made by the partner to your account, usually within one working day.
            {data.fees.payout_flat ? ` Each payout costs ${rs(data.fees.payout_flat)}.` : ''}
            {data.fees.app_monthly_per_bus ? ` The app costs ${rs(data.fees.app_monthly_per_bus)} a month for each bus that ran that month.` : ''}
          </p>
        </section>
        <section>
          <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>हिसाब · How it adds up</p>
          <table className="ow-table">
            <tbody>
              <tr><td>Metered rides</td><td className="in">+ {rs(p.metered)}</td></tr>
              <tr><td>Stage fares</td><td className="in">+ {rs(p.stage)}</td></tr>
              <tr><td>Refunds to riders</td><td className="out">− {rs(p.refunds)}</td></tr>
              <tr><td>Crew clean-trip bonuses</td><td className="out">− {rs(p.bonuses)}</td></tr>
              {p.levy > 0 ? <tr><td>Levy from bus owners</td><td className="in">+ {rs(p.levy)}</td></tr> : null}
              {p.levy < 0 ? <tr><td>Company levy</td><td className="out">− {rs(-p.levy)}</td></tr> : null}
              <tr><td>Bhada charges</td><td className="out">− {rs(p.charges)}</td></tr>
              <tr><td>Paid out to you</td><td className="out">− {rs(p.paid_out)}</td></tr>
              <tr><td>Waiting to be paid</td><td className="out">− {rs(p.held)}</td></tr>
            </tbody>
            <tfoot><tr><td>You can withdraw</td><td><b>{rs(p.available)}</b></td></tr></tfoot>
          </table>
        </section>
      </div>

      {data.members?.length ? (
        <section>
          <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>बस धनी · Bus owners’ levy</p>
          <div className="ow-table-wrap">
            <table className="ow-table">
              <thead><tr><th>Bus owner</th><th>Buses</th><th>Levy received</th></tr></thead>
              <tbody>
                {data.members.map((m) => <tr key={m.user_id}><td>{m.name ?? '—'}</td><td>{m.buses.join(', ') || '—'}</td><td><b>{rs(m.levy)}</b></td></tr>)}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section>
        <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>भुक्तानी · Payouts</p>
        {data.payouts.length === 0 ? <p className="bx-muted">No payouts yet.</p> : (
          <div className="ow-table-wrap">
            <table className="ow-table">
              <thead><tr><th>Asked</th><th>To</th><th>Status</th><th>Fee</th><th>Amount</th></tr></thead>
              <tbody>
                {data.payouts.map((x) => (
                  <tr key={x.id}>
                    <td>{timeOf(x.requested_at)}</td>
                    <td>{x.method === 'esewa' ? 'eSewa' : x.bank_name} {x.account_number}</td>
                    <td><span className={`ow-tag ow-tag--${PAYOUT[x.status].tone}`}>{PAYOUT[x.status].label}</span>{x.reference ? <span className="bx-small bx-muted"> · {x.reference}</span> : null}{x.note ? <span className="bx-small bx-muted"> · {x.note}</span> : null}</td>
                    <td>{x.fee_npr ? rs(x.fee_npr) : '—'}</td>
                    <td><b>{rs(x.amount_npr)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>शुल्क · Bhada charges</p>
        {data.charges.length === 0 ? <p className="bx-muted">No charges yet.</p> : (
          <div className="ow-table-wrap">
            <table className="ow-table">
              <thead><tr><th>Date</th><th>For</th><th>Detail</th><th>Amount</th></tr></thead>
              <tbody>
                {data.charges.map((c) => (
                  <tr key={c.id}>
                    <td>{dateOf(c.at)}</td>
                    <td>{CHARGE[c.kind]}{c.period ? ` · ${c.period}` : ''}</td>
                    <td className="bx-small">{c.kind === 'app_fee' ? `${c.detail.buses.length} bus${c.detail.buses.length === 1 ? '' : 'es'} × ${rs(c.detail.rate)}` : c.detail?.reason ?? ''}</td>
                    <td><b>{c.amount < 0 ? `+ ${rs(-c.amount)}` : rs(c.amount)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {withdrawing ? <Withdraw available={p.available} fee={data.fees.payout_flat} onClose={() => setWithdrawing(false)} onDone={() => { setWithdrawing(false); reload(); }} /> : null}
    </>
  );
}

function Withdraw({ available, fee, onClose, onDone }) {
  const [method, setMethod] = useState('esewa');
  const [amount, setAmount] = useState(String(Math.max(0, available - fee)));
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [bank, setBank] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const n = Number(amount || 0);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await call('request_payout', {
      p_amount: n, p_method: method, p_account_name: name, p_account_number: number, p_bank_name: method === 'bank' ? bank : null,
    });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    onDone();
  }

  return (
    <Sheet open onClose={onClose} label="Withdraw">
      <form className="bx-stack" onSubmit={submit}>
        <h2 className="bx-h2">Withdraw</h2>
        <Segmented label="To" value={method} onChange={setMethod} options={[{ value: 'esewa', label: 'eSewa' }, { value: 'bank', label: 'Bank account' }]} />
        <Field label="रकम · Amount" hint={`Up to ${rs(Math.max(0, available - fee))}${fee ? `, after the ${rs(fee)} fee` : ''}.`}>
          <input className="bx-input ow-code" style={{ fontSize: '1.4rem', letterSpacing: 0 }} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 7))} />
        </Field>
        <Field label="खातावालाको नाम · Account holder"><input className="bx-input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        {method === 'esewa' ? (
          <Field label="eSewa ID" hint="The mobile number of the eSewa account."><input className="bx-input" inputMode="tel" value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 10))} required /></Field>
        ) : (
          <div className="ow-2">
            <Field label="बैंक · Bank"><input className="bx-input" value={bank} onChange={(e) => setBank(e.target.value)} required /></Field>
            <Field label="खाता नम्बर · Account no."><input className="bx-input" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\dA-Za-z]/g, '').slice(0, 24))} required /></Field>
          </div>
        )}
        <table className="ow-table">
          <tbody>
            <tr><td>To your account</td><td>{rs(n)}</td></tr>
            {fee ? <tr><td>Payout fee</td><td>{rs(fee)}</td></tr> : null}
          </tbody>
          <tfoot><tr><td>Taken from your balance</td><td><b>{rs(n + fee)}</b></td></tr></tfoot>
        </table>
        {error ? <Note tone="bad">{error}</Note> : null}
        <Button type="submit" size="lg" block busy={busy} disabled={n < 100 || n + fee > available}>Ask for {rs(n)}</Button>
      </form>
    </Sheet>
  );
}

// Kathmandu's calendar date, so "today" is the owner's today.
const ktmDate = (offsetDays = 0) => new Date(Date.now() + 345 * 60_000 - offsetDays * 86400_000).toISOString().slice(0, 10);

function Statement() {
  const [range, setRange] = useState('30');
  const { data, error, loading, reload } = useLoad(async () => {
    const result = await call('owner_statement', { p_from: ktmDate(Number(range) - 1), p_to: ktmDate(0) });
    if (result?.ok === false) throw new Error(say(result));
    return result.days;
  }, [range]);

  const days = data ?? [];
  const sum = (k) => days.reduce((s, d) => s + Number(d[k] ?? 0), 0);

  function download() {
    const head = ['day', 'rides', 'metered', 'stage', 'levy', 'refunds', 'bonuses', 'charges', 'net', 'payouts'];
    const csv = [head.join(','), ...days.map((d) => head.map((k) => d[k]).join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `bhada-statement-${ktmDate(Number(range) - 1)}-to-${ktmDate(0)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <section className="bx-stack">
      <div className="ow-head">
        <Segmented label="Range" value={range} onChange={setRange}
          options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        <Button variant="secondary" icon="download" disabled={!days.length} onClick={download}>Download CSV</Button>
      </div>
      {error ? <Empty error title="Could not load the statement" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>
        : loading && !data ? <SkeletonList rows={6} />
        : days.length === 0 ? <Empty icon="statement" title="Nothing in these days">Fares appear here the day they are settled.</Empty>
        : (
          <>
            <Stats four>
              <Stat label="Rides" value={sum('rides').toLocaleString('en-IN')} />
              <Stat label="Fares" value={rs(sum('metered') + sum('stage'))} tone="in" />
              <Stat label="Taken out" value={rs(sum('refunds') + sum('bonuses') + sum('charges'))} sub="refunds, bonuses, charges" />
              <Stat label="Net" value={rs(sum('net'))} />
            </Stats>
            <div className="ow-table-wrap">
              <table className="ow-table">
                <thead><tr><th>Day</th><th>Rides</th><th>Metered</th><th>Stage</th><th>Levy</th><th>Refunds</th><th>Bonuses</th><th>Charges</th><th>Net</th><th>Paid out</th></tr></thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day}>
                      <td>{dateOf(d.day)}</td>
                      <td>{d.rides}</td>
                      <td className="in">{d.metered ? rs(d.metered) : '—'}</td>
                      <td className="in">{d.stage ? rs(d.stage) : '—'}</td>
                      <td className={d.levy < 0 ? 'out' : 'in'}>{d.levy ? `${d.levy < 0 ? '− ' : '+ '}${rs(Math.abs(d.levy))}` : '—'}</td>
                      <td className="out">{d.refunds ? `− ${rs(d.refunds)}` : '—'}</td>
                      <td className="out">{d.bonuses ? `− ${rs(d.bonuses)}` : '—'}</td>
                      <td className="out">{d.charges ? `− ${rs(d.charges)}` : '—'}</td>
                      <td><b>{rs(d.net)}</b></td>
                      <td>{d.payouts ? rs(d.payouts) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{days.length} day{days.length === 1 ? '' : 's'}</td><td>{sum('rides')}</td><td>{rs(sum('metered'))}</td><td>{rs(sum('stage'))}</td><td>{sum('levy') ? `${sum('levy') < 0 ? '− ' : '+ '}${rs(Math.abs(sum('levy')))}` : '—'}</td>
                    <td>− {rs(sum('refunds'))}</td><td>− {rs(sum('bonuses'))}</td><td>− {rs(sum('charges'))}</td><td>{rs(sum('net'))}</td><td>{rs(sum('payouts'))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      <p className="bx-small bx-muted"><Icon name="info" /> Days are Kathmandu days. Cash tickets are not here: the conductor already holds that cash.</p>
    </section>
  );
}
