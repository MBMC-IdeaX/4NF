// Bhada's own terms, set by a platform admin: its three rates, the monthly
// bill, the agreement texts companies sign, and who may review.
//
// Rates and agreement texts are added, never edited: a charge already made and
// an agreement already signed keep the words and the rate they were made under.

import { useState } from 'react';
import { Button, Empty, Field, Note, Section, SkeletonList, Stat, Stats } from '../../ui';
import { call, rows, useLoad, must, rs, dateOf, say, AGREEMENTS } from './data';

const FEES = {
  app_monthly_per_bus: { label: 'App fee, per bus a month', sub: 'Charged to the company for each bus that ran that month' },
  topup_flat: { label: 'Top-up fee', sub: 'Added to a rider’s eSewa top-up, not credited' },
  payout_flat: { label: 'Payout fee', sub: 'Taken from each payout' },
};

export default function Platform() {
  const fees = useLoad(() => must(call('admin_fees')), []);
  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">दर · Rates and terms</p>
          <h1>Bhada’s terms</h1>
          <p>Bhada charges for the software and never takes a fare. Every change is dated and starts now or later.</p>
        </div>
      </header>
      {fees.error ? <Empty error title="Could not load rates">{fees.error}</Empty> : !fees.data ? <SkeletonList rows={3} /> : (
        <>
          <Stats four>
            {Object.entries(FEES).map(([kind, f]) => <Stat key={kind} label={f.label} value={rs(fees.data.now[kind])} />)}
            <Stat label="Earned so far" value={rs(Number(fees.data.revenue.app_fees) + Number(fees.data.revenue.payout_fees) + Number(fees.data.revenue.topup_fees))}
              sub={`App ${rs(fees.data.revenue.app_fees)} · payout ${rs(fees.data.revenue.payout_fees)} · top-up ${rs(fees.data.revenue.topup_fees)}`} />
          </Stats>
          <SetFee onDone={fees.reload} />
          <History history={fees.data.history} />
        </>
      )}
      <BillMonth />
      <Agreements />
      <Reviewers />
    </div>
  );
}

function SetFee({ onDone }) {
  const [kind, setKind] = useState('app_monthly_per_bus');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await call('admin_set_fee', {
      p_kind: kind, p_amount: Number(amount),
      p_effective_from: from ? new Date(from).toISOString() : new Date().toISOString(), p_note: note || null,
    });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    setAmount(''); setFrom(''); setNote('');
    onDone();
  }

  return (
    <Section eyebrow="नयाँ दर" title="Set a rate">
      <form className="st-inline" onSubmit={submit}>
        <Field label="Which">
          <select className="bx-input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(FEES).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="रु"><input className="bx-input" type="number" min={0} max={100000} value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="From" hint="Empty: now"><input className="bx-input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Why" hint="Optional"><input className="bx-input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Button type="submit" variant="secondary" busy={busy}>Set</Button>
      </form>
      <p className="bx-small bx-muted">{FEES[kind].sub}.</p>
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </Section>
  );
}

function History({ history }) {
  return (
    <div className="ow-table-wrap">
      <table className="ow-table">
        <thead><tr><th>Rate</th><th>Amount</th><th>From</th><th>Note</th></tr></thead>
        <tbody>
          {history.slice(0, 12).map((h) => (
            <tr key={h.id}><td>{FEES[h.kind]?.label ?? h.kind}</td><td>{rs(h.amount_npr)}</td><td>{dateOf(h.effective_from)}</td><td>{h.note ?? ''}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The month that just ended, Kathmandu time.
function lastMonth() {
  const ktm = new Date(Date.now() + 345 * 60 * 1000);
  const d = new Date(Date.UTC(ktm.getUTCFullYear(), ktm.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

function BillMonth() {
  const [month, setMonth] = useState(lastMonth());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function bill() {
    setBusy(true);
    setResult(await call('admin_bill_month', { p_month: month }));
    setBusy(false);
  }

  return (
    <Section eyebrow="मासिक बिल" title="Bill a month">
      <p className="bx-muted">Each company is billed the app fee for every bus that carried a fare that month, at the rate in force on the 1st. Billing the same month again bills nobody twice.</p>
      <div className="st-inline">
        <Field label="Month"><input className="bx-input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <Button variant="secondary" busy={busy} onClick={bill}>Bill {month}</Button>
      </div>
      {result ? (
        result.ok
          ? <Note tone="ok">{result.companies} compan{result.companies === 1 ? 'y' : 'ies'} billed, {rs(result.total)} at {rs(result.rate)} a bus.</Note>
          : <Note tone="bad">{say(result)}</Note>
      ) : null}
    </Section>
  );
}

function Agreements() {
  const texts = useLoad(() => rows('agreement_texts', { col: 'published_at', asc: false }), []);
  const [kind, setKind] = useState('service');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [open, setOpen] = useState(null);

  async function publish(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await call('admin_publish_agreement', { p_kind: kind, p_title: title, p_body: body });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    setTitle(''); setBody('');
    texts.reload();
  }

  const latest = Object.keys(AGREEMENTS).map((k) => (texts.data ?? []).filter((t) => t.kind === k).sort((a, b) => b.version - a.version)[0]);
  return (
    <Section eyebrow="सम्झौता" title="Agreement texts">
      <p className="bx-muted">A new version means every company accepts it again before it is current. Publish a new version only when the words change.</p>
      <div className="ow-table-wrap">
        <table className="ow-table">
          <thead><tr><th>Agreement</th><th>Version</th><th>Published</th><th /></tr></thead>
          <tbody>
            {Object.entries(AGREEMENTS).map(([k, a], i) => (
              <tr key={k}>
                <td>{a.en} · {a.ne}</td>
                <td>{latest[i] ? `v${latest[i].version}` : 'Not published'}</td>
                <td>{latest[i] ? dateOf(latest[i].published_at) : ''}</td>
                <td>{latest[i] ? <button type="button" className="st-link" onClick={() => setOpen(open === k ? null : k)}>{open === k ? 'Hide' : 'Read'}</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open ? <pre className="st-text">{latest[Object.keys(AGREEMENTS).indexOf(open)]?.body}</pre> : null}
      <form className="bx-stack" onSubmit={publish}>
        <div className="ow-2">
          <Field label="Agreement">
            <select className="bx-input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(AGREEMENTS).map(([k, a]) => <option key={k} value={k}>{a.en}</option>)}
            </select>
          </Field>
          <Field label="Title"><input className="bx-input" value={title} onChange={(e) => setTitle(e.target.value)} required /></Field>
        </div>
        <Field label="Full text" hint="Exactly the words that are signed. Kept with its hash; never edited.">
          <textarea className="bx-input st-textarea" value={body} onChange={(e) => setBody(e.target.value)} required minLength={50} rows={10} />
        </Field>
        {problem ? <Note tone="bad">{problem}</Note> : null}
        <div><Button type="submit" variant="secondary" busy={busy}>Publish as the next version</Button></div>
      </form>
    </Section>
  );
}

function Reviewers() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  async function set(reviewer) {
    setBusy(reviewer ? 'add' : 'remove');
    const result = await call('admin_set_reviewer', { p_email: email, p_reviewer: reviewer });
    setBusy(null);
    setMessage(result?.ok ? { tone: 'ok', text: `${email} ${reviewer ? 'is now a reviewer' : 'is no longer a reviewer'}.` }
      : { tone: 'bad', text: result?.reason === 'no_such_login' ? 'No login with that email. They sign up first.' : say(result) });
  }

  return (
    <Section eyebrow="कर्मचारी" title="Reviewers">
      <p className="bx-muted">A reviewer onboards companies, enters buses, checks papers and builds routes. Only a platform admin takes a company live, sets rates and pays out.</p>
      <div className="st-inline">
        <Field label="Their login email"><input className="bx-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Button variant="secondary" busy={busy === 'add'} disabled={!email} onClick={() => set(true)}>Make reviewer</Button>
        <Button variant="ghost" busy={busy === 'remove'} disabled={!email} onClick={() => set(false)}>Remove</Button>
      </div>
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
    </Section>
  );
}
