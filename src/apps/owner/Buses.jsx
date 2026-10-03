// Buses: the fleet, a page per bus, and asking Bhada for a new one.
//
// A bus is entered by Bhada's staff from its bluebook and route permit (0034,
// 0037): the owner asks, with both papers, and its route and seats are what
// the papers say. A bus page is where its phone is set up: the owner shows a
// one-time QR, the conductor's Crew app scans it, and that phone becomes this
// bus. The code carries the route and seats, so the phone enforces them.

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Button, Field, Icon, Note, Plate, Sheet, SkeletonList, Empty, Stats, Stat } from '../../ui';
import { ZONES, SERIES, composePlate, isValidPlate } from '../../portals/shared/plates';
import { call, rows, useLoad, plateOf, rs, dateOf, timeOf, say, uploadToFolder } from './data';
import { supabase } from '../../lib/supabase';

export default function Buses(ctx) {
  const { plate } = ctx;
  if (plate === 'new') return <AddBus {...ctx} />;
  if (plate) return <BusPage {...ctx} />;
  return <Fleet {...ctx} />;
}

function Fleet({ go }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [fleet, papers, requests] = await Promise.all([rows('owner_fleet', { col: 'plate' }), call('owner_compliance'), call('owner_requests')]);
    return { fleet, papers, requests: requests?.requests ?? [] };
  });
  const [showRetired, setShowRetired] = useState(false);
  if (error) return <Empty error title="Could not load your buses" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={5} />;
  const active = data.fleet.filter((b) => !b.retired_at);
  const retired = data.fleet.filter((b) => b.retired_at);
  const verified = (plate) => data.papers?.buses?.find((b) => b.plate === plate)?.verified;

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">बसहरू · Buses</p>
          <h1>{active.length} bus{active.length === 1 ? '' : 'es'}</h1>
          <p>{active.filter((b) => verified(b.plate)).length} verified · {active.filter((b) => b.unit_bound).length} with a phone set up</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button variant="secondary" icon="route" onClick={() => go('map')}>लाइभ नक्सा · Live Map</Button>
          <Button icon="plus" onClick={() => go('buses/new')}>Ask for a new bus</Button>
        </div>
      </header>
      <Requests requests={data.requests} onChange={reload} />
      {active.length === 0 ? (
        <Empty icon="bus" title="No buses yet" action={<Button onClick={() => go('buses/new')}>Ask for your first bus</Button>}>
          Bhada enters each bus from its bluebook and route permit. Send photos of both and it appears here once entered.
        </Empty>
      ) : (
        <ul className="ow-fleet">
          {active.map((bus) => <BusRow key={bus.plate} bus={bus} verified={verified(bus.plate)} go={go} />)}
        </ul>
      )}
      {retired.length ? (
        <section>
          <button type="button" className="ow-back" onClick={() => setShowRetired((v) => !v)}>
            <Icon name="chevron" /> {showRetired ? 'Hide' : 'Show'} {retired.length} retired bus{retired.length === 1 ? '' : 'es'}
          </button>
          {showRetired ? <ul className="ow-fleet">{retired.map((bus) => <BusRow key={bus.plate} bus={bus} go={go} />)}</ul> : null}
        </section>
      ) : null}
    </div>
  );
}

function BusRow({ bus, verified, go }) {
  return (
    <li>
      <button type="button" className="ow-bus" onClick={() => go(`buses/${bus.plate}`)}>
        <Plate plate={plateOf(bus.plate)} size={15} />
        <span>
          <span className="ow-bus__name">{bus.label || bus.plate}</span>
          <span className="ow-bus__sub">
            <span>{bus.route_name ?? 'No route'}</span>
            <span>{bus.seated ?? '—'} seated + {bus.standing ?? 0} standing</span>
            {bus.retired_at ? <span className="ow-tag">Retired {dateOf(bus.retired_at)}</span>
              : verified ? <span className="ow-tag ow-tag--ok">Verified</span> : <span className="ow-tag ow-tag--warn">Papers</span>}
            {!bus.retired_at ? (bus.unit_bound ? <span className="ow-tag ow-tag--ok">Phone set up</span> : <span className="ow-tag ow-tag--bad">No phone</span>) : null}
          </span>
        </span>
        <span className="ow-bus__end">
          <b>{rs(bus.collected_today)}</b>
          <small>{bus.rides_today} today</small>
        </span>
      </button>
    </li>
  );
}

// --------------------------------------------------------------- requests

const REQUEST = {
  pending: { label: 'With Bhada', tone: 'warn' },
  approved: { label: 'Done', tone: 'ok' },
  rejected: { label: 'Refused', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: '' },
};

// What the company has asked Bhada for, the open ones first.
function Requests({ requests, onChange }) {
  const recent = requests.filter((r) => r.status === 'pending' || Date.now() - new Date(r.reviewed_at ?? r.created_at) < 14 * 86400_000);
  if (!recent.length) return null;
  return (
    <section>
      <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>अनुरोध · What you asked Bhada</p>
      <ul className="ow-fleet">
        {recent.map((r) => (
          <li key={r.id} className="ow-bus" style={{ cursor: 'default' }}>
            <Plate plate={plateOf(r.vehicle_plate)} size={13} />
            <span>
              <span className="ow-bus__name">{r.kind === 'new_bus' ? 'Add this bus' : `Route: ${r.details?.permit_name ?? ''}`}</span>
              <span className="ow-bus__sub">
                <span>Asked {dateOf(r.created_at)}</span>
                {r.review_note ? <span>Bhada: {r.review_note}</span> : null}
              </span>
            </span>
            <span className="ow-bus__end">
              <span className={`ow-tag ow-tag--${REQUEST[r.status].tone}`}>{REQUEST[r.status].label}</span>
              {r.status === 'pending' ? (
                <button type="button" className="bx-auth__link" style={{ minHeight: 0, display: 'block', marginTop: 6 }}
                  onClick={async () => { await call('owner_withdraw_request', { p_id: r.id }); onChange(); }}>Withdraw</button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A paper picked for upload, shown by name until it is sent.
function PaperPick({ label, file, onFile }) {
  const input = useRef(null);
  return (
    <div className="bx-field">
      <span className="bx-field__label">{label}</span>
      <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden
        onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      <Button variant={file ? 'secondary' : 'primary'} icon={file ? 'check' : 'camera'} block onClick={() => input.current?.click()}>
        {file ? 'Change' : 'Photo or PDF'}
      </Button>
      <span className="bx-field__hint">{file ? file.name : 'A clear photo or a PDF, up to 10 MB.'}</span>
    </div>
  );
}

function AddBus({ go }) {
  const [zone, setZone] = useState('BA');
  const [lot, setLot] = useState('');
  const [series, setSeries] = useState('KHA');
  const [number, setNumber] = useState('');
  const [routeName, setRouteName] = useState('');
  const [label, setLabel] = useState('');
  const [seated, setSeated] = useState('');
  const [standing, setStanding] = useState('0');
  const [bluebook, setBluebook] = useState(null);
  const [permit, setPermit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const plate = composePlate({ zone, lot, series, number });
  const plateOk = lot !== '' && number !== '' && isValidPlate(plate);
  const digits = (setter, max) => (e) => setter(e.target.value.replace(/\D/g, '').slice(0, max));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const files = [];
    for (const [kind, file, name] of [['bluebook', bluebook, 'Bluebook'], ['route_permit', permit, 'Route permit']]) {
      const stored = await uploadToFolder('requests', `${plate}-${kind}`, file);
      if (!stored.ok) { setBusy(false); setError(say(stored)); return; }
      files.push({ kind, label: name, path: stored.path, name: stored.name, mime: stored.mime, size: stored.size });
    }
    const result = await call('owner_request', {
      p_kind: 'new_bus', p_plate: plate,
      p_details: { seated: Number(seated) || null, standing: Number(standing || 0), label: label || null, route_name: routeName || null },
      p_files: files,
    });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    go('buses');
  }

  return (
    <div className="ow" style={{ maxWidth: 640 }}>
      <button type="button" className="ow-back" onClick={() => go('buses')}><Icon name="back" /> Buses</button>
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">नयाँ बस · Ask for a new bus</p>
          <h1>Add a bus</h1>
          <p>Send its bluebook and route permit. Bhada enters the bus from them — the plate, the route and the seats the permit allows — usually within one working day.</p>
        </div>
      </header>
      <form className="bx-stack" onSubmit={submit} noValidate>
        <div>
          <span className="bx-field__label">नम्बर प्लेट · Number plate</span>
          <div className="ow-plate-fields">
            <select className="bx-input" aria-label="Zone" value={zone} onChange={(e) => setZone(e.target.value)}>
              {ZONES.map((z) => <option key={z.code} value={z.code}>{z.ne} {z.code}</option>)}
            </select>
            <input className="bx-input" aria-label="Lot" inputMode="numeric" placeholder="२" value={lot} onChange={digits(setLot, 2)} />
            <select className="bx-input" aria-label="Series" value={series} onChange={(e) => setSeries(e.target.value)}>
              {SERIES.map((x) => <option key={x.code} value={x.code}>{x.ne} {x.code}</option>)}
            </select>
            <input className="bx-input" aria-label="Number" inputMode="numeric" placeholder="४४१२" value={number} onChange={digits(setNumber, 4)} />
          </div>
          <div style={{ marginTop: 'var(--b-3)', minHeight: 54 }}>
            {plateOk ? <Plate plate={plateOf(plate)} size={20} /> : <span className="bx-field__hint">The plate appears here as you type.</span>}
          </div>
        </div>
        <div className="ow-2">
          <PaperPick label="ब्लुबुक · Bluebook" file={bluebook} onFile={setBluebook} />
          <PaperPick label="रुट इजाजत · Route permit" file={permit} onFile={setPermit} />
        </div>
        <Field label="रुट · Route, as on the permit" hint="Helps Bhada find it. Optional.">
          <input className="bx-input" value={routeName} onChange={(e) => setRouteName(e.target.value)} placeholder="e.g. Ratna Park – Koteshwor" />
        </Field>
        <div className="ow-2">
          <Field label="सिट · Seats" hint="Optional; Bhada reads it off the papers.">
            <input className="bx-input" inputMode="numeric" value={seated} onChange={digits(setSeated, 3)} />
          </Field>
          <Field label="उभिने · Standing" hint="0 if none are allowed.">
            <input className="bx-input" inputMode="numeric" value={standing} onChange={digits(setStanding, 3)} />
          </Field>
        </div>
        <Field label="नाम · Name (optional)" hint="What your staff call it, like “Mayur 3”.">
          <input className="bx-input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {error ? <Note tone="bad">{error}</Note> : null}
        <Button type="submit" size="lg" block busy={busy} disabled={!plateOk || !bluebook || !permit}>
          Send to Bhada
        </Button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ one bus

async function loadBus(plate) {
  const [fleet, papers, people, changes] = await Promise.all([
    rows('owner_fleet', { col: 'plate' }),
    call('owner_compliance'),
    call('owner_members'),
    supabase.from('vehicle_changes').select('*').eq('vehicle_plate', plate).order('at', { ascending: false }).limit(30),
  ]);
  const bus = fleet.find((b) => b.plate === plate);
  if (!bus) throw new Error('That bus is not in your company.');
  return {
    bus,
    papers: papers?.buses?.find((b) => b.plate === plate),
    drivers: (papers?.drivers ?? []).filter((d) => d.vehicle_plate === plate),
    crew: (people?.members ?? []).filter((m) => m.assigned_plate === plate),
    changes: changes.data ?? [],
  };
}

const CHANGE = {
  registered: 'Registered', route: 'Route changed', label: 'Renamed', capacity: 'Seats changed', door_counter: 'Door counter',
  retired: 'Retired', restored: 'Brought back', setup_issued: 'Phone setup code issued', unit_replaced: 'Phone replaced', unit_bound: 'Phone set up',
};

function BusPage({ plate, go }) {
  const { data, error, loading, reload } = useLoad(() => loadBus(plate), [plate]);
  const [editing, setEditing] = useState(false);
  const [setup, setSetup] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  if (error) return <Empty error title="Could not open this bus" action={<Button variant="secondary" onClick={() => go('buses')}>Back to buses</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={6} />;
  const { bus, papers, drivers, crew, changes } = data;

  async function issueSetup(replace) {
    setBusy(true);
    setProblem(null);
    const result = await call('owner_bus_setup', { p_plate: plate, p_replace: replace });
    setBusy(false);
    setConfirm(null);
    if (!result?.ok) { setProblem(say(result)); return; }
    setSetup(result);
    reload();
  }

  async function retire(retired) {
    setBusy(true);
    const result = await call('owner_retire_vehicle', { p_plate: plate, p_retire: retired });
    setBusy(false);
    setConfirm(null);
    if (!result?.ok) { setProblem(say(result)); return; }
    reload();
  }

  return (
    <div className="ow">
      <button type="button" className="ow-back" onClick={() => go('buses')}><Icon name="back" /> Buses</button>
      <header className="ow-head">
        <div style={{ display: 'flex', gap: 'var(--b-4)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Plate plate={plateOf(bus.plate)} size={26} />
          <div>
            <p className="bx-eyebrow">{bus.retired_at ? `Retired ${dateOf(bus.retired_at)}` : 'Bus'}</p>
            <h1>{bus.label || bus.plate}</h1>
            <p>{bus.route_name ?? 'No route'} · {bus.seated} seated + {bus.standing ?? 0} standing = {bus.capacity}</p>
          </div>
        </div>
        {!bus.retired_at ? (
          <div className="ow-actions">
            <Button variant="secondary" icon="route" onClick={() => setConfirm('route')}>{bus.route_id ? 'Wrong route?' : 'Ask for its route'}</Button>
            <Button variant="secondary" icon="settings" onClick={() => setEditing(true)}>Edit</Button>
          </div>
        ) : null}
      </header>

      {problem ? <Note tone="bad">{problem}</Note> : null}

      <Stats four>
        <Stat label="Collected today" value={rs(bus.collected_today)} sub={`${bus.rides_today} ride${bus.rides_today === 1 ? '' : 's'}`} />
        <Stat label="Papers" value={papers?.verified ? 'Verified' : 'Not yet'} sub={<button type="button" className="bx-auth__link" style={{ minHeight: 0 }} onClick={() => go(`papers/${bus.plate}`)}>Open papers →</button>} />
        <Stat label="Phone" value={bus.unit_bound ? 'Set up' : 'None'} sub={bus.unit_seen_at ? `last seen ${timeOf(bus.unit_seen_at)}` : bus.setup_pending ? 'setup code waiting' : '—'} />
        <Stat label="Crew" value={crew.length + drivers.length} sub={[...crew.map((c) => c.name), ...drivers.map((d) => d.name)].join(', ') || 'none assigned'} />
      </Stats>

      <div className="ow-grid-2">
        <section className="bx-stack">
          <p className="bx-eyebrow">फोन · The bus phone</p>
          {setup ? <SetupCode setup={setup} /> : bus.retired_at ? (
            <Note>A retired bus has no phone. Bring it back to set one up.</Note>
          ) : bus.unit_bound ? (
            <>
              <p className="bx-muted" style={{ margin: 0 }}>
                A phone is this bus{bus.unit_firmware ? ` (${bus.unit_firmware})` : ''}. It signs every fare and door event. If it is lost or broken, replace it: the old phone stops being the bus at once.
              </p>
              <div className="ow-actions"><Button variant="secondary" onClick={() => setConfirm('replace')}>Replace phone</Button></div>
            </>
          ) : (
            <>
              <p className="bx-muted" style={{ margin: 0 }}>
                Show a one-time code to the conductor. They open Bhada Crew on the bus phone and scan it; that phone becomes this bus. The code works once, for 48 hours.
              </p>
              <div className="ow-actions"><Button icon="qr" busy={busy} onClick={() => issueSetup(false)}>{bus.setup_pending ? 'Show a new setup code' : 'Set up a phone'}</Button></div>
            </>
          )}
        </section>

        <section className="bx-stack">
          <p className="bx-eyebrow">इतिहास · What changed</p>
          {changes.length === 0 ? <p className="bx-muted">Nothing yet.</p> : (
            <dl className="ow-kv">
              {changes.map((c) => (
                <div key={c.id} style={{ display: 'contents' }}>
                  <dt>{timeOf(c.at)}</dt>
                  <dd>{CHANGE[c.change] ?? c.change}{c.new_value && !['unit_bound', 'unit_replaced', 'registered'].includes(c.change) ? `: ${c.old_value ?? '—'} → ${c.new_value}` : ''}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>

      <div className="ow-actions" style={{ borderTop: '1px solid var(--b-line)', paddingTop: 'var(--b-4)' }}>
        {bus.retired_at
          ? <Button variant="secondary" busy={busy} onClick={() => retire(false)}>Bring this bus back</Button>
          : <Button variant="ghost" className="ow-danger" onClick={() => setConfirm('retire')}>Retire this bus</Button>}
      </div>

      <EditBus key={editing ? "open" : "shut"} open={editing} bus={bus} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />

      <Sheet open={confirm === 'replace'} onClose={() => setConfirm(null)} label="Replace phone">
        <h2 className="bx-h2">Replace this bus’s phone?</h2>
        <p className="bx-muted">The phone now set up stops being {bus.plate} immediately. Fares it collected but has not yet sent cannot be settled after this — if it still works, let it sync first.</p>
        <div className="ow-actions"><Button busy={busy} onClick={() => issueSetup(true)}>Replace and show a code</Button><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></div>
      </Sheet>
      {confirm === 'route' ? <RouteRequest bus={bus} hasPermit={['pending', 'approved'].includes(papers?.papers?.route_permit?.status)} go={go}
        onClose={() => setConfirm(null)} /> : null}
      <Sheet open={confirm === 'retire'} onClose={() => setConfirm(null)} label="Retire bus">
        <h2 className="bx-h2">Retire {bus.plate}?</h2>
        <p className="bx-muted">Its phone stops working as a bus and its crew are unassigned. Its rides, fares and papers stay on file, and you can bring it back.</p>
        <div className="ow-actions"><Button busy={busy} onClick={() => retire(true)}>Retire</Button><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></div>
      </Sheet>
    </div>
  );
}

function SetupCode({ setup }) {
  const [src, setSrc] = useState(null);
  const payload = JSON.stringify({
    v: 'BHSETUP1', plate: setup.plate, code: setup.code, routeId: setup.route_id, label: setup.label,
    seated: setup.seated, standing: setup.standing, capacity: setup.capacity, doorCounter: setup.door_counter,
  });
  useEffect(() => {
    QRCode.toDataURL(payload, { margin: 1, width: 520, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [payload]);
  return (
    <div className="ow-qr">
      <p className="bx-eyebrow">Scan with Bhada Crew · सेटअप कोड</p>
      {src ? <img src={src} alt={`Setup code for ${setup.plate}`} /> : <span className="bx-skel" style={{ width: 260, height: 260 }} />}
      <span className="ow-code">{setup.code.replace(/(.{4})/g, '$1 ').trim()}</span>
      <span className="bx-small bx-muted">Or type the plate and this code on the phone. Works once, until {timeOf(setup.expires_at)}.</span>
    </div>
  );
}

// Asking Bhada to put the bus on the route its permit names.
function RouteRequest({ bus, hasPermit, go, onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await call('owner_request', { p_kind: 'route', p_plate: bus.plate, p_details: { permit_name: name } });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    setSent(true);
  }

  return (
    <Sheet open onClose={onClose} label="Ask for a route">
      {sent ? (
        <div className="bx-stack">
          <h2 className="bx-h2">Sent to Bhada</h2>
          <p className="bx-muted">Bhada checks the route permit and puts {bus.plate} on its route — building it first if it is not on Bhada yet. You see it under Buses.</p>
          <Button block onClick={onClose}>Done</Button>
        </div>
      ) : (
        <form className="bx-stack" onSubmit={submit}>
          <h2 className="bx-h2">Which route is on its permit?</h2>
          <p className="bx-muted" style={{ margin: 0 }}>Bhada reads the route off the permit {bus.plate} has filed, and builds it if it is new.</p>
          {hasPermit ? (
            <Field label="रुट · Route, as named on the permit">
              <input className="bx-input" value={name} onChange={(e) => setName(e.target.value)} required minLength={3} autoFocus placeholder="e.g. Lagankhel – Budhanilkantha" />
            </Field>
          ) : (
            <Note tone="warn">File this bus’s route permit first. <button type="button" className="bx-auth__link" style={{ minHeight: 0 }} onClick={() => go(`papers/${bus.plate}`)}>Open its papers →</button></Note>
          )}
          {error ? <Note tone="bad">{error}</Note> : null}
          <div className="ow-actions">
            <Button type="submit" busy={busy} disabled={!hasPermit || name.trim().length < 3}>Send to Bhada</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

function EditBus({ open, bus, onClose, onSaved }) {
  const [label, setLabel] = useState(bus.label ?? '');
  const [door, setDoor] = useState(Boolean(bus.door_counter));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await call('owner_update_vehicle', { p_plate: bus.plate, p_label: label, p_door_counter: door });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    onSaved();
  }

  return (
    <Sheet open={open} onClose={onClose} label="Edit bus">
      <form className="bx-stack" onSubmit={save}>
        <h2 className="bx-h2">Edit {bus.plate}</h2>
        <Field label="नाम · Name"><input className="bx-input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /></Field>
        <dl className="ow-kv">
          <dt>Route</dt><dd>{bus.route_name ?? 'None yet'}</dd>
          <dt>Seats</dt><dd>{bus.seated} seated + {bus.standing ?? 0} standing</dd>
        </dl>
        <p className="bx-small bx-muted" style={{ margin: 0 }}>The route and seats are read off the route permit and bluebook by Bhada. If they are wrong, ask for the route or file the corrected paper.</p>
        <label className="bx-row" style={{ minHeight: 48 }}>
          <input type="checkbox" checked={door} onChange={(e) => setDoor(e.target.checked)} style={{ width: 22, height: 22 }} />
          <span>This bus has a door counter (counts people boarding)</span>
        </label>
        {error ? <Note tone="bad">{error}</Note> : null}
        <div className="ow-actions"><Button type="submit" busy={busy}>Save</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
    </Sheet>
  );
}
