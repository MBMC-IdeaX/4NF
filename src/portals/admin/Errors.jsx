import { useCallback, useEffect, useState } from 'react';
import { call } from '../shared/session';
import { explain, when } from '../shared/format';

// What broke on phones and in browsers in the last 30 days, newest first.
// Reports come from src/lib/report.js; anyone can send one, so read them as a
// log, not as evidence.
export default function Errors() {
  const [rows, setRows] = useState(null);
  const [problem, setProblem] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    const result = await call('admin_client_errors', { p_limit: 200 });
    if (Array.isArray(result)) {
      setRows(result);
      setProblem(null);
    } else {
      setRows([]);
      setProblem(explain(result));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>त्रुटि</h1>
          <p>Crashes reported by phones, door terminals, meters and the portals in the last 30 days.</p>
        </div>
        <button type="button" className="op-btn op-btn--ghost" onClick={load}>Refresh</button>
      </div>

      {problem ? <p className="op-error" role="status">{problem}</p> : null}

      {rows === null ? (
        <div className="op-skeleton" aria-hidden="true"><span /><span /></div>
      ) : rows.length === 0 ? (
        <div className="op-empty"><b>Nothing has crashed</b></div>
      ) : (
        <div className="op-table-scroll">
          <table className="op-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Where</th>
                <th>What</th>
                <th>Build</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>
                  <td>{when(row.at)}</td>
                  <td>
                    <b>{row.surface}</b>
                    <small className="op-cell-sub">{row.path}</small>
                  </td>
                  <td>
                    {row.message}
                    {open === row.id ? (
                      <pre className="op-cell-sub" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {row.stack || 'No stack'}
                        {'\n'}
                        {row.user_agent}
                      </pre>
                    ) : null}
                  </td>
                  <td className="tabular">{row.build}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
