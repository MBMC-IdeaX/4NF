// Reports: the analysis an owner already had — rides by hour and segment, crew
// bonuses, overloads, power tamper — and the DoTM return. Carried over from the
// operator dashboard unchanged; they bring Recharts, so this tab loads on its own.

import { useState } from 'react';
import { Segmented } from '../../ui';
import Overview from '../../portals/operator/Overview';
import Returns from '../../portals/operator/Returns';
import '../../portals/shared/portal.css';
import '../../portals/shared/portal-v2.css';
import '../../portals/shared/portal-app.css';

export default function Reports({ go }) {
  const [view, setView] = useState('analysis');
  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">रिपोर्ट · Reports</p>
          <h1>{view === 'analysis' ? 'How the buses run' : 'DoTM return'}</h1>
        </div>
        <Segmented label="Report" value={view} onChange={setView}
          options={[{ value: 'analysis', label: 'Analysis' }, { value: 'returns', label: 'DoTM return' }]} />
      </header>
      <div className="op-app">
        {view === 'analysis' ? <Overview onAddBus={() => go('buses/new')} /> : <Returns />}
      </div>
    </div>
  );
}
