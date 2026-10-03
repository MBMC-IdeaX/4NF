// What Bhada last said about this phone being the bus (0034), read from what
// the meter's sync stored. Silent while all is well; a line on top when the
// phone is not yet confirmed, its code ran out, or another phone is the bus.

import { useEffect, useState } from 'react';
import { Button, Note } from '../../ui';
import { db } from '../../storage/db';

const SAY = {
  setup_required: { tone: 'warn', text: 'Bhada has not confirmed this phone as the bus yet. Fares are kept and sent once it is. If this keeps showing, ask the owner for a new setup code.', again: true },
  setup_expired: { tone: 'bad', text: 'The setup code ran out before this phone reached Bhada. Ask the owner for a new one and scan it.', again: true },
  key_mismatch: { tone: 'bad', text: 'Another phone is this bus. If this is the new phone, the owner chooses “Replace phone” in Bhada Owner and you scan the new code.', again: true },
  retired: { tone: 'bad', text: 'The owner has retired this bus. Fares cannot be collected on it.', again: true },
  unknown_vehicle: { tone: 'bad', text: 'Bhada does not know this plate. Check it with the owner and set up again.', again: true },
};

export function useUnitStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const database = await db();
      const saved = await database.get('meter', 'unitStatus');
      if (live) setStatus(saved ?? null);
    };
    read();
    const timer = setInterval(read, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return status;
}

export default function UnitStatus({ onSetupAgain }) {
  const status = useUnitStatus();
  if (!status || status.ok) return null;
  const say = SAY[status.reason];
  if (!say) return null;
  return (
    <div className="cs-status">
      <Note tone={say.tone}>
        {say.text}
        {say.again ? <div style={{ marginTop: 8 }}><Button variant="secondary" icon="scan" onClick={onSetupAgain}>Set up again</Button></div> : null}
      </Note>
    </div>
  );
}
