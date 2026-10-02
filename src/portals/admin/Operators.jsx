import { useCallback, useEffect, useState } from 'react';
import { call } from '../shared/session';
import { explain, rupees, when } from '../shared/format';

export default function Operators() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(null);
  const [message, setMessage] = useState(null);

  const search = useCallback(async (q) => {
    const result = await call('admin_operators', { p_query: q });
    setRows(Array.isArray(result) ? result : []);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => search(query), 250);
    return () => clearTimeout(timer);
  }, [query, search]);

  async function toggle(row) {
    const result = await call('admin_set_suspended', { p_kind: 'operator', p_id: row.id, p_suspended: !row.suspended });
    setMessage(result?.ok
      ? { tone: 'ok', text: `${row.name} ${result.suspended ? 'suspended — its dashboard is closed; fares from its buses still settle' : 'reactivated'}.` }
      : { tone: 'error', text: explain(result) });
    search(query);
  }

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>कम्पनी</h1>
          <p>Bus companies registered on Bhada, the logins that run them, and what their buses have taken.</p>
        </div>
      </div>

      <label className="op-field op-search">
        <span>खोज्नुहोस् / Search</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Company, id or login email" />
      </label>

      {message ? <p className={message.tone === 'ok' ? 'op-success' : 'op-error'} role="status">{message.text}</p> : null}

      {rows === null ? (
        <div className="op-skeleton" aria-hidden="true"><span /><span /></div>
      ) : rows.length === 0 ? (
        <div className="op-empty"><b>No companies match</b></div>
      ) : (
        <div className="op-table-scroll">
          <table className="op-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Logins</th>
                <th className="num">Buses</th>
                <th className="num">Fares</th>
                <th>Registered</th>
                <th className="num">Access</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <b>{row.name}</b>
                    <small className="op-cell-sub tabular">{row.id}</small>
                  </td>
                  <td>{row.logins.length ? row.logins.join(', ') : <span className="op-muted">None</span>}</td>
                  <td className="num tabular">{row.buses}</td>
                  <td className="num tabular">{rupees(row.fares_npr)}</td>
                  <td>{when(row.created_at)}</td>
                  <td className="num">
                    {row.suspended ? <span className="op-pill op-pill--rejected">Suspended</span> : null}{' '}
                    <button type="button" className="op-btn op-btn--small op-btn--ghost" onClick={() => toggle(row)}>
                      {row.suspended ? 'Reactivate' : 'Suspend'}
                    </button>
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
