// The frame every one of the three apps lives in: top bar with the sync pill,
// the page, and the tab bar (a rail on a wide screen). The tone decides the
// ground — Crew runs on night for battery and late shifts; glance is for the
// screens read on a moving bus.

import '../styles/tokens.css';
import { TopBar, TabBar } from './index';
import SyncPill from './SyncPill';

export default function AppFrame({ brand = 'भाडा', tone, glance, railed, tabs, tab, onTab, sync, top, wide, children }) {
  return (
    <div
      className={`bx${railed ? ' bx--railed' : ''}`}
      data-tone={tone === 'night' ? 'night' : undefined}
      data-glance={glance ? '' : undefined}
    >
      {top === false ? null : (
        <TopBar mark={brand} {...top} end={sync ? <SyncPill status={sync} /> : top?.end} />
      )}
      <main className={`bx-page${wide ? ' bx-page--wide' : ''}`}>{children}</main>
      {tabs ? <TabBar tabs={tabs} current={tab} onChange={onTab} brand={brand} /> : null}
    </div>
  );
}
