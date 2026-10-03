// Today. Until the company is live and every bus verified, the first thing on
// it is the list of what is left, in the order Bhada onboards a company (0038):
// agreements, company papers, buses, their papers, drivers, phones, live.
// After that, the day's figures and every bus.

import { Button, Icon, Plate, Stats, Stat, SkeletonList, Empty, Note, Stamp, DemoTag } from '../../ui';
import { call, rows, useLoad, plateOf, rs, dateOf, timeOf, PAPERS } from './data';

async function loadToday(isOwner) {
  const [fleet, papers, people, money, state, requests] = await Promise.all([
    rows('owner_fleet', { col: 'plate' }),
    call('owner_compliance'),
    call('owner_members'),
    isOwner ? call('owner_money') : Promise.resolve(null),
    call('my_onboarding'),
    call('owner_requests'),
  ]);
  if (papers?.ok === false) throw new Error(papers.message ?? papers.reason);
  return { fleet: fleet.filter((b) => !b.retired_at), papers, people, money, state, requests: requests?.requests ?? [] };
}

// Where the company stands on the way to live and verified, as steps.
export function onboarding({ fleet, papers, state, requests, isOwner }) {
  const subjects = [...papers.buses, ...papers.drivers];
  const all = subjects.flatMap((s) => Object.entries(s.papers).map(([type, p]) => ({ ...p, type, subject: s.plate ?? s.name })));
  const count = (status) => all.filter((p) => p.status === status).length;
  const busPapers = papers.buses.flatMap((b) => Object.values(b.papers));
  const driverPapers = papers.drivers.flatMap((d) => Object.values(d.papers));
  const toFix = count('rejected') + count('expired');
  const waiting = count('pending');
  const verified = subjects.length > 0 && papers.drivers.length > 0 && subjects.every((s) => s.verified);
  const live = state?.status === 'live';
  const signed = ['service', 'payout_mandate', 'data_consent'].filter((k) => state?.agreements?.[k]?.current).length;
  const company = papers.company ?? state?.company_papers;
  const companyPapers = Object.values(company?.papers ?? {});
  const companyFix = companyPapers.filter((p) => p.status === 'rejected' || p.status === 'expired').length;
  const asked = requests.filter((r) => r.kind === 'new_bus' && r.status === 'pending').length;

  return {
    verified: verified && live,
    live,
    toFix: toFix + companyFix,
    waiting,
    steps: [
      {
        id: 'agreements', title: 'Agreements with Bhada',
        sub: signed === 3 ? 'Service agreement, payout mandate and data notice — all signed.'
          : `${signed} of 3 signed. Read each and accept it here, or sign the paper copy with Bhada.`,
        state: signed === 3 ? 'done' : 'now',
        action: signed === 3 ? null : { label: isOwner ? 'Read and accept' : 'See them', to: 'agreements' },
      },
      {
        id: 'company', title: 'Company papers',
        sub: company?.verified ? 'Registration, PAN, tax clearance, directors’ citizenship and DoTM registration — checked.'
          : companyFix ? `${companyFix} need a new copy — the reason is beside each one.`
          : 'Bhada files these from the originals at the visit and checks them.',
        state: company?.verified ? 'done' : companyFix ? 'fix' : 'wait',
        action: companyFix ? { label: 'Open papers', to: 'papers/company' } : null,
      },
      {
        id: 'buses', title: 'Your buses on Bhada',
        sub: fleet.length ? `${fleet.length} bus${fleet.length === 1 ? '' : 'es'} entered from their papers.${asked ? ` ${asked} more asked for.` : ''}`
          : asked ? `${asked} asked for; Bhada enters each from its bluebook and route permit.`
          : 'Bhada enters each bus from its bluebook and route permit. Send photos of both.',
        state: fleet.length ? 'done' : asked ? 'wait' : 'now',
        action: fleet.length || asked ? null : { label: 'Ask for a bus', to: 'buses/new' },
      },
      {
        id: 'bus-papers', title: 'Each bus’s papers',
        sub: 'Bluebook, pollution test, tax clearance, insurance and route permit.',
        state: !fleet.length ? 'todo' : busPapers.some((p) => p.status === 'missing') ? 'now' : 'done',
        action: { label: 'Open papers', to: 'papers' },
      },
      {
        id: 'drivers', title: 'Drivers and their papers',
        sub: papers.drivers.length ? `${papers.drivers.length} driver${papers.drivers.length === 1 ? '' : 's'}. Each needs a licence and an agreement with the bus.` : 'Each driver needs a licence and an agreement with the bus.',
        state: !papers.drivers.length ? (fleet.length ? 'now' : 'todo') : driverPapers.some((p) => p.status === 'missing') ? 'now' : 'done',
        action: { label: papers.drivers.length ? 'Open papers' : 'Add a driver', to: papers.drivers.length ? 'papers' : 'people' },
      },
      {
        id: 'review', title: verified ? 'Every bus and driver verified' : toFix ? 'Papers to fix' : waiting ? 'Under review' : 'Bhada checks every paper',
        sub: verified ? 'Every paper is approved and in date.'
          : toFix ? `${toFix} paper${toFix === 1 ? '' : 's'} need a new upload — the reason is beside each one.`
          : waiting ? `${waiting} paper${waiting === 1 ? ' is' : 's are'} being checked. Usually within one working day.`
          : 'Once uploaded, a reviewer checks each paper against the original.',
        state: verified ? 'done' : toFix ? 'fix' : waiting ? 'wait' : 'todo',
        action: toFix ? { label: 'Fix papers', to: 'papers' } : null,
      },
      {
        id: 'phones', title: 'Set up each bus phone',
        sub: fleet.length ? `${fleet.filter((b) => b.unit_bound).length} of ${fleet.length} set up. The conductor scans a code from here once.` : 'The conductor scans a one-time code from this app.',
        state: !fleet.length ? 'todo' : fleet.every((b) => b.unit_bound) ? 'done' : 'now',
        action: fleet.some((b) => !b.unit_bound) ? { label: 'Set up a phone', to: `buses/${fleet.find((b) => !b.unit_bound).plate}` } : null,
      },
      {
        id: 'live', title: live ? 'Live' : 'Bhada takes you live',
        sub: live ? 'Payouts are open.' : 'Once the agreements are signed and the company papers checked. Fares already settle; payouts open then.',
        state: live ? 'done' : signed === 3 && company?.verified ? 'wait' : 'todo',
      },
    ],
  };
}

function Steps({ steps, go }) {
  // One loud button: the first thing left to do. The rest wait their turn.
  const next = steps.findIndex((s) => s.action && (s.state === 'now' || s.state === 'fix'));
  return (
    <ol className="ow-steps">
      {steps.map((step, i) => (
        <li key={step.id} className={`ow-step ow-step--${step.state}`}>
          <span className="ow-step__mark" aria-hidden="true">
            {step.state === 'done' ? <Icon name="check" /> : step.state === 'fix' ? <Icon name="alert" /> : step.state === 'wait' ? <Icon name="clock" /> : i + 1}
          </span>
          <span>
            <span className="ow-step__title">{step.title}</span>
            <span className="ow-step__sub">{step.sub}</span>
          </span>
          {step.action && step.state !== 'done' && step.state !== 'todo' ? (
            <Button variant={i === next ? 'primary' : 'secondary'} onClick={() => go(step.action.to)}>{step.action.label}</Button>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export default function Today({ me, isOwner, go }) {
  const { data, error, loading, reload } = useLoad(() => loadToday(isOwner), [isOwner]);

  if (error) return <Empty error title="Could not load today" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={6} />;

  const { fleet, papers, money } = data;
  const plan = onboarding({ ...data, isOwner });
  const collected = fleet.reduce((sum, b) => sum + (b.collected_today ?? 0), 0);
  const rides = fleet.reduce((sum, b) => sum + (b.rides_today ?? 0), 0);
  const running = fleet.filter((b) => b.unit_seen_at && Date.now() - new Date(b.unit_seen_at).getTime() < 3 * 3600_000).length;
  const soon = [...papers.buses, ...papers.drivers].flatMap((s) => Object.entries(s.papers)
    .filter(([, p]) => p.status === 'approved' && p.expires_on && new Date(p.expires_on) - Date.now() < 30 * 86400_000)
    .map(([type, p]) => ({ type, subject: s.label || s.plate || s.name, expires: p.expires_on })));

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">आज · Today</p>
          <h1>{plan.verified ? 'Every bus verified' : plan.live ? 'Getting verified' : 'Getting started'}</h1>
          <p>{plan.verified
            ? `${fleet.length} bus${fleet.length === 1 ? '' : 'es'} and ${papers.drivers.length} driver${papers.drivers.length === 1 ? '' : 's'} with every paper approved and in date.`
            : 'Bhada does most of this with you at the visit. Fares already settle while the rest is done.'}</p>
        </div>
        {plan.verified ? <Stamp tone="in">प्रमाणित</Stamp> : null}
      </header>

      {!plan.verified || plan.toFix ? <Steps steps={plan.steps} go={go} /> : null}

      {soon.length ? (
        <Note tone="warn">
          {soon.slice(0, 3).map((s) => `${PAPERS[s.type].en} for ${s.subject} expires ${dateOf(s.expires)}`).join(' · ')}
          {soon.length > 3 ? ` · and ${soon.length - 3} more` : ''}. Upload the renewed paper before then.
        </Note>
      ) : null}

      <Stats four>
        <Stat label="Fares recorded today" value={rs(collected)} sub="signed receipts that reached Bhada" />
        <Stat label="Rides today" value={rides} sub={`across ${fleet.length} bus${fleet.length === 1 ? '' : 'es'}`} />
        <Stat label="Buses reporting" value={`${running} / ${fleet.length}`} sub="heard from in the last 3 hours" />
        {isOwner ? (
          <Stat label="Ready to pay out" value={rs(money?.payable?.available ?? 0)} sub={<button type="button" className="bx-auth__link" style={{ minHeight: 0 }} onClick={() => go('money')}>Open money →</button>} />
        ) : (
          <Stat label="Papers being checked" value={plan.waiting} sub={plan.toFix ? `${plan.toFix} to fix` : 'none to fix'} />
        )}
      </Stats>

      <section>
        <div className="ow-head" style={{ marginBottom: 'var(--b-3)' }}>
          <div>
            <p className="bx-eyebrow">बसहरू · Your buses</p>
          </div>
          <Button icon="plus" onClick={() => go('buses/new')}>Ask for a new bus</Button>
        </div>
        {fleet.length === 0 ? (
          <Empty icon="bus" title="No buses yet" action={<Button onClick={() => go('buses/new')}>Ask for your first bus</Button>}>
            Bhada enters each bus from its bluebook and route permit.
          </Empty>
        ) : (
          <ul className="ow-fleet">
            {fleet.map((bus) => {
              const subject = papers.buses.find((b) => b.plate === bus.plate);
              return (
                <li key={bus.plate}>
                  <button type="button" className="ow-bus" onClick={() => go(`buses/${bus.plate}`)}>
                    <Plate plate={plateOf(bus.plate)} size={15} />
                    <span>
                      <span className="ow-bus__name">{bus.label || bus.route_name || bus.plate}</span>
                      <span className="ow-bus__sub">
                        <span>{bus.route_name ?? 'No route'}</span>
                        <span>{bus.capacity ?? '—'} seats</span>
                        {subject?.verified ? <span className="ow-tag ow-tag--ok">Verified</span> : <span className="ow-tag ow-tag--warn">Papers</span>}
                        {bus.unit_bound
                          ? <span className="ow-tag ow-tag--ok">Phone {bus.unit_seen_at ? `seen ${timeOf(bus.unit_seen_at)}` : 'set up'}</span>
                          : <span className="ow-tag ow-tag--bad">No phone</span>}
                      </span>
                    </span>
                    <span className="ow-bus__end">
                      <b>{rs(bus.collected_today)}</b>
                      <small>{bus.rides_today} today</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-label="Demo screens">
        <p className="bx-eyebrow" style={{ marginBottom: 'var(--b-2)' }}>Demo screens · not your company’s data</p>
        <ul className="ow-fleet">
          <li>
            <button type="button" className="ow-bus" onClick={() => go('map')}>
              <Icon name="route" />
              <span>
                <span className="ow-bus__name">Fleet map <DemoTag>Simulated</DemoTag></span>
                <span className="ow-bus__sub"><span>Valley routes with simulated bus positions — what a live map would look like.</span></span>
              </span>
            </button>
          </li>
          <li>
            <button type="button" className="ow-bus" onClick={() => go('audit')}>
              <Icon name="shield" />
              <span>
                <span className="ow-bus__name">Fraud audit <DemoTag>Sample data</DemoTag></span>
                <span className="ow-bus__sub"><span>The checks Bhada is designed to run, shown on made-up events.</span></span>
              </span>
            </button>
          </li>
        </ul>
      </section>
      <p className="bx-small bx-muted">Signed in as {me.display_name ?? me.name} · company {me.operator_id}</p>
    </div>
  );
}
