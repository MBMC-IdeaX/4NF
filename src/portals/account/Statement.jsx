import { useEffect, useMemo, useState } from 'react';
import { call } from '../shared/session';
import { explain, rupees } from '../shared/format';
import Entries from '../shared/Entries';
import Stat from '../shared/Stat';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'in', label: 'Money in' },
  { id: 'out', label: 'Rides' },
];

export default function Statement() {
  const [statement, setStatement] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let live = true;
    call('my_statement', { p_limit: 500 }).then((result) => { if (live) setStatement(result); });
    return () => { live = false; };
  }, []);

  const shown = useMemo(() => {
    const entries = statement?.entries ?? [];
    if (filter === 'in') return entries.filter((e) => e.amount > 0);
    if (filter === 'out') return entries.filter((e) => e.amount < 0);
    return entries;
  }, [statement, filter]);

  const totals = useMemo(() => {
    const entries = (statement?.entries ?? []).filter((e) => e.kind !== 'opening');
    return {
      in: entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0),
      out: entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0),
      rides: entries.filter((e) => e.kind === 'ride' || e.kind === 'stage_fare').length,
    };
  }, [statement]);

  if (statement === null) return <div className="op-skeleton" aria-hidden="true"><span /><span /><span /><span /></div>;
  if (!statement.ok) return <p className="op-error">{explain(statement)}</p>;

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>विवरण</h1>
          <p>Every ride and top-up on this account, newest first, with the balance after each.</p>
        </div>
      </div>

      <dl className="op-stats">
        <Stat label="मौज्दात" sub="Balance" value={rupees(statement.balance)} accent />
        <Stat label="आएको" sub="Money in" value={rupees(totals.in)} />
        <Stat label="गएको" sub="Spent" value={rupees(totals.out)} />
        <Stat label="यात्रा" sub="Rides" value={totals.rides} />
      </dl>

      <div className="op-segment op-segment--inline" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      <Entries entries={shown} empty={filter === 'all' ? 'No rides or top-ups yet.' : 'Nothing of this kind yet.'} />
    </>
  );
}
