// The paper queue. Open the file, compare it with what it claims to be, and
// approve it with its expiry date (and number) read off the paper, or reject it
// with the reason the owner will read.

import { useState } from 'react';
import { Button, Empty, Field, Note, Plate, Segmented, SkeletonList } from '../../ui';
import { call, useLoad, must, say, dateOf, timeOf, plateOf, PAPERS, Tag } from './data';
import { ScanLink } from './parts';

export default function Review({ refreshCounts }) {
  const [status, setStatus] = useState('pending');
  const { data, error, loading, reload } = useLoad(() => must(call('review_queue', { p_status: status })).then((r) => r.documents), [status]);
  const done = () => { reload(); refreshCounts(); };

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">कागजात जाँच · Papers</p>
          <h1>{status === 'pending' ? `${data?.length ?? '…'} waiting` : status === 'approved' ? 'Approved' : 'Rejected'}</h1>
          <p>Oldest first. A paper that expires is approved only with its expiry date.</p>
        </div>
        <Segmented label="Show" value={status} onChange={setStatus}
          options={[{ value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
      </header>

      {error ? <Empty error title="Could not load the queue" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>
        : loading && !data ? <SkeletonList rows={5} />
          : data.length === 0 ? <Empty icon="check" title={status === 'pending' ? 'Nothing waiting' : 'None yet'}>{status === 'pending' ? 'Every filed paper has been checked.' : null}</Empty>
            : (
              <div className="st-cards">
                {(status === 'pending' ? data : [...data].reverse().slice(0, 100)).map((doc) => <Doc key={doc.id} doc={doc} onDone={done} />)}
              </div>
            )}
    </div>
  );
}

function Doc({ doc, onDone }) {
  const paper = PAPERS[doc.doc_type] ?? { ne: doc.doc_type, en: doc.doc_type, expires: false };
  const [expires, setExpires] = useState(doc.expires_on ?? '');
  const [number, setNumber] = useState(doc.doc_number ?? '');
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  async function decide(decision) {
    setBusy(decision);
    setProblem(null);
    const result = await call('review_document', {
      p_id: doc.id, p_decision: decision,
      p_note: decision === 'rejected' ? note : null,
      p_expires_on: decision === 'approved' ? expires || null : null,
      p_doc_number: decision === 'approved' ? number || null : null,
    });
    setBusy(null);
    if (!result?.ok) { setProblem(say(result)); return; }
    onDone();
  }

  const subject = doc.vehicle_plate
    ? <Plate plate={plateOf(doc.vehicle_plate)} size={13} />
    : doc.driver_name ? <span><b>{doc.driver_name}</b> · licence {doc.driver_license_no}</span>
      : <span className="ow-tag">Company</span>;

  return (
    <article className="st-card">
      <div className="st-card__head">
        <div>
          <p className="bx-eyebrow">{doc.operator_name}</p>
          <h3 className="bx-h3">{paper.en} <span className="bx-muted">· {paper.ne}</span></h3>
        </div>
        {subject}
      </div>
      <p className="bx-small bx-muted">
        Filed {timeOf(doc.uploaded_at)}{doc.file_name ? ` · ${doc.file_name}` : ''}
        {doc.status !== 'pending' ? ` · ${doc.status} ${timeOf(doc.reviewed_at)}` : ''}
      </p>
      <ScanLink path={doc.file_path}>Open the paper</ScanLink>

      {doc.status === 'pending' ? (
        rejecting ? (
          <div className="bx-stack">
            <Field label="Why it is rejected" hint="The owner reads this. Say what to fix.">
              <input className="bx-input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="Photo is blurred; the expiry date cannot be read" />
            </Field>
            <div className="ow-actions">
              <Button variant="secondary" className="ow-danger" busy={busy === 'rejected'} onClick={() => decide('rejected')}>Reject</Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
            </div>
          </div>
        ) : (
          <div className="bx-stack">
            <div className="ow-2">
              <Field label="Number on the paper" hint="Optional"><input className="bx-input" value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
              {paper.expires ? (
                <Field label="Valid until" hint="Read off the paper"><input className="bx-input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
              ) : null}
            </div>
            <div className="ow-actions">
              <Button icon="check" busy={busy === 'approved'} onClick={() => decide('approved')}>Approve</Button>
              <Button variant="secondary" onClick={() => setRejecting(true)}>Reject…</Button>
            </div>
          </div>
        )
      ) : (
        <p className="bx-small">
          <Tag tone={doc.status === 'approved' ? 'ok' : 'bad'}>{doc.status}</Tag>
          {doc.expires_on ? ` valid until ${dateOf(doc.expires_on)}` : ''}{doc.review_note ? ` · ${doc.review_note}` : ''}
        </p>
      )}
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </article>
  );
}
