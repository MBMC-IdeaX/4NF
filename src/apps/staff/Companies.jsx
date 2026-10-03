// Every company, waiting ones first, each with how far onboarding has got.
// A company is created here by Bhada staff; companies do not sign themselves up.

import { useState } from 'react';
import { Button, Empty, Field, Note, Sheet, SkeletonList } from '../../ui';
import { call, useLoad, must, say, dateOf, REQUIRED_AGREEMENTS, Tag } from './data';

export function progress(c) {
  const signed = REQUIRED_AGREEMENTS.filter((k) => c.agreements?.[k]?.current).length;
  return [
    { label: `${signed}/3 agreements`, done: signed === 3 },
    { label: c.company_papers?.verified ? 'Papers checked' : 'Papers', done: c.company_papers?.verified === true },
    { label: c.owner_joined ? 'Owner joined' : 'No owner yet', done: c.owner_joined },
    { label: `${c.buses} bus${c.buses === 1 ? '' : 'es'}`, done: c.buses > 0 },
  ];
}

export default function Companies({ go }) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const { data, error, loading, reload } = useLoad(() => must(call('admin_companies')).then((r) => r.companies));

  if (error) return <Empty error title="Could not load companies" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;

  const shown = (data ?? []).filter((c) => !filter || `${c.name} ${c.operator_id} ${c.contact_phone ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const waiting = (data ?? []).filter((c) => c.status !== 'live').length;

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">कम्पनी · Companies</p>
          <h1>{data ? `${data.length} companies` : 'Companies'}</h1>
          <p>{waiting ? `${waiting} still onboarding.` : 'All live.'} A company goes live once its three agreements are signed and its five papers checked.</p>
        </div>
        <Button icon="plus" onClick={() => setAdding(true)}>New company</Button>
      </header>

      <input className="bx-input" type="search" placeholder="Search by name, id or phone" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search companies" />

      {loading && !data ? <SkeletonList rows={5} /> : shown.length === 0 ? (
        <Empty icon="bus" title={filter ? 'No company matches' : 'No companies yet'}>{filter ? 'Try another name.' : 'Create the first one after the visit.'}</Empty>
      ) : (
        <ul className="ow-fleet">
          {shown.map((c) => (
            <li key={c.operator_id}>
              <button type="button" className="ow-bus st-company" onClick={() => go(`companies/${c.operator_id}`)}>
                <span>
                  <span className="ow-bus__name">{c.name}</span>
                  <span className="ow-bus__sub">
                    <span>{c.operator_id}</span>
                    {c.contact_name ? <span>{c.contact_name} · {c.contact_phone}</span> : null}
                    {c.live_at ? <span>Live since {dateOf(c.live_at)}</span> : null}
                  </span>
                  {c.status !== 'live' ? (
                    <span className="st-progress">
                      {progress(c).map((p) => <Tag key={p.label} tone={p.done ? 'ok' : undefined}>{p.label}</Tag>)}
                    </span>
                  ) : null}
                </span>
                <span />
                <span className="ow-bus__end">
                  <Tag tone={c.status === 'live' ? 'ok' : 'warn'}>{c.status === 'live' ? 'Live' : 'Onboarding'}</Tag>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewCompany open={adding} onClose={() => setAdding(false)} onMade={(id) => { setAdding(false); go(`companies/${id}`); }} />
    </div>
  );
}

function NewCompany({ open, onClose, onMade }) {
  const [form, setForm] = useState({ name: '', contact: '', phone: '', pan: '', address: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await call('admin_create_company', {
      p_name: form.name, p_contact_name: form.contact, p_contact_phone: form.phone, p_pan: form.pan || null, p_address: form.address || null,
    });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    setForm({ name: '', contact: '', phone: '', pan: '', address: '' });
    onMade(result.operator_id);
  }

  return (
    <Sheet open={open} onClose={onClose} label="New company">
      <form className="bx-stack" onSubmit={submit}>
        <div>
          <p className="bx-eyebrow">नयाँ कम्पनी</p>
          <h2 className="bx-h2">New company</h2>
          <p className="bx-muted bx-small">As on its registration certificate. It starts onboarding; nothing is paid out until it is live.</p>
        </div>
        <Field label="Company name"><input className="bx-input" value={form.name} onChange={set('name')} required minLength={3} autoFocus /></Field>
        <div className="ow-2">
          <Field label="Contact person"><input className="bx-input" value={form.contact} onChange={set('contact')} required /></Field>
          <Field label="Contact mobile"><input className="bx-input" value={form.phone} onChange={set('phone')} inputMode="tel" required placeholder="98XXXXXXXX" /></Field>
        </div>
        <div className="ow-2">
          <Field label="PAN" hint="Optional"><input className="bx-input" value={form.pan} onChange={set('pan')} inputMode="numeric" /></Field>
          <Field label="Address" hint="Optional"><input className="bx-input" value={form.address} onChange={set('address')} /></Field>
        </div>
        {problem ? <Note tone="bad">{problem}</Note> : null}
        <div className="ow-actions">
          <Button type="submit" busy={busy}>Create company</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  );
}
