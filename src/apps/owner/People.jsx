// People: who works for the company and what each may do (0033), and the
// drivers, whose papers the law asks for (0036).

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button, Field, Note, Sheet, SkeletonList, Empty, Segmented, Plate } from '../../ui';
import { call, rows, useLoad, plateOf, dateOf, timeOf, say } from './data';

const ROLE = {
  owner: { label: 'Owner', sub: 'Everything, including money and people' },
  manager: { label: 'Manager', sub: 'Buses, crew, papers and reports — not money' },
  bus_owner: { label: 'Bus owner', sub: 'Owns a bus the company runs: sees only that bus and its own money, less the levy' },
  conductor: { label: 'Conductor', sub: 'The Crew app on their bus' },
};

async function loadPeople() {
  const [people, papers, fleet] = await Promise.all([call('owner_members'), call('owner_compliance'), rows('owner_fleet', { col: 'plate' })]);
  if (people?.ok === false) throw new Error(say(people));
  return { ...people, drivers: papers?.drivers ?? [], buses: fleet.filter((b) => !b.retired_at) };
}

export default function People({ isOwner, go }) {
  const { data, error, loading, reload } = useLoad(loadPeople);
  const [inviting, setInviting] = useState(false);
  const [member, setMember] = useState(null);
  const [driver, setDriver] = useState(null);

  if (error) return <Empty error title="Could not load people" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={5} />;

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">मानिस · People</p>
          <h1>{data.members.length} member{data.members.length === 1 ? '' : 's'} · {data.drivers.length} driver{data.drivers.length === 1 ? '' : 's'}</h1>
          <p>Members sign in to Bhada; drivers are kept on file with their licence and agreement.</p>
        </div>
        <div className="ow-actions">
          <Button icon="plus" onClick={() => setInviting(true)}>Invite someone</Button>
          <Button variant="secondary" icon="plus" onClick={() => setDriver({})}>Add a driver</Button>
        </div>
      </header>

      <section>
        <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>सदस्य · Members</p>
        <ul className="ow-fleet">
          {data.members.map((m) => (
            <li key={m.user_id}>
              <button type="button" className="ow-bus" onClick={() => setMember(m)} disabled={m.me}>
                <span className="bx-item__icon"><span aria-hidden="true">{(m.name ?? m.login ?? '?').slice(0, 1).toUpperCase()}</span></span>
                <span>
                  <span className="ow-bus__name">{m.name ?? m.login}{m.me ? ' (you)' : ''}</span>
                  <span className="ow-bus__sub">
                    <span className={`ow-tag ${m.role === 'owner' ? 'ow-tag--ok' : ''}`}>{ROLE[m.role].label}</span>
                    <span>{m.login}</span>
                    {m.assigned_plate ? <span>on {m.assigned_plate}</span> : null}
                    {m.role === 'bus_owner' && m.buses?.length ? <span>owns {m.buses.join(', ')}</span> : null}
                  </span>
                </span>
                <span className="ow-bus__end"><small>joined {dateOf(m.joined_at)}</small></span>
              </button>
            </li>
          ))}
        </ul>
        {data.invites.length ? (
          <div style={{ marginTop: 'var(--b-4)' }}>
            <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>Invites not yet used</p>
            <ul className="ow-fleet">
              {data.invites.map((i) => (
                <li key={i.id} className="ow-bus" style={{ cursor: 'default' }}>
                  <span className="ow-tag ow-tag--warn">{ROLE[i.role].label}</span>
                  <span>
                    <span className="ow-bus__name">{i.label ?? 'Invite'}{i.assigned_plate ? ` · ${i.assigned_plate}` : ''}</span>
                    <span className="ow-bus__sub">Expires {timeOf(i.expires_at)}</span>
                  </span>
                  <Button variant="ghost" className="ow-danger" onClick={async () => { await call('owner_revoke_invite', { p_id: i.id }); reload(); }}>Withdraw</Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section>
        <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>चालक · Drivers</p>
        {data.drivers.length === 0 ? (
          <Empty icon="user" title="No drivers on file" action={<Button onClick={() => setDriver({})}>Add a driver</Button>}>
            Each driver needs a driving licence and an agreement with the bus they drive. Add them here, then upload both papers.
          </Empty>
        ) : (
          <ul className="ow-fleet">
            {data.drivers.map((d) => (
              <li key={d.id}>
                {/* A row with its own button inside, so the row is not a <button>. */}
                <div className="ow-bus" role="button" tabIndex={0} onClick={() => setDriver(d)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDriver(d); } }}>
                  {d.vehicle_plate ? <Plate plate={plateOf(d.vehicle_plate)} size={13} /> : <span className="ow-tag">No bus</span>}
                  <span>
                    <span className="ow-bus__name">{d.name}</span>
                    <span className="ow-bus__sub">
                      <span>Licence {d.license_no}</span>
                      {d.phone ? <span>{d.phone}</span> : null}
                      {d.verified ? <span className="ow-tag ow-tag--ok">Papers verified</span> : <span className="ow-tag ow-tag--warn">Papers</span>}
                    </span>
                  </span>
                  <span className="ow-bus__end">
                    <Button variant="secondary" onClick={(e) => { e.stopPropagation(); go(`papers/driver-${d.id}`); }}>Papers</Button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <InviteSheet open={inviting} isOwner={isOwner} buses={data.buses} onClose={() => { setInviting(false); reload(); }} />
      {member ? <MemberSheet key={member.user_id} member={member} isOwner={isOwner} buses={data.buses} onClose={() => setMember(null)} onSaved={() => { setMember(null); reload(); }} /> : null}
      {driver ? <DriverSheet key={driver.id ?? 'new'} driver={driver} buses={data.buses} onClose={() => setDriver(null)} onSaved={() => { setDriver(null); reload(); }} /> : null}
    </div>
  );
}

function InviteSheet({ open, isOwner, buses, onClose }) {
  const [role, setRole] = useState('conductor');
  const [plate, setPlate] = useState('');
  const [label, setLabel] = useState('');
  const [made, setMade] = useState(null);
  const [src, setSrc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!made) { setSrc(null); return; }
    QRCode.toDataURL(JSON.stringify({ v: 'BHJOIN1', code: made.code }), { margin: 1, width: 440 }).then(setSrc);
  }, [made]);

  const close = () => { setMade(null); setError(null); setLabel(''); onClose(); };

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await call('owner_invite', { p_role: role, p_plate: plate || null, p_label: label || null });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    setMade(result);
  }

  return (
    <Sheet open={open} onClose={close} label="Invite">
      {made ? (
        <div className="bx-stack">
          <h2 className="bx-h2">Give them this code</h2>
          <div className="ow-qr">
            {src ? <img src={src} alt="Invite code" /> : null}
            <span className="ow-code">{made.code.replace(/(.{5})/g, '$1 ').trim()}</span>
            <span className="bx-small bx-muted">
              {made.role === 'conductor' ? 'They sign in to Bhada Crew and scan or type it.' : 'They sign in to Bhada Owner and choose “I have a code”.'} Works once, for 7 days.
            </span>
          </div>
          <Button block onClick={close}>Done</Button>
        </div>
      ) : (
        <form className="bx-stack" onSubmit={create}>
          <h2 className="bx-h2">Invite someone</h2>
          <Segmented label="Role" value={role} onChange={setRole}
            options={[{ value: 'conductor', label: 'Conductor' }, ...(isOwner ? [{ value: 'manager', label: 'Manager' }, { value: 'bus_owner', label: 'Bus owner' }] : [])]} />
          <p className="bx-small bx-muted" style={{ margin: 0 }}>{ROLE[role].sub}.</p>
          {role === 'conductor' || role === 'bus_owner' ? (
            <Field label={role === 'bus_owner' ? 'बस · Their bus' : 'बस · Bus (optional)'}
              hint={role === 'bus_owner' ? 'From the day they join, this bus’s fares are theirs, less the company’s levy.' : undefined}>
              <select className="bx-input" value={plate} onChange={(e) => setPlate(e.target.value)} required={role === 'bus_owner'}>
                <option value="">{role === 'bus_owner' ? 'Choose the bus' : 'Not yet'}</option>
                {buses.map((b) => <option key={b.plate} value={b.plate}>{b.plate}{b.label ? ` · ${b.label}` : ''}</option>)}
              </select>
            </Field>
          ) : null}
          <Field label="नाम · Who is it for (optional)" hint="Only you see this."><input className="bx-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /></Field>
          {error ? <Note tone="bad">{error}</Note> : null}
          <Button type="submit" block busy={busy} disabled={role === 'bus_owner' && !plate}>Make an invite code</Button>
        </form>
      )}
    </Sheet>
  );
}

function MemberSheet({ member, isOwner, buses, onClose, onSaved }) {
  const [role, setRole] = useState(member.role);
  const [plate, setPlate] = useState(member.assigned_plate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(remove = false) {
    setBusy(true);
    setError(null);
    const result = await call('owner_set_member', {
      p_user_id: member.user_id,
      p_role: isOwner && role !== member.role ? role : null,
      p_plate: role === 'conductor' ? plate : '',
      p_remove: remove,
    });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    onSaved();
  }

  return (
    <Sheet open onClose={onClose} label="Member">
      <div className="bx-stack">
        <h2 className="bx-h2">{member.name ?? member.login}</h2>
        <p className="bx-muted" style={{ margin: 0 }}>{member.login}</p>
        {member.role === 'bus_owner' ? (
          <p className="bx-small" style={{ margin: 0 }}>
            Owns {member.buses?.length ? member.buses.join(', ') : 'no bus now'}. Removing them makes their buses the company’s from today; what the buses earned before stays theirs.
          </p>
        ) : isOwner ? (
          <Segmented label="Role" value={role} onChange={setRole}
            options={['owner', 'manager', 'conductor'].map((r) => ({ value: r, label: ROLE[r].label }))} />
        ) : null}
        {role === 'conductor' ? (
          <Field label="बस · Bus">
            <select className="bx-input" value={plate} onChange={(e) => setPlate(e.target.value)}>
              <option value="">Not assigned</option>
              {buses.map((b) => <option key={b.plate} value={b.plate}>{b.plate}{b.label ? ` · ${b.label}` : ''}</option>)}
            </select>
          </Field>
        ) : null}
        {error ? <Note tone="bad">{error}</Note> : null}
        <div className="ow-actions">
          {member.role !== 'bus_owner' ? <Button busy={busy} onClick={() => save(false)}>Save</Button> : null}
          {isOwner ? <Button variant="ghost" className="ow-danger" onClick={() => save(true)}>Remove from company</Button> : null}
        </div>
      </div>
    </Sheet>
  );
}

function DriverSheet({ driver, buses, onClose, onSaved }) {
  const [name, setName] = useState(driver.name ?? '');
  const [license, setLicense] = useState(driver.license_no ?? '');
  const [phone, setPhone] = useState(driver.phone ?? '');
  const [plate, setPlate] = useState(driver.vehicle_plate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(retire = false) {
    setBusy(true);
    setError(null);
    const result = await call('owner_save_driver', {
      p_id: driver.id ?? null, p_name: name, p_license_no: license, p_phone: phone, p_plate: plate, p_retire: retire,
    });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    onSaved();
  }

  return (
    <Sheet open onClose={onClose} label="Driver">
      <form className="bx-stack" onSubmit={(e) => { e.preventDefault(); save(false); }}>
        <h2 className="bx-h2">{driver.id ? driver.name : 'Add a driver'}</h2>
        <Field label="नाम · Full name"><input className="bx-input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus={!driver.id} /></Field>
        <Field label="लाइसेन्स नम्बर · Licence number" hint="As printed on the smart licence, like 03-06-41234567.">
          <input className="bx-input" value={license} onChange={(e) => setLicense(e.target.value.toUpperCase())} required />
        </Field>
        <div className="ow-2">
          <Field label="फोन · Phone"><input className="bx-input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))} /></Field>
          <Field label="बस · Bus">
            <select className="bx-input" value={plate} onChange={(e) => setPlate(e.target.value)}>
              <option value="">None</option>
              {buses.map((b) => <option key={b.plate} value={b.plate}>{b.plate}</option>)}
            </select>
          </Field>
        </div>
        {error ? <Note tone="bad">{error}</Note> : null}
        <div className="ow-actions">
          <Button type="submit" busy={busy}>{driver.id ? 'Save' : 'Add driver'}</Button>
          {driver.id ? <Button variant="ghost" className="ow-danger" onClick={() => save(true)}>No longer drives for us</Button> : null}
        </div>
      </form>
    </Sheet>
  );
}
