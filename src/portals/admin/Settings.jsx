// Where passengers send manual payments, and how to reach support.

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { call } from '../shared/session';
import { explain, METHOD_NAMES } from '../shared/format';

const FIELDS = [
  ...['esewa'].flatMap((m) => [
    { key: `${m}_id`, label: `${METHOD_NAMES[m]} merchant ID or number`, placeholder: '98XXXXXXXX' },
    { key: `${m}_qr_url`, label: `${METHOD_NAMES[m]} QR image link`, placeholder: 'https://…/qr.png' },
  ]),
  { key: 'support_phone', label: 'Support phone shown to passengers', placeholder: '01-XXXXXXX' },
];

export default function Settings() {
  const [values, setValues] = useState(null);
  const [saved, setSaved] = useState({});
  const [message, setMessage] = useState(null);

  useEffect(() => {
    supabase.from('platform_settings').select('key, value').then(({ data }) => {
      const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
      setValues(map);
      setSaved(map);
    });
  }, []);

  async function save(event) {
    event.preventDefault();
    setMessage(null);
    const changed = FIELDS.filter((f) => (values[f.key] ?? '') !== (saved[f.key] ?? ''));
    for (const f of changed) {
      const result = await call('admin_set_setting', { p_key: f.key, p_value: values[f.key] ?? '' });
      if (!result?.ok) { setMessage({ tone: 'error', text: `${f.label}: ${explain(result)}` }); return; }
    }
    setSaved(values);
    setMessage({ tone: 'ok', text: changed.length ? `Saved ${changed.length} setting(s).` : 'Nothing changed.' });
  }

  if (!values) return <div className="op-skeleton" aria-hidden="true"><span /><span /></div>;

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>सेटिङ</h1>
          <p>
            Top-ups are eSewa only. When the eSewa gateway is on, passengers pay on eSewa’s own page
            and are credited automatically; the merchant number below is the fallback when it is off,
            and those payments wait in the request queue for you to check.
          </p>
        </div>
      </div>

      <form className="op-sheet" onSubmit={save}>
        <div className="op-form op-form--grid">
          {FIELDS.map((f) => (
            <label className="op-field" key={f.key}>
              <span>{f.label}</span>
              <input value={values[f.key] ?? ''} placeholder={f.placeholder}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            </label>
          ))}
        </div>
        {message ? <p className={message.tone === 'ok' ? 'op-success' : 'op-error'} role="status">{message.text}</p> : null}
        <div className="op-actions op-actions--end">
          <button type="submit" className="op-btn">Save settings</button>
        </div>
      </form>
    </>
  );
}
