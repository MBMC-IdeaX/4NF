// What companies ask Bhada to do (0037): add a bus, or put a bus on a route
// that is not listed. Staff enter the bus from its papers, or build the route
// from its permit — stops in running order, a new stop with where it is.

import { useState } from 'react';
import { Button, Empty, Field, Icon, Note, Plate, Segmented, Sheet, SkeletonList } from '../../ui';
import { call, rows, useLoad, must, say, timeOf, plateOf, Tag } from './data';
import { ScanLink } from './parts';
import { AddBus } from './Company';

export default function Requests({ go, refreshCounts }) {
  const [status, setStatus] = useState('pending');
  const { data, error, loading, reload } = useLoad(() => must(call('review_requests', { p_status: status })).then((r) => r.requests), [status]);
  const routes = useLoad(() => rows('routes', { col: 'id' }), []);
  const done = () => { reload(); routes.reload(); refreshCounts(); };

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">अनुरोध · Requests</p>
          <h1>{status === 'pending' ? `${data?.length ?? '…'} waiting` : status[0].toUpperCase() + status.slice(1)}</h1>
          <p>A new bus is entered from its bluebook and permit; a route is built from the permit the bus filed.</p>
        </div>
        <Segmented label="Show" value={status} onChange={setStatus}
          options={[{ value: 'pending', label: 'Waiting' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
      </header>

      {error ? <Empty error title="Could not load requests" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>
        : loading && !data ? <SkeletonList rows={4} />
          : data.length === 0 ? <Empty icon="check" title={status === 'pending' ? 'Nothing waiting' : 'None yet'} />
            : (
              <div className="st-cards">
                {data.map((r) => <Request key={r.id} req={r} routes={routes.data ?? []} go={go} onDone={done} />)}
              </div>
            )}
    </div>
  );
}

function Request({ req, routes, go, onDone }) {
  const [entering, setEntering] = useState(false);
  const [building, setBuilding] = useState(false);
  const [existing, setExisting] = useState('');
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const pending = req.status === 'pending';

  async function decide(decision, result = null) {
    setBusy(decision);
    setProblem(null);
    const answer = await call('review_request', { p_id: req.id, p_decision: decision, p_result: result, p_note: decision === 'rejected' ? note : null });
    setBusy(null);
    if (!answer?.ok) { setProblem(say(answer)); return; }
    onDone();
  }

  const details = req.details ?? {};
  return (
    <article className="st-card">
      <div className="st-card__head">
        <div>
          <p className="bx-eyebrow">{req.operator_name} · {timeOf(req.created_at)}</p>
          <h3 className="bx-h3">{req.kind === 'new_bus' ? 'Add a bus' : `Route: ${details.permit_name}`}</h3>
        </div>
        {req.vehicle_plate ? <Plate plate={plateOf(req.vehicle_plate)} size={13} /> : null}
      </div>
      {req.kind === 'new_bus' && (details.seated || details.label) ? (
        <p className="bx-small bx-muted">
          {[details.label, details.seated ? `${details.seated} seats` : null, details.standing ? `${details.standing} standing` : null, details.route_name].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      <div className="ow-actions">
        {(req.files ?? []).map((f, i) => <ScanLink key={f.path} path={f.path}>{f.label || f.name || `File ${i + 1}`}</ScanLink>)}
        {req.permit ? <ScanLink path={req.permit.file_path}>Route permit ({req.permit.status})</ScanLink> : null}
      </div>

      {!pending ? (
        <p className="bx-small"><Tag tone={req.status === 'approved' ? 'ok' : 'bad'}>{req.status}</Tag>{req.result ? ` · ${req.result}` : ''}{req.review_note ? ` · ${req.review_note}` : ''}</p>
      ) : rejecting ? (
        <div className="bx-stack">
          <Field label="Why it is refused" hint="The owner reads this.">
            <input className="bx-input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
          <div className="ow-actions">
            <Button variant="secondary" className="ow-danger" busy={busy === 'rejected'} onClick={() => decide('rejected')}>Refuse</Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
          </div>
        </div>
      ) : req.kind === 'new_bus' ? (
        <div className="ow-actions">
          <Button icon="plus" onClick={() => setEntering(true)}>Enter the bus</Button>
          <Button variant="ghost" onClick={() => go(`companies/${req.operator_id}`)}>Open company</Button>
          <Button variant="secondary" onClick={() => setRejecting(true)}>Refuse…</Button>
        </div>
      ) : (
        <div className="bx-stack">
          <div className="st-inline">
            <Field label="Already built under another name?">
              <select className="bx-input" value={existing} onChange={(e) => setExisting(e.target.value)}>
                <option value="">Choose a route</option>
                {routes.map((r) => <option key={r.id} value={r.id}>{r.name_en} · {r.name_ne}</option>)}
              </select>
            </Field>
            <Button variant="secondary" disabled={!existing} busy={busy === 'approved'} onClick={() => decide('approved', existing)}>Put the bus on it</Button>
          </div>
          <div className="ow-actions">
            <Button icon="route" onClick={() => setBuilding(true)}>Build the route</Button>
            <Button variant="secondary" onClick={() => setRejecting(true)}>Refuse…</Button>
          </div>
        </div>
      )}
      {problem ? <Note tone="bad">{problem}</Note> : null}

      {entering ? (
        <AddBus open id={req.operator_id} routes={routes}
          initial={{ plate: req.vehicle_plate ?? '', seated: details.seated ?? '', standing: String(details.standing ?? 0), label: details.label ?? '' }}
          papers={requestPapers(req.files)}
          onClose={() => setEntering(false)}
          onDone={() => { setEntering(false); decide('approved'); }} />
      ) : null}
      {building ? (
        <RouteBuilder name={details.permit_name} onClose={() => setBuilding(false)}
          onBuilt={(routeId) => { setBuilding(false); decide('approved', routeId); }} />
      ) : null}
    </article>
  );
}

/*
  Which attached file is which. The Owner app sends each with its kind; an
  older request is read in the order the form asks for them, bluebook first.
*/
function requestPapers(files = []) {
  const out = {};
  files.forEach((f, i) => {
    const type = f.kind ?? (i === 0 ? 'bluebook' : i === 1 ? 'route_permit' : null);
    if (type && !out[type]) out[type] = { path: f.path, name: f.name ?? `${type}.pdf`, mime: f.mime ?? null, size: f.size ?? null };
  });
  return out;
}

// ------------------------------------------------------------ route builder

const blankStop = () => ({ key: Math.random().toString(36).slice(2), code: '', name_en: '', name_ne: '', lat: '', lon: '' });

function RouteBuilder({ name, onClose, onBuilt }) {
  const stops = useLoad(() => rows('stops', { col: 'name_en' }), []);
  const [nameEn, setNameEn] = useState(name ?? '');
  const [nameNe, setNameNe] = useState('');
  const [list, setList] = useState([blankStop(), blankStop()]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const update = (key, patch) => setList((l) => l.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (i, by) => setList((l) => {
    const next = [...l];
    const [taken] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, taken);
    return next;
  });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const payload = list.map((s) => (s.code && s.code !== '__new'
      ? { code: s.code }
      : { name_en: s.name_en, name_ne: s.name_ne, lat: Number(s.lat), lon: Number(s.lon) }));
    const result = await call('admin_build_route', { p_name_ne: nameNe, p_name_en: nameEn, p_stops: payload });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    onBuilt(result.route_id);
  }

  return (
    <Sheet open onClose={onClose} label="Build a route">
      <form className="bx-stack" onSubmit={submit}>
        <div>
          <p className="bx-eyebrow">रुट बनाउनुहोस्</p>
          <h2 className="bx-h2">Build the route from the permit</h2>
          <p className="bx-muted bx-small">Stops in running order, first to last. Pick a known stop, or add a new one with its position (from the map, to six places).</p>
        </div>
        <div className="ow-2">
          <Field label="Name in Nepali"><input className="bx-input" value={nameNe} onChange={(e) => setNameNe(e.target.value)} required lang="ne" /></Field>
          <Field label="Name in English"><input className="bx-input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} required /></Field>
        </div>
        <ol className="st-stops">
          {list.map((s, i) => (
            <li key={s.key} className="st-stop">
              <span className="st-stop__n">{i + 1}</span>
              <div className="bx-stack bx-stack--tight">
                <select className="bx-input" value={s.code} onChange={(e) => update(s.key, { code: e.target.value })} aria-label={`Stop ${i + 1}`} required>
                  <option value="">Choose a stop</option>
                  <option value="__new">+ A new stop</option>
                  {(stops.data ?? []).map((st) => <option key={st.code} value={st.code}>{st.name_en} · {st.name_ne}</option>)}
                </select>
                {s.code === '__new' ? (
                  <div className="st-newstop">
                    <input className="bx-input" placeholder="Name in Nepali" value={s.name_ne} onChange={(e) => update(s.key, { name_ne: e.target.value })} required lang="ne" />
                    <input className="bx-input" placeholder="Name in English" value={s.name_en} onChange={(e) => update(s.key, { name_en: e.target.value })} required />
                    <input className="bx-input" placeholder="Latitude, e.g. 27.7172" inputMode="decimal" value={s.lat} onChange={(e) => update(s.key, { lat: e.target.value })} required />
                    <input className="bx-input" placeholder="Longitude, e.g. 85.3240" inputMode="decimal" value={s.lon} onChange={(e) => update(s.key, { lon: e.target.value })} required />
                  </div>
                ) : null}
              </div>
              <span className="st-stop__tools">
                <Button variant="ghost" icon="chevron" className="st-up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                <Button variant="ghost" icon="chevron" className="st-down" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                <Button variant="ghost" icon="close" aria-label="Remove stop" disabled={list.length <= 2} onClick={() => setList((l) => l.filter((x) => x.key !== s.key))} />
              </span>
            </li>
          ))}
        </ol>
        <Button variant="secondary" icon="plus" onClick={() => setList((l) => [...l, blankStop()])}>Add a stop</Button>
        {problem ? <Note tone="bad">{problem}</Note> : null}
        <div className="ow-actions">
          <Button type="submit" busy={busy} icon="route">Build and put the bus on it</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
        <p className="bx-small bx-muted"><Icon name="info" /> A route is built once and is then there for every company with a permit for it. Fares are by distance; nothing here sets a price.</p>
      </form>
    </Sheet>
  );
}
