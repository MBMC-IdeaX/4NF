// The quiet answer to "did it go through?". A tap sends whatever is waiting.

import { useEffect, useState } from 'react';
import { syncLabel } from '../lib/sync-label.mjs';

export default function SyncPill({ status, lang = 'ne' }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const label = syncLabel({ ...status, nowMs: now });
  const title = `${label.en}${status.error ? ` — ${status.error}` : ''}`;
  return (
    <button
      type="button"
      className={`bx-pill bx-pill--${label.tone}`}
      onClick={status.syncNow}
      title={title}
      aria-label={`${title}. Tap to send now.`}
      aria-live="polite"
    >
      <span className="bx-pill__dot" aria-hidden="true" />
      <span>{lang === 'ne' ? label.ne : label.en}</span>
    </button>
  );
}
