// Payouts (0035). Bhada holds no money: each request is an instruction the
// platform carries out with the partner that does, then marks paid with the
// partner's reference — or refuses, with the reason.

import { useState } from 'react';
import { Button, Empty, Field, Note, Segmented, SkeletonList } from '../../ui';
import { call, useLoad, rs, timeOf, say, Tag } from './data';

export default function Payouts({ refreshCounts }) {
  const [status, setStatus] = useState('requested');
  const { data, error, loading, reload } = useLoad(async () => {
    const result = await call('admin_payouts', { p_status: status });
    if (!Array.isArray(result)) throw new Error(say(result));
    return result;
  }, [status]);
  const done = () => { reload(); refreshCounts(); };
  const total = (data ?? []).reduce((sum, p) => sum + p.amount_npr, 0);

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">भुक्तानी · Payouts</p>
          <h1>{status === 'requested' ? `${data?.length ?? '…'} to pay` : status[0].toUpperCase() + status.slice(1)}</h1>
          <p>{status === 'requested' && data?.length ? `${rs(total)} in all. ` : ''}Pay through the partner, then record its reference here.</p>
        </div>
        <Segmented label="Show" value={status} onChange={setStatus}
          options={[{ value: 'requested', label: 'To pay' }, { value: 'paid', label: 'Paid' }, { value: 'rejected', label: 'Refused' }]} />
      </header>

      {error ? <Empty error title="Could not load payouts" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>
        : loading && !data ? <SkeletonList rows={4} />
          : data.length === 0 ? <Empty icon="wallet" title={status === 'requested' ? 'Nothing to pay' : 'None yet'} />
            : <div className="st-cards">{data.map((p) => <Payout key={p.id} p={p} onDone={done} />)}</div>}
    </div>
  );
}

function Payout({ p, onDone }) {
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [refusing, setRefusing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  async function decide(decision) {
    setBusy(decision);
    setProblem(null);
    const result = await call('admin_decide_payout', { p_id: p.id, p_decision: decision, p_reference: decision === 'paid' ? reference : null, p_note: decision === 'rejected' ? note : null });
    setBusy(null);
    if (!result?.ok) { setProblem(say(result)); return; }
    onDone();
  }

  const short = Number(p.available) < 0;
  return (
    <article className="st-card">
      <div className="st-card__head">
        <div>
          <p className="bx-eyebrow">{p.operator_name}{p.member_name ? ` · bus owner ${p.member_name}` : ' · the company'}</p>
          <h3 className="bx-h3">{rs(p.amount_npr)} <span className="bx-muted bx-small">+ {rs(p.fee_npr)} fee</span></h3>
        </div>
        <Tag tone={p.status === 'paid' ? 'ok' : p.status === 'requested' ? 'warn' : 'bad'}>{p.status}</Tag>
      </div>
      <dl className="ow-kv">
        <dt>To</dt><dd>{p.method === 'esewa' ? 'eSewa' : p.bank_name} · {p.account_number}</dd>
        <dt>Name</dt><dd>{p.account_name}</dd>
        <dt>Asked</dt><dd>{timeOf(p.requested_at)}</dd>
        {p.status === 'requested' ? <><dt>Left after this</dt><dd className={short ? 'ow-danger' : undefined}>{rs(p.available)}</dd></> : null}
        {p.reference ? <><dt>Reference</dt><dd>{p.reference}</dd></> : null}
        {p.note ? <><dt>Note</dt><dd>{p.note}</dd></> : null}
      </dl>
      {short ? <Note tone="bad">The balance has gone below this request since it was made (a refund or a charge). Refuse it and ask for a smaller one.</Note> : null}
      {p.status === 'requested' ? (
        refusing ? (
          <div className="st-inline">
            <Field label="Why it is refused"><input className="bx-input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
            <Button variant="secondary" className="ow-danger" busy={busy === 'rejected'} onClick={() => decide('rejected')}>Refuse</Button>
            <Button variant="ghost" onClick={() => setRefusing(false)}>Back</Button>
          </div>
        ) : (
          <div className="st-inline">
            <Field label="Partner reference" hint="From the transfer you made"><input className="bx-input" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            <Button icon="check" busy={busy === 'paid'} disabled={!reference.trim()} onClick={() => decide('paid')}>Mark paid</Button>
            <Button variant="secondary" onClick={() => setRefusing(true)}>Refuse…</Button>
          </div>
        )
      ) : null}
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </article>
  );
}
