// /_ui — every part of the kit on one page, in light, night and glance.
// Development only: App mounts it behind import.meta.env.DEV.

import { useState } from 'react';
import '../styles/tokens.css';
import { Button, TopBar, TabBar, Stats, Stat, Money, List, Item, SkeletonList, Empty, Note, Section, Sheet, Field, Segmented } from './index';
import SyncPill from './SyncPill';
import { useSyncStatus } from '../lib/useSyncStatus';
import { pendingConductor } from '../device/outbox';
import { syncConductor } from '../device/sync';

const TABS = [
  { id: 'home', label: 'गृह', icon: 'home' },
  { id: 'ride', label: 'यात्रा', icon: 'ticket' },
  { id: 'trips', label: 'यात्राहरू', icon: 'receipt' },
  { id: 'me', label: 'म', icon: 'user', badge: 2 },
];

const noop = () => {};

export default function Kit() {
  const [tone, setTone] = useState('day');
  const [tab, setTab] = useState('home');
  const [sheet, setSheet] = useState(false);
  const [seg, setSeg] = useState('today');
  // Real outbox: the conductor ledger on this browser, sent to VITE_SYNC_URL.
  const sync = useSyncStatus({ name: 'kit', pending: pendingConductor, run: syncConductor });
  return (
    <div className="bx bx--railed" data-tone={tone === 'night' ? 'night' : undefined} data-glance={tone === 'glance' ? '' : undefined}>
      <TopBar
        mark="भाडा"
        end={<SyncPill status={sync} />}
      />
      <main className="bx-page bx-stack--loose">
        <Segmented label="Tone" value={tone} onChange={setTone} options={[{ value: 'day', label: 'Day' }, { value: 'night', label: 'Night' }, { value: 'glance', label: 'Glance' }]} />

        <Section eyebrow="Balance" title="Wallet">
          <div className="bx-surface bx-surface--pad">
            <p className="bx-eyebrow">उपलब्ध रकम · Available</p>
            <p className="bx-num" style={{ fontSize: 'var(--b-text-hero)', fontWeight: 700, lineHeight: 1, margin: '8px 0 16px' }}>रु 1,982</p>
            <div className="bx-row">
              <Button icon="topup">Top up</Button>
              <Button variant="secondary" icon="statement">Statement</Button>
            </div>
          </div>
        </Section>

        <Stats four>
          <Stat label="Collected today" value={<Money value={12450} />} sub="38 rides" />
          <Stat label="Buses running" value="7 / 9" />
          <Stat label="Clean trips" value="21" sub="Rs 1,050 bonus" />
          <Stat label="Waiting to sync" value="3" />
        </Stats>

        <Section eyebrow="Recent" title="Trips" action={<Button variant="ghost">See all</Button>}>
          <div className="bx-surface bx-surface--flush">
            <List>
              <Item icon="bus" title="रत्नपार्क → कोटेश्वर" sub="BA 2 KHA 4412 · 6.4 km · today 08:12" end={<Money value={-32} signed />} onClick={noop} />
              <Item icon="topup" tone="in" title="eSewa top-up" sub="Yesterday 19:40" end={<Money value={500} signed />} onClick={noop} />
              <Item icon="alert" tone="accent" title="Ride not closed — claim available" sub="Thapathali · 2 Oct" end={<Money value={-60} signed />} onClick={noop} />
            </List>
          </div>
        </Section>

        <Section title="Loading">
          <div className="bx-surface bx-surface--flush"><SkeletonList rows={3} /></div>
        </Section>

        <div className="bx-surface"><Empty icon="ticket" title="No trips yet" action={<Button>Start a ride</Button>}>Your first ride appears here the moment you get off the bus, even with no signal.</Empty></div>
        <div className="bx-surface"><Empty error title="Could not load trips" action={<Button variant="secondary">Try again</Button>}>No connection. Your rides are safe on this phone.</Empty></div>

        <Note>Fares up to Rs 500 work with no signal.</Note>
        <Note tone="ok">eSewa payment received. Your balance is Rs 2,482.</Note>
        <Note tone="warn">Your balance is below the next fare. You can ride down to − Rs 50.</Note>
        <Note tone="bad">This sign-on code is for another bus.</Note>

        <Field label="Phone number" hint="We send a code by SMS."><input className="bx-input" inputMode="tel" placeholder="98XXXXXXXX" /></Field>
        <Segmented label="Range" value={seg} onChange={setSeg} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: '30 days' }]} />

        <div className="bx-row" style={{ flexWrap: 'wrap' }}>
          <Button size="lg" onClick={() => setSheet(true)}>Open sheet</Button>
          <Button variant="ink">Ink</Button>
          <Button variant="secondary" busy>Busy</Button>
          <Button variant="ghost" disabled>Disabled</Button>
          <SyncPill status={{ online: false, waiting: 2, syncNow: noop }} />
          <SyncPill status={{ online: true, syncing: true, waiting: 2, syncNow: noop }} />
          <SyncPill status={{ online: true, waiting: 0, lastSyncedAt: Date.now() - 300000, syncNow: noop }} />
          <SyncPill status={{ online: true, waiting: 1, error: 'x', syncNow: noop }} />
        </div>
      </main>
      <TabBar tabs={TABS} current={tab} onChange={setTab} brand="भाडा" />
      <Sheet open={sheet} onClose={() => setSheet(false)} label="Example">
        <h2 className="bx-h2">The fare for your stages</h2>
        <p className="bx-muted">Show this code at the door when you get on and when you get off.</p>
        <Button block size="lg" onClick={() => setSheet(false)}>Done</Button>
      </Sheet>
    </div>
  );
}
