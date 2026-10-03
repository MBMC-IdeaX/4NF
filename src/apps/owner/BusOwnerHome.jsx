// A bus owner's home: only their own buses, today's fares on each, and what
// they can withdraw. The company's fleet, people and papers are not theirs to
// see (0033); my_buses() and owner_money() answer for them alone.

import { Button, Empty, Note, Plate, SkeletonList, Stat, Stats } from '../../ui';
import { call, useLoad, plateOf, rs, timeOf, say } from './data';

async function load() {
  const [buses, money, state] = await Promise.all([call('my_buses'), call('owner_money'), call('my_onboarding')]);
  if (money?.ok === false) throw new Error(say(money));
  return { buses: Array.isArray(buses) ? buses : [], money, state };
}

export default function BusOwnerHome({ me, go }) {
  const { data, error, loading, reload } = useLoad(load);
  if (error) return <Empty error title="Could not load your buses" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Empty>;
  if (loading && !data) return <SkeletonList rows={4} />;

  const { buses, money, state } = data;
  const collected = buses.reduce((sum, b) => sum + Number(b.collected_today ?? 0), 0);
  const rides = buses.reduce((sum, b) => sum + Number(b.rides_today ?? 0), 0);
  const signed = state?.membership?.current;

  return (
    <div className="ow">
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">आज · Today</p>
          <h1>{buses.length ? `Your bus${buses.length === 1 ? '' : 'es'}` : 'No bus yet'}</h1>
          <p>Run under {me.name}’s route permits. Their fares are yours, less the company’s levy of {rs(money.levy_per_day)} for each day a bus runs.</p>
        </div>
      </header>

      {!signed ? (
        <Note tone="warn">
          Read and accept your membership agreement with {me.name}.{' '}
          <button type="button" className="bx-auth__link" style={{ minHeight: 0 }} onClick={() => go('agreements')}>Open it →</button>
        </Note>
      ) : null}

      <Stats four>
        <Stat label="Collected today" value={rs(collected)} sub={`${rides} ride${rides === 1 ? '' : 's'}`} />
        <Stat label="You can withdraw" value={rs(money.payable.available)}
          sub={<button type="button" className="bx-auth__link" style={{ minHeight: 0 }} onClick={() => go('money')}>Open money →</button>} />
        <Stat label="Levy paid so far" value={rs(Math.abs(money.payable.levy))} />
        <Stat label="Buses" value={buses.length} />
      </Stats>

      {buses.length === 0 ? (
        <Empty icon="bus" title="No bus is yours right now">The company’s owner sets which buses are yours. Fares a bus carried while it was yours stay yours.</Empty>
      ) : (
        <ul className="ow-fleet">
          {buses.map((bus) => (
            <li key={bus.plate} className="ow-bus" style={{ cursor: 'default' }}>
              <Plate plate={plateOf(bus.plate)} size={15} />
              <span>
                <span className="ow-bus__name">{bus.label || bus.plate}</span>
                <span className="ow-bus__sub">
                  <span>{bus.route_name ?? 'No route'}</span>
                  <span>{bus.capacity} places</span>
                  {bus.unit_bound
                    ? <span className="ow-tag ow-tag--ok">Phone {bus.unit_seen_at ? `seen ${timeOf(bus.unit_seen_at)}` : 'set up'}</span>
                    : <span className="ow-tag ow-tag--bad">No phone</span>}
                </span>
              </span>
              <span className="ow-bus__end">
                <b>{rs(bus.collected_today)}</b>
                <small>{bus.rides_today} today</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
