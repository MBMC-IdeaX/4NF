// One company, in the order Bhada onboards it: agreements, the company's
// papers, its owner, its buses, its levy — then live.

import { useState } from 'react';
import { Button, Empty, Field, Icon, Note, Plate, Section, Sheet, SkeletonList } from '../../ui';
import {
  call, rows, useLoad, must, say, dateOf, plateOf, uploadScan, Tag,
  PAPERS, COMPANY_PAPERS, AGREEMENTS, REQUIRED_AGREEMENTS, STATUS,
} from './data';
import { FilePick, OneTimeCode, ScanLink } from './parts';

export default function Company({ id, go, me }) {
  const { data: c, error, loading, reload } = useLoad(() => must(call('admin_company', { p_operator_id: id })), [id]);
  const routes = useLoad(() => rows('routes', { col: 'id' }), []);

  if (error) return <Empty error title="Could not open the company" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !c) return <SkeletonList rows={6} />;

  const live = c.status === 'live';
  const ctx = { c, id, reload, routes: routes.data ?? [], me };

  return (
    <div className="ow">
      <button type="button" className="ow-back" onClick={() => go('')}><Icon name="back" /> All companies</button>
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">{c.operator_id}</p>
          <h1>{c.name}</h1>
          <p>
            {[c.contact_name, c.contact_phone, c.pan ? `PAN ${c.pan}` : null, c.address].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Tag tone={live ? 'ok' : 'warn'}>{live ? `Live since ${dateOf(c.live_at)}` : 'Onboarding'}</Tag>
      </header>

      {live ? null : <GoLive {...ctx} />}
      <Agreements {...ctx} />
      <CompanyPapers {...ctx} go={go} />
      <People {...ctx} />
      <Buses {...ctx} />
      <Levy {...ctx} />
    </div>
  );
}

// ---------------------------------------------------------------- go live

function GoLive({ c, id, reload, me }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const missing = [
    ...REQUIRED_AGREEMENTS.filter((k) => !c.agreements?.[k]?.current).map((k) => AGREEMENTS[k].en),
    ...(c.company_papers?.verified ? [] : ['the five company papers, approved']),
  ];

  async function goLive() {
    setBusy(true);
    setProblem(null);
    const result = await call('admin_set_company_live', { p_operator_id: id });
    setBusy(false);
    if (!result?.ok) { setProblem(result?.missing ? `Still missing: ${result.missing.join(', ')}` : say(result)); return; }
    reload();
  }

  return (
    <Note tone={missing.length ? 'warn' : 'ok'}>
      {missing.length ? (
        <>Before it goes live: {missing.join(' · ')}. Fares from its buses settle meanwhile; payouts wait.</>
      ) : (
        <>Everything is signed and checked.</>
      )}
      {me.admin ? (
        <div style={{ marginTop: 10 }}>
          <Button busy={busy} disabled={missing.length > 0} onClick={goLive}>Take it live</Button>
        </div>
      ) : <div className="bx-small">A platform admin takes it live.</div>}
      {problem ? <div className="ow-paper__note">{problem}</div> : null}
    </Note>
  );
}

// ------------------------------------------------------------- agreements

function Agreements({ c, id, reload }) {
  const [recording, setRecording] = useState(null);
  const texts = c.agreements_texts ?? {};
  const unpublished = REQUIRED_AGREEMENTS.filter((k) => !texts[k]);

  return (
    <Section eyebrow="सम्झौता" title="Agreements">
      {unpublished.length ? <Note tone="warn">Not published yet: {unpublished.map((k) => AGREEMENTS[k].en).join(', ')}. A platform admin publishes the texts under Rates.</Note> : null}
      <div className="ow-paper-row">
        {REQUIRED_AGREEMENTS.map((kind) => {
          const held = c.agreements?.[kind];
          const text = texts[kind];
          return (
            <div key={kind} className="ow-paper">
              <span className="ow-paper__name">{AGREEMENTS[kind].ne}<small>{AGREEMENTS[kind].en}{text ? ` · current v${text.version}` : ''}</small></span>
              {held ? (
                <>
                  <Tag tone={held.current ? 'ok' : 'warn'}>{held.current ? 'Signed' : `Signed v${held.version}, not current`}</Tag>
                  <span className="ow-paper__meta">{held.method === 'paper' ? 'On paper' : 'In the app'} · {held.signer} · {dateOf(held.at)}</span>
                </>
              ) : <Tag tone="bad">Not signed</Tag>}
              {text && !held?.current ? (
                <Button variant="secondary" icon="topup" onClick={() => setRecording(kind)}>Record signed paper</Button>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="bx-small bx-muted">The owner can also accept each one in Bhada Owner. Both are kept.</p>
      <RecordAgreement kind={recording} version={texts[recording]?.version} id={id} onClose={() => setRecording(null)} onDone={() => { setRecording(null); reload(); }} />
    </Section>
  );
}

function RecordAgreement({ kind, version, id, onClose, onDone }) {
  const [signer, setSigner] = useState('');
  const [phone, setPhone] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (!file) { setProblem('Attach the signed scan.'); return; }
    setBusy(true);
    setProblem(null);
    const stored = await uploadScan(id, `agreement-${kind}`, file);
    const result = stored.ok
      ? await call('admin_record_agreement', { p_operator_id: id, p_kind: kind, p_version: version, p_signer_name: signer, p_signer_phone: phone || null, p_file_path: stored.path })
      : stored;
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    setSigner(''); setPhone(''); setFile(null);
    onDone();
  }

  return (
    <Sheet open={Boolean(kind)} onClose={onClose} label="Record a signed agreement">
      {kind ? (
        <form className="bx-stack" onSubmit={submit}>
          <div>
            <p className="bx-eyebrow">{AGREEMENTS[kind].ne} · v{version}</p>
            <h2 className="bx-h2">{AGREEMENTS[kind].en}, signed on paper</h2>
            <p className="bx-muted bx-small">Check the signed copy is version {version} before you record it.</p>
          </div>
          <div className="ow-2">
            <Field label="Signed by"><input className="bx-input" value={signer} onChange={(e) => setSigner(e.target.value)} required autoFocus /></Field>
            <Field label="Their mobile" hint="Optional"><input className="bx-input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></Field>
          </div>
          <FilePick file={file} onFile={setFile}>Attach the scan</FilePick>
          {problem ? <Note tone="bad">{problem}</Note> : null}
          <div className="ow-actions">
            <Button type="submit" busy={busy}>Record</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </Sheet>
  );
}

// --------------------------------------------------------- company papers

function CompanyPapers({ c, id, reload, go }) {
  const papers = c.company_papers?.papers ?? {};
  return (
    <Section eyebrow="कम्पनीका कागजात" title="Company papers" action={<Button variant="ghost" onClick={() => go('review')}>Review queue</Button>}>
      <div className="ow-paper-row">
        {COMPANY_PAPERS.map((type) => <PaperCell key={type} type={type} state={papers[type]} id={id} onFiled={reload} />)}
      </div>
    </Section>
  );
}

export function PaperCell({ type, state, id, plate = null, onFiled }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const status = state?.status ?? 'missing';

  async function file(chosen) {
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    const stored = await uploadScan(id, plate ? `${plate}/${type}` : type, chosen);
    const result = stored.ok
      ? await call('admin_submit_document', {
        p_operator_id: id, p_doc_type: type, p_plate: plate, p_driver_id: null,
        p_file_path: stored.path, p_file_name: stored.name, p_mime_type: stored.mime, p_size_bytes: stored.size,
      })
      : stored;
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    onFiled();
  }

  return (
    <div className="ow-paper">
      <span className="ow-paper__name">{PAPERS[type].ne}<small>{PAPERS[type].en}</small></span>
      <Tag tone={STATUS[status].tone}>{STATUS[status].label}</Tag>
      {status === 'approved' && state.expires_on ? <span className="ow-paper__meta">Valid until {dateOf(state.expires_on)}</span> : null}
      {status === 'rejected' && state.note ? <span className="ow-paper__note">{state.note}</span> : null}
      {problem ? <span className="ow-paper__note">{problem}</span> : null}
      {status !== 'pending' ? (
        <FilePick busy={busy} onFile={file} variant={status === 'approved' ? 'secondary' : 'primary'}>
          {status === 'missing' ? 'File scan' : 'File a new copy'}
        </FilePick>
      ) : <span className="ow-paper__meta">Waiting in the review queue</span>}
    </div>
  );
}

// ------------------------------------------------------------------ people

function People({ c, id, reload }) {
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  async function invite() {
    setBusy(true);
    setProblem(null);
    const result = await call('admin_invite_owner', { p_operator_id: id, p_label: c.contact_name });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    setCode(result.code);
    reload();
  }

  const ROLE = { owner: 'Owner', manager: 'Manager', bus_owner: 'Bus owner', conductor: 'Conductor' };
  return (
    <Section eyebrow="मानिस" title="People"
      action={<Button variant={c.owner_joined ? 'secondary' : 'primary'} icon="plus" busy={busy} onClick={invite}>{c.owner_joined ? 'Invite another owner' : 'Invite the owner'}</Button>}>
      {code ? (
        <OneTimeCode code={code}>
          Give this to the owner: they sign in to Bhada Owner and enter it. It works once, for seven days, and is not shown again.
        </OneTimeCode>
      ) : null}
      {problem ? <Note tone="bad">{problem}</Note> : null}
      {c.members?.length ? (
        <div className="ow-table-wrap">
          <table className="ow-table">
            <thead><tr><th>Name</th><th>Login</th><th>Role</th></tr></thead>
            <tbody>
              {c.members.map((m) => (
                <tr key={m.user_id}><td>{m.name ?? '—'}</td><td>{m.login ?? '—'}</td><td>{ROLE[m.role] ?? m.role}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="bx-muted">Nobody has joined yet. The owner invites managers, bus owners and conductors themselves.</p>}
    </Section>
  );
}

// ------------------------------------------------------------------- buses

function Buses({ c, id, reload, routes }) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const busOwners = (c.members ?? []).filter((m) => m.role === 'bus_owner');
  const papersOf = (plate) => c.compliance?.buses?.find((b) => b.plate === plate);

  return (
    <Section eyebrow="बसहरू" title={`Buses (${c.fleet?.length ?? 0})`} action={<Button icon="plus" onClick={() => setAdding(true)}>Add a bus</Button>}>
      {c.fleet?.length ? (
        <ul className="ow-fleet">
          {c.fleet.map((bus) => {
            const papers = papersOf(bus.plate);
            const owner = busOwners.find((m) => m.user_id === bus.owner_member);
            return (
              <li key={bus.plate}>
                <button type="button" className="ow-bus" onClick={() => setOpen(open === bus.plate ? null : bus.plate)}>
                  <Plate plate={plateOf(bus.plate)} size={14} />
                  <span>
                    <span className="ow-bus__name">{bus.label || bus.plate}</span>
                    <span className="ow-bus__sub">
                      <span>{routes.find((r) => r.id === bus.route_id)?.name_en ?? bus.route_id ?? 'No route'}</span>
                      <span>{bus.capacity} places</span>
                      <span>{owner ? `Owned by ${owner.name}` : 'Company’s own'}</span>
                      {bus.retired_at ? <span>Retired</span> : null}
                    </span>
                  </span>
                  <span className="ow-bus__end">{papers?.verified ? <Tag tone="ok">Papers verified</Tag> : <Tag tone="warn">Papers</Tag>}</span>
                </button>
                {open === bus.plate ? <BusDetail bus={bus} papers={papers} busOwners={busOwners} routes={routes} id={id} reload={reload} /> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="bx-muted">No buses yet. Enter each from its bluebook and route permit.</p>}
      <AddBus open={adding} id={id} routes={routes} busOwners={busOwners} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />
    </Section>
  );
}

function BusDetail({ bus, papers, busOwners, routes, id, reload }) {
  const [owner, setOwner] = useState(bus.owner_member ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  async function saveOwner() {
    setBusy(true);
    setProblem(null);
    const result = await call('set_bus_owner', { p_plate: bus.plate, p_member: owner || null });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    reload();
  }

  return (
    <div className="st-detail">
      {busOwners.length ? (
        <div className="st-inline">
          <Field label="Whose bus" hint="From now on. Fares it already carried stay with whoever owned it then.">
            <select className="bx-input" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">The company’s own</option>
              {busOwners.map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.login}</option>)}
            </select>
          </Field>
          <Button variant="secondary" busy={busy} disabled={(owner || null) === (bus.owner_member ?? null)} onClick={saveOwner}>Save</Button>
        </div>
      ) : <p className="bx-small bx-muted">The owner can invite a bus owner for this bus from Bhada Owner.</p>}
      {problem ? <Note tone="bad">{problem}</Note> : null}
      <BusFacts bus={bus} routes={routes} reload={reload} />
      <div className="ow-paper-row">
        {['bluebook', 'pollution', 'tax_clearance', 'insurance', 'route_permit'].map((type) => (
          <PaperCell key={type} type={type} state={papers?.papers?.[type]} id={id} plate={bus.plate} onFiled={reload} />
        ))}
      </div>
    </div>
  );
}

// `papers` are files already in the company's folder (a new-bus request's
// bluebook and permit): filed against the bus unless a new scan is chosen.
// The facts read off the bluebook and route permit. Only staff change them.
function BusFacts({ bus, routes, reload }) {
  const [route, setRoute] = useState(bus.route_id ?? '');
  const [seated, setSeated] = useState(String(bus.seated ?? ''));
  const [standing, setStanding] = useState(String(bus.standing ?? 0));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const seatsChanged = Number(seated) !== bus.seated || Number(standing) !== (bus.standing ?? 0);
  const routeChanged = route && route !== bus.route_id;

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await call('admin_update_vehicle', {
      p_plate: bus.plate, p_route_id: routeChanged ? route : null,
      p_seated: seatsChanged ? Number(seated) : null, p_standing: seatsChanged ? Number(standing || 0) : null,
    });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    reload();
  }

  return (
    <form className="st-inline" onSubmit={save}>
      <Field label="Route on the permit">
        <select className="bx-input" value={route} onChange={(e) => setRoute(e.target.value)}>
          <option value="">No route yet</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.name_en}</option>)}
        </select>
      </Field>
      <Field label="Seats"><input className="bx-input" type="number" min={1} max={120} value={seated} onChange={(e) => setSeated(e.target.value)} /></Field>
      <Field label="Standing"><input className="bx-input" type="number" min={0} max={120} value={standing} onChange={(e) => setStanding(e.target.value)} /></Field>
      <Button type="submit" variant="secondary" busy={busy} disabled={!seatsChanged && !routeChanged}>Save from the papers</Button>
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </form>
  );
}

export function AddBus({ open, id, routes, busOwners = [], initial, papers = {}, onClose, onDone }) {
  const empty = { plate: '', route: '', seated: '', standing: '0', label: '', member: '', ...initial };
  const [form, setForm] = useState(empty);
  const [bluebook, setBluebook] = useState(null);
  const [permit, setPermit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const made = await call('admin_register_vehicle', {
      p_operator_id: id, p_plate: form.plate, p_route_id: form.route || null,
      p_seated: Number(form.seated), p_standing: Number(form.standing || 0),
      p_label: form.label || null, p_member: form.member || null,
    });
    if (!made?.ok) { setBusy(false); setProblem(say(made)); return; }
    // The papers it was entered from are filed against it for review.
    for (const [type, file] of [['bluebook', bluebook], ['route_permit', permit]]) {
      if (!file && !papers[type]) continue;
      const stored = file ? await uploadScan(id, `${made.plate}/${type}`, file) : { ok: true, ...papers[type] };
      const filed = stored.ok ? await call('admin_submit_document', {
        p_operator_id: id, p_doc_type: type, p_plate: made.plate, p_driver_id: null,
        p_file_path: stored.path, p_file_name: stored.name, p_mime_type: stored.mime, p_size_bytes: stored.size,
      }) : stored;
      if (!filed?.ok) { setBusy(false); setProblem(`The bus is entered, but the ${PAPERS[type].en.toLowerCase()} did not file: ${say(filed)}`); return; }
    }
    setBusy(false);
    setForm(empty); setBluebook(null); setPermit(null);
    onDone(made.plate);
  }

  return (
    <Sheet open={open} onClose={onClose} label="Add a bus">
      <form className="bx-stack" onSubmit={submit}>
        <div>
          <p className="bx-eyebrow">नयाँ बस</p>
          <h2 className="bx-h2">Add a bus</h2>
          <p className="bx-muted bx-small">From the bluebook and the route permit in front of you.</p>
        </div>
        <div className="ow-2">
          <Field label="Plate" hint="As painted, e.g. BA 2 KHA 4412"><input className="bx-input" value={form.plate} onChange={set('plate')} required autoFocus /></Field>
          <Field label="Name" hint="Optional, what the company calls it"><input className="bx-input" value={form.label} onChange={set('label')} maxLength={40} /></Field>
        </div>
        <Field label="Route" hint="As on the route permit. Not listed? Leave it empty; build it under Requests.">
          <select className="bx-input" value={form.route} onChange={set('route')}>
            <option value="">No route yet</option>
            {routes.map((r) => <option key={r.id} value={r.id}>{r.name_en} · {r.name_ne}</option>)}
          </select>
        </Field>
        <div className="ow-2">
          <Field label="Seats" hint="From the bluebook"><input className="bx-input" type="number" min={1} max={120} value={form.seated} onChange={set('seated')} required /></Field>
          <Field label="Standing" hint="Permitted standing"><input className="bx-input" type="number" min={0} max={120} value={form.standing} onChange={set('standing')} required /></Field>
        </div>
        {busOwners.length ? (
          <Field label="Whose bus">
            <select className="bx-input" value={form.member} onChange={set('member')}>
              <option value="">The company’s own</option>
              {busOwners.map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.login}</option>)}
            </select>
          </Field>
        ) : null}
        <div className="ow-2">
          <FilePick file={bluebook ?? (papers.bluebook ? { name: `${papers.bluebook.name} (from the request)` } : null)} onFile={setBluebook}>Bluebook scan</FilePick>
          <FilePick file={permit ?? (papers.route_permit ? { name: `${papers.route_permit.name} (from the request)` } : null)} onFile={setPermit}>Route permit scan</FilePick>
        </div>
        {problem ? <Note tone="bad">{problem}</Note> : null}
        <div className="ow-actions">
          <Button type="submit" busy={busy}>Add the bus</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  );
}

// -------------------------------------------------------------------- levy

function Levy({ c, id, reload }) {
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await call('admin_set_levy', { p_operator_id: id, p_amount: Number(amount), p_effective_from: from || null, p_note: 'From the service agreement' });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    setAmount(''); setFrom('');
    reload();
  }

  return (
    <Section eyebrow="लेभी" title="Levy on member buses">
      <p className="bx-muted">
        What a bus owner pays the company for each day their bus runs, as the service agreement sets it.
        Now <b>रु {Number(c.levy_per_day ?? 0).toLocaleString('en-IN')}</b> a day.
      </p>
      <form className="st-inline" onSubmit={submit}>
        <Field label="New levy, रु a day"><input className="bx-input" type="number" min={0} max={100000} value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="From (today or later)"><input className="bx-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Button type="submit" variant="secondary" busy={busy}>Set levy</Button>
      </form>
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </Section>
  );
}
