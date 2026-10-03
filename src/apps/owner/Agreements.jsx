// The agreements with Bhada (0038): read each one in full and accept it here,
// or see that the signed paper copy is on file. The company's owner holds the
// service agreement, the payout mandate and the data notice; a bus owner holds
// their membership. Acceptance keeps the hash of the exact words accepted.

import { useState } from 'react';
import { Button, Empty, Icon, Note, SkeletonList } from '../../ui';
import { call, rows, useLoad, dateOf, say } from './data';

const KINDS = {
  service: { ne: 'सेवा सम्झौता', en: 'Service agreement', sub: 'What Bhada provides, what it charges, and the levy on member buses.' },
  payout_mandate: { ne: 'भुक्तानी अख्तियारी', en: 'Payout mandate', sub: 'Lets Bhada instruct its licensed partner to pay your fares to your account.' },
  data_consent: { ne: 'तथ्याङ्क सहमति', en: 'Data consent notice', sub: 'What is recorded about your buses and crew, who sees it, and for how long.' },
  membership: { ne: 'सदस्यता', en: 'Bus owner membership', sub: 'Your bus runs under the company’s permits; its fares are yours, less the levy.' },
};

async function load() {
  const [state, texts] = await Promise.all([call('my_onboarding'), rows('agreement_texts', { col: 'version', asc: false })]);
  if (state?.ok === false) throw new Error(say(state));
  const latest = {};
  for (const t of texts) if (!latest[t.kind]) latest[t.kind] = t;
  return { state, latest };
}

export default function Agreements({ me }) {
  const { data, error, loading, reload } = useLoad(load);
  const [open, setOpen] = useState(null);
  if (error) return <Empty error title="Could not load the agreements" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={3} />;

  const busOwner = me.role === 'bus_owner';
  const kinds = busOwner ? ['membership'] : ['service', 'payout_mandate', 'data_consent'];
  const held = (kind) => (kind === 'membership' ? data.state.membership : data.state.agreements?.[kind]);
  const waiting = kinds.filter((k) => !held(k)?.current).length;

  return (
    <div className="ow" style={{ maxWidth: 760 }}>
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">सम्झौता · Agreements</p>
          <h1>{waiting ? `${waiting} to accept` : 'All accepted'}</h1>
          <p>Read each in full. Accepting here counts the same as signing the paper copy; both are kept.</p>
        </div>
      </header>
      {me.role === 'manager' ? <Note>Only the company’s owner accepts these.</Note> : null}
      <ul className="ow-fleet">
        {kinds.map((kind) => (
          <Agreement key={kind} kind={kind} text={data.latest[kind]} held={held(kind)} canAccept={busOwner || me.role === 'owner'}
            open={open === kind} onOpen={() => setOpen(open === kind ? null : kind)} onDone={reload} />
        ))}
      </ul>
    </div>
  );
}

function Agreement({ kind, text, held, canAccept, open, onOpen, onDone }) {
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const meta = KINDS[kind];

  async function accept() {
    setBusy(true);
    setProblem(null);
    const result = await call('accept_agreement', { p_kind: kind, p_version: text.version });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    onDone();
  }

  const status = held?.current ? { label: held.method === 'paper' ? 'Signed on paper' : 'Accepted', tone: 'ok' }
    : held ? { label: 'New version to accept', tone: 'warn' }
      : { label: 'Not yet', tone: 'bad' };

  return (
    <li>
      <button type="button" className="ow-bus" onClick={onOpen} disabled={!text}>
        <span className="bx-item__icon"><Icon name="statement" /></span>
        <span>
          <span className="ow-bus__name">{meta.en} <span className="bx-muted">· {meta.ne}</span></span>
          <span className="ow-bus__sub">
            <span>{meta.sub}</span>
            {held ? <span>v{held.version} · {dateOf(held.at)}</span> : null}
          </span>
        </span>
        <span className="ow-bus__end">
          {text ? <span className={`ow-tag ow-tag--${status.tone}`}>{status.label}</span> : <span className="ow-tag">Not published yet</span>}
        </span>
      </button>
      {open && text ? (
        <div className="bx-stack" style={{ padding: '0 0 var(--b-5)' }}>
          <p className="bx-eyebrow">{text.title} · version {text.version} · {dateOf(text.published_at)}</p>
          <pre className="ow-agreement" onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setRead(true);
          }} ref={(el) => { if (el && el.scrollHeight <= el.clientHeight + 8 && !read) setRead(true); }}>{text.body}</pre>
          {held?.current ? null : canAccept ? (
            <>
              {problem ? <Note tone="bad">{problem}</Note> : null}
              <div className="ow-actions">
                <Button icon="check" busy={busy} disabled={!read} onClick={accept}>{kind === 'membership' ? 'I have read it and accept' : 'I have read it and accept, for the company'}</Button>
              </div>
              {!read ? <p className="bx-small bx-muted" style={{ margin: 0 }}>Read to the end to accept.</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
