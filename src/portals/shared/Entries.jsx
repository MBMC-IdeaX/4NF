// A wallet statement, grouped by day, the way a bank app shows one.

import { day, rupees } from './format';
import Icon from './Icon';

// One icon per kind of movement, so a statement can be scanned rather than
// read. Money arriving is the only thing drawn in green.
const GLYPH = {
  topup: 'topup',
  refund: 'topup',
  adjustment: 'settings',
  ride: 'bus',
  stage_fare: 'receipt',
  opening: 'clock',
};

export default function Entries({ entries, empty = 'Nothing here yet.' }) {
  if (!entries?.length) {
    return (
      <div className="op-empty">
        <i><Icon name="statement" size={24} /></i>
        <b>Nothing here yet</b>
        <p>{empty}</p>
      </div>
    );
  }

  const groups = [];
  for (const entry of entries) {
    const label = day(entry.at);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(entry);
    else groups.push({ label, items: [entry] });
  }

  return (
    <div className="op-ledger">
      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="op-ledger__day">{group.label}</h3>
          <ul>
            {group.items.map((entry, i) => (
              <li key={`${entry.at}-${entry.kind}-${i}`} className={`op-entry op-entry--${entry.amount >= 0 ? 'in' : 'out'}`}>
                <span className="op-entry__glyph" aria-hidden="true">
                  <Icon name={GLYPH[entry.kind] ?? 'receipt'} size={20} />
                </span>
                <span className="op-entry__what">
                  <b>{entry.title}</b>
                  <small>
                    {entry.at ? new Date(entry.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kathmandu' }) : ''}
                    {entry.detail ? `${entry.at ? ' · ' : ''}${entry.detail}` : ''}
                  </small>
                </span>
                <span className="op-entry__amount tabular">
                  {rupees(entry.amount, { sign: true })}
                  <small>Balance {rupees(entry.balance_after)}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export const STATUS_TEXT = {
  initiated: 'Waiting for payment',
  pending: 'Being checked',
  loaded: 'Added to wallet',
  rejected: 'Not added',
  failed: 'Payment not completed',
};

export function RequestStatus({ status }) {
  return <span className={`op-pill op-pill--${status}`}>{STATUS_TEXT[status] ?? status}</span>;
}
