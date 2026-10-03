// Papers: the company's five, every bus's five and every driver's two, where
// each stands, and the upload. Bhada files the company's papers at the visit;
// the owner renews them here. A file goes to the company's own folder in private storage; the
// paper is then filed for a reviewer (0036).

import { useRef, useState } from 'react';
import { Button, Icon, Note, Plate, SkeletonList, Empty } from '../../ui';
import { supabase } from '../../lib/supabase';
import { call, useLoad, plateOf, dateOf, say, PAPERS, STATUS } from './data';

const BUS_PAPERS = ['bluebook', 'pollution', 'tax_clearance', 'insurance', 'route_permit'];
const DRIVER_PAPERS = ['driving_license', 'driver_agreement'];
const COMPANY_PAPERS = ['company_registration', 'pan_vat', 'company_tax_clearance', 'director_citizenship', 'dotm_registration'];
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

export default function Papers({ go, focus, isOwner }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const result = await call('owner_compliance');
    if (result?.ok === false) throw new Error(say(result));
    return result;
  });

  if (error) return <Empty error title="Could not load papers" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={6} />;

  const subjects = [
    ...(data.company ? [{ key: 'company', kind: 'company', title: 'Your company', sub: 'Filed by Bhada at the visit; renewed by the owner', papers: data.company.papers, verified: data.company.verified, types: COMPANY_PAPERS, ownerOnly: true }] : []),
    ...data.buses.map((b) => ({ key: b.plate, kind: 'bus', title: b.label || b.plate, plate: b.plate, papers: b.papers, verified: b.verified, types: BUS_PAPERS })),
    ...data.drivers.map((d) => ({ key: `driver-${d.id}`, kind: 'driver', title: d.name, sub: `Licence ${d.license_no}`, driverId: d.id, papers: d.papers, verified: d.verified, types: DRIVER_PAPERS })),
  ];
  const shown = focus ? subjects.filter((s) => s.key === focus) : subjects;
  const all = subjects.flatMap((s) => s.types.map((t) => s.papers[t]?.status ?? 'missing'));
  const count = (st) => all.filter((x) => x === st).length;

  return (
    <div className="ow">
      {focus ? <button type="button" className="ow-back" onClick={() => go('papers')}><Icon name="back" /> All papers</button> : null}
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">कागजात · Papers</p>
          <h1>{count('approved')} of {all.length} approved</h1>
          <p>
            {count('rejected') + count('expired') ? `${count('rejected') + count('expired')} to upload again · ` : ''}
            {count('pending') ? `${count('pending')} being checked · ` : ''}
            {count('missing') ? `${count('missing')} not filed yet` : 'every paper filed'}
          </p>
        </div>
        {data.drivers.length === 0 ? <Button variant="secondary" icon="plus" onClick={() => go('people')}>Add a driver</Button> : null}
      </header>
      <Note>PDF or a clear photo, up to 10 MB. A reviewer compares it with the original and records its expiry date. Fares keep settling while papers are checked.</Note>

      {shown.length === 0 ? (
        <Empty icon="bus" title="Nothing to file yet" action={<Button onClick={() => go('buses/new')}>Add a bus</Button>}>Add a bus or a driver first; their papers appear here.</Empty>
      ) : (
        <div className="ow-papers">
          {shown.map((s) => (
            <section key={s.key} className="ow-subject">
              <div className="ow-subject__head">
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--b-3)' }}>
                  {s.plate ? <Plate plate={plateOf(s.plate)} size={14} /> : <span className="ow-tag">{s.kind === 'company' ? 'Company' : 'Driver'}</span>}
                  <span><b>{s.title}</b>{s.sub ? <span className="bx-small bx-muted"> · {s.sub}</span> : null}</span>
                </span>
                {s.verified ? <span className="ow-tag ow-tag--ok">Verified</span> : null}
              </div>
              <div className="ow-paper-row">
                {s.types.map((type) => <Paper key={type} type={type} state={s.papers[type]} subject={s} canFile={!s.ownerOnly || isOwner} onFiled={reload} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Paper({ type, state, subject, canFile = true, onFiled }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const status = state?.status ?? 'missing';
  const meta = STATUS[status];
  const paper = PAPERS[type];
  const canUpload = canFile && status !== 'pending';

  async function upload(file) {
    if (!file) return;
    setProblem(null);
    if (!TYPES.includes(file.type)) { setProblem('Upload a PDF or a photo (JPG, PNG or WebP).'); return; }
    if (file.size > MAX_BYTES) { setProblem('That file is over 10 MB. Take a smaller photo or a PDF.'); return; }
    setBusy(true);
    const operator = await call('current_operator_id');
    const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    // A new name every time: storage never overwrites, so an earlier copy stays as filed.
    const path = `${operator}/${subject.plate ?? subject.driverId ?? 'company'}/${type}-${Date.now()}.${ext}`;
    const stored = await supabase.storage.from('owner-documents').upload(path, file, { contentType: file.type, upsert: false });
    if (stored.error) { setBusy(false); setProblem(stored.error.message); return; }
    const result = await call('owner_submit_document', {
      p_doc_type: type, p_plate: subject.plate ?? null, p_driver_id: subject.driverId ?? null,
      p_file_path: path, p_file_name: file.name, p_mime_type: file.type, p_size_bytes: file.size,
    });
    setBusy(false);
    if (!result?.ok) { setProblem(say(result)); return; }
    onFiled();
  }

  return (
    <div className="ow-paper">
      <span className="ow-paper__name">{paper.ne}<small>{paper.en}</small></span>
      <span className={`ow-tag ow-tag--${meta.tone}`} style={{ alignSelf: 'flex-start' }}>{meta.label}</span>
      {status === 'approved' && state.expires_on ? <span className="ow-paper__meta">Valid until {dateOf(state.expires_on)}</span> : null}
      {status === 'expired' ? <span className="ow-paper__note">Expired {dateOf(state.expires_on)}. Upload the renewed paper.</span> : null}
      {status === 'rejected' && state.note ? <span className="ow-paper__note">Reviewer: {state.note}</span> : null}
      {status === 'pending' ? <span className="ow-paper__meta">Uploaded {dateOf(state.uploaded_at)}{state.file_name ? ` · ${state.file_name}` : ''}</span> : null}
      {problem ? <span className="ow-paper__note">{problem}</span> : null}
      <input ref={input} type="file" accept={TYPES.join(',')} hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
      {canUpload ? (
        <Button variant={status === 'missing' || status === 'rejected' || status === 'expired' ? 'primary' : 'secondary'} icon="topup" busy={busy} onClick={() => input.current?.click()}>
          {status === 'missing' ? 'Upload' : status === 'approved' ? 'Upload a renewal' : 'Upload again'}
        </Button>
      ) : null}
    </div>
  );
}
