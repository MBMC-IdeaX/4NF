// Every wallet, searchable, with its statement and the three things an admin
// may do to it: load cash, post a correction, suspend the login.

import { useCallback, useEffect, useState } from 'react';
import { call } from '../shared/session';
import { explain, rupees, shortKey, timeAgo } from '../shared/format';
import Entries from '../shared/Entries';
import Stat from '../shared/Stat';

export default function Passengers({ onChange }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);

  const search = useCallback(async (q) => {
    const result = await call('admin_passengers', { p_query: q });
    setRows(Array.isArray(result) ? result : []);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 250);
    return () => clearTimeout(timer);
  }, [query, search]);

  if (open) {
    return <Passenger wallet={open} onBack={() => { setOpen(null); search(query); }} onChange={onChange} />;
  }

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>यात्रु</h1>
          <p>Every wallet on the platform. Search by login email or the start of a wallet key.</p>
        </div>
      </div>

      <label className="op-field op-search">
        <span>खोज्नुहोस् / Search</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="name@example.com or wallet key" />
      </label>

      {rows === null ? (
        <div className="op-skeleton" aria-hidden="true"><span /><span /><span /></div>
      ) : rows.length === 0 ? (
        <div className="op-empty"><b>No wallets match</b><p>Try part of an email address.</p></div>
      ) : (
        <div className="op-table-scroll">
          <table className="op-table op-table--click">
            <thead>
              <tr>
                <th>Login</th>
                <th>Wallet</th>
                <th className="num">Balance</th>
                <th>Last ride or top-up</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.wallet} onClick={() => setOpen(row.wallet)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpen(row.wallet); }}>
                  <td>{row.email ?? <span className="op-muted">No login</span>}</td>
                  <td className="tabular">{shortKey(row.wallet)}</td>
                  <td className={`num tabular${row.balance < 0 ? ' warn' : ''}`}>{rupees(row.balance)}</td>
                  <td>{row.last_activity ? timeAgo(row.last_activity) : '—'}</td>
                  <td>
                    {row.suspended ? <span className="op-pill op-pill--rejected">Suspended</span> : null}
                    {row.pending_requests ? <span className="op-pill op-pill--pending">{row.pending_requests} waiting</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Passenger({ wallet, onBack, onChange }) {
  const [statement, setStatement] = useState(null);
  const [profile, setProfile] = useState(null);
  const [action, setAction] = useState(null); // 'cash' | 'adjust'
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, list] = await Promise.all([
      call('admin_statement', { p_wallet: wallet }),
      call('admin_passengers', { p_query: wallet }),
    ]);
    setStatement(s);
    setProfile(Array.isArray(list) ? list.find((r) => r.wallet === wallet) : null);
  }, [wallet]);

  useEffect(() => { load(); }, [load]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const value = Number(amount);
    const result = action === 'cash'
      ? await call('admin_load_cash', { p_wallet: wallet, p_amount: value, p_note: note })
      : await call('admin_adjust_wallet', { p_wallet: wallet, p_amount: value, p_reason: note });
    setBusy(false);
    if (result?.ok) {
      setMessage({ tone: 'ok', text: `${action === 'cash' ? 'Cash loaded' : 'Correction posted'}. Balance is now ${rupees(result.balance)}.` });
      setAction(null);
      setAmount('');
      setNote('');
      load();
      onChange?.();
    } else {
      setMessage({ tone: 'error', text: explain(result) });
    }
  }

  async function toggleSuspended() {
    const result = await call('admin_set_suspended', { p_kind: 'passenger', p_id: wallet, p_suspended: !profile.suspended });
    setMessage(result?.ok
      ? { tone: 'ok', text: result.suspended ? 'Login suspended. Rides already taken still settle.' : 'Login reactivated.' }
      : { tone: 'error', text: explain(result, 'This wallet has no login to suspend.') });
    load();
  }

  const entries = statement?.entries ?? [];
  const spent = entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0);
  const added = entries.filter((e) => e.amount > 0 && e.kind !== 'opening').reduce((s, e) => s + e.amount, 0);

  return (
    <>
      <button type="button" className="op-link" onClick={onBack}>← All passengers</button>
      <div className="op-pagehead">
        <div>
          <h1>{profile?.email ?? 'Wallet without a login'}</h1>
          <p className="tabular">{wallet}</p>
        </div>
        <div className="op-actions">
          <button type="button" className="op-btn" onClick={() => { setAction('cash'); setMessage(null); }}>Load cash</button>
          <button type="button" className="op-btn op-btn--ghost" onClick={() => { setAction('adjust'); setMessage(null); }}>Correction</button>
          {profile?.user_id ? (
            <button type="button" className="op-btn op-btn--ghost" onClick={toggleSuspended}>
              {profile.suspended ? 'Reactivate' : 'Suspend'}
            </button>
          ) : null}
        </div>
      </div>

      {message ? <p className={message.tone === 'ok' ? 'op-success' : 'op-error'} role="status">{message.text}</p> : null}

      {action ? (
        <form className="op-sheet op-inline-form" onSubmit={submit}>
          <h2>
            {action === 'cash' ? 'Load cash' : 'Post a correction'}
            <small>
              {action === 'cash'
                ? 'Money received at a counter. Rs 10 to Rs 10,000.'
                : 'A new row with a reason. Use a minus sign to take money off. The overdraft floor still applies.'}
            </small>
          </h2>
          <div className="op-form op-form--row">
            <label className="op-field">
              <span>Amount (Rs)</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value.replace(action === 'cash' ? /[^\d]/g : /[^\d-]/g, '').slice(0, 6))}
                inputMode="numeric" placeholder={action === 'cash' ? '500' : '-25'} className="tabular" required />
            </label>
            <label className="op-field op-field--grow">
              <span>{action === 'cash' ? 'Note (counter, receipt number)' : 'Reason (required)'}</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} required={action === 'adjust'} minLength={action === 'adjust' ? 3 : undefined} />
            </label>
            <div className="op-actions">
              <button type="button" className="op-btn op-btn--ghost" onClick={() => setAction(null)}>Cancel</button>
              <button type="submit" className="op-btn" disabled={busy || !amount || amount === '-'}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </form>
      ) : null}

      <dl className="op-stats">
        <Stat label="मौज्दात" sub="Balance" value={rupees(statement?.balance ?? 0)} accent warn={statement?.balance < 0} />
        <Stat label="आएको" sub="Money in" value={rupees(added)} />
        <Stat label="गएको" sub="Spent" value={rupees(spent)} />
        <Stat label="स्थिति" sub="Login" value={profile?.suspended ? 'Suspended' : profile?.user_id ? 'Active' : 'None'} />
      </dl>

      <section className="op-section">
        <div className="op-section__head"><h2>विवरण<small>Statement</small></h2></div>
        {statement === null
          ? <div className="op-skeleton" aria-hidden="true"><span /><span /></div>
          : <Entries entries={entries} empty="No movements on this wallet." />}
      </section>
    </>
  );
}
