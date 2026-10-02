// The top-up queue. Check the payment arrived in the merchant account, then
// load it. Loading credits once; a second click is refused by the database.

import { useCallback, useEffect, useState } from 'react';
import { call } from '../shared/session';
import { explain, rupees, when, METHOD_NAMES, shortKey } from '../shared/format';
import { RequestStatus } from '../shared/Entries';

const VIEWS = [
  { id: 'pending', label: 'Waiting' },
  { id: 'loaded', label: 'Loaded' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
];

export default function Requests({ onChange }) {
  const [view, setView] = useState('pending');
  const [rows, setRows] = useState(null);
  const [working, setWorking] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    setRows(null);
    const result = await call('admin_topup_requests', { p_status: view });
    setRows(Array.isArray(result) ? result : []);
  }, [view]);

  useEffect(() => { load(); }, [load]);

  async function loadRequest(row) {
    setWorking(row.id);
    setMessage(null);
    const result = await call('admin_load_topup', { p_id: row.id });
    setWorking(null);
    setMessage(result?.ok
      ? { tone: 'ok', text: `Loaded ${rupees(row.amount)} for ${row.email ?? shortKey(row.wallet)}. Their balance is ${rupees(result.balance)}.` }
      : { tone: 'error', text: explain(result) });
    load();
    onChange?.();
  }

  async function reject(event) {
    event.preventDefault();
    const row = rejecting;
    setWorking(row.id);
    const result = await call('admin_reject_topup', { p_id: row.id, p_reason: reason });
    setWorking(null);
    if (result?.ok) {
      setRejecting(null);
      setReason('');
      setMessage({ tone: 'ok', text: `Rejected ${row.reference}.` });
      load();
      onChange?.();
    } else {
      setMessage({ tone: 'error', text: explain(result) });
    }
  }

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>रिचार्ज अनुरोध</h1>
          <p>Check each transaction ID in the merchant account before loading it. eSewa payments made through the gateway load themselves and only appear here if something did not match.</p>
        </div>
      </div>

      <div className="op-segment op-segment--inline" role="tablist" aria-label="Requests">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}>{v.label}</button>
        ))}
      </div>

      {message ? <p className={message.tone === 'ok' ? 'op-success' : 'op-error'} role="status">{message.text}</p> : null}

      {rows === null ? (
        <div className="op-skeleton" aria-hidden="true"><span /><span /><span /></div>
      ) : rows.length === 0 ? (
        <div className="op-empty op-empty--page">
          <b>{view === 'pending' ? 'Nothing waiting' : 'Nothing here'}</b>
          <p>{view === 'pending' ? 'New manual top-up requests appear here as passengers send them.' : 'No requests in this list yet.'}</p>
        </div>
      ) : (
        <div className="op-table-scroll">
          <table className="op-table">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Passenger</th>
                <th>Method</th>
                <th>Transaction ID</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="tabular">{when(row.created_at)}</td>
                  <td>
                    {row.email ?? <span className="tabular">{shortKey(row.wallet)}</span>}
                    <small className="op-cell-sub">Balance {rupees(row.balance)}</small>
                  </td>
                  <td>{METHOD_NAMES[row.method]}</td>
                  <td className="tabular">
                    {row.reference}
                    {row.note ? <small className="op-cell-sub">{row.note}</small> : null}
                  </td>
                  <td className="num tabular"><b>{rupees(row.amount)}</b></td>
                  <td><RequestStatus status={row.status} /></td>
                  <td className="num">
                    {row.status === 'pending' ? (
                      <span className="op-row-actions">
                        <button type="button" className="op-btn op-btn--small" disabled={working === row.id} onClick={() => loadRequest(row)}>
                          {working === row.id ? 'Loading…' : `Load ${rupees(row.amount)}`}
                        </button>
                        <button type="button" className="op-btn op-btn--small op-btn--ghost" disabled={working === row.id} onClick={() => { setRejecting(row); setReason(''); }}>
                          Reject
                        </button>
                      </span>
                    ) : when(row.decided_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rejecting ? (
        <div className="op-dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title"
          onKeyDown={(e) => { if (e.key === 'Escape') setRejecting(null); }}>
          <form className="op-sheet op-dialog__body" onSubmit={reject}>
            <h2 id="reject-title">
              Reject {rejecting.reference}
              <small>{METHOD_NAMES[rejecting.method]} · {rupees(rejecting.amount)} · {rejecting.email}</small>
            </h2>
            <div className="op-form">
              <label className="op-field">
                <span>Reason, shown to the passenger</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="No payment with this ID arrived" autoFocus />
              </label>
              <div className="op-actions op-actions--end">
                <button type="button" className="op-btn op-btn--ghost" onClick={() => setRejecting(null)}>Cancel</button>
                <button type="submit" className="op-btn" disabled={!reason.trim() || working === rejecting.id}>Reject request</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
