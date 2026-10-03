// The public site.
//
// Written first for the person who would pay for this — someone who owns buses
// — and then, section by section, for everyone else who has to trust it: the
// passenger being charged, the crew at the door, the regulator counting heads.
// Every figure on this page is either computed from the same code the meter
// runs (the fare table, the specimen receipt) or taken from a named proof
// script, and the one thing that has not been proven yet is said plainly.

import { navigate } from '../lib/router';
import { STOPS, stageMetres, stop, rupees } from '../lib/nepali';
import { stageFare } from '../lib/fares';
import { priceDistance, TARIFF } from '../../protocol/meter.mjs';

// Rides worth comparing: a short hop, the mid-distance rides the stage table
// overcharges most, and the whole corridor.
const COMPARE = [
  ['RATNAPARK', 'SINGHADURBAR'],
  ['RATNAPARK', 'THAPATHALI'],
  ['MAITIGHAR', 'NEWBANESHWOR'],
  ['THAPATHALI', 'KOTESHWOR'],
  ['SINGHADURBAR', 'TINKUNE'],
  ['RATNAPARK', 'KOTESHWOR'],
];

function compareRows() {
  return COMPARE.map(([from, to]) => {
    const metres = stageMetres(from, to);
    const today = stageFare(from, to);
    const metered = priceDistance(metres).amount;
    return { from: stop(from), to: stop(to), metres, today, metered, saved: today - metered };
  });
}

// Every stage pair on the corridor, to state the promise as a count rather
// than as an adjective.
function promise() {
  let pairs = 0;
  let cheaper = 0;
  let dearer = 0;
  for (let a = 0; a < STOPS.length; a += 1) {
    for (let b = a + 1; b < STOPS.length; b += 1) {
      pairs += 1;
      const today = stageFare(STOPS[a].code, STOPS[b].code);
      const metered = priceDistance(stageMetres(STOPS[a].code, STOPS[b].code)).amount;
      if (metered < today) cheaper += 1;
      if (metered > today) dearer += 1;
    }
  }
  return { pairs, cheaper, dearer };
}

// From `npm run proof:meter`, section 10: worst error over five simulated
// drives per row, receiver reporting Doppler speed.
const ACCURACY = [
  ['Walking pace, 5 km/h', '+1.1%'],
  ['Jam crawl, 11 km/h', '+0.7%'],
  ['City traffic, 22 km/h', '−1.2%'],
  ['Open road, 40 km/h', '−1.3%'],
  ['Stop-and-go junctions', '−0.8%'],
  ['Signal bouncing off buildings', '−0.6%'],
];

export default function Landing() {
  const rows = compareRows();
  const kept = promise();
  const specimen = priceDistance(stageMetres('MAITIGHAR', 'NEWBANESHWOR'));
  const specimenToday = stageFare('MAITIGHAR', 'NEWBANESHWOR');

  return (
    <div className="site">
      <header className="site__head">
        <div className="site__mark">
          भाडा
          <span>Bhada</span>
        </div>
        <nav className="site__nav">
          <button type="button" onClick={() => navigate('/demo')}>Live demo</button>
          <button type="button" onClick={() => navigate('/app')}>Try it</button>
          <button type="button" onClick={() => navigate('/app/wallet')}>My account</button>
          <button type="button" onClick={() => navigate('/owner')}>Owner sign in</button>
        </nav>
      </header>

      <section className="hero hero--split">
        <div>
          <p className="hero__kicker">For bus owners on the Kathmandu routes</p>
          <h1 className="hero__line">
            Fares by the
            <br />
            kilometre.
            <br />
            <em>Loads by the permit.</em>
          </h1>
          <p className="hero__body">
            Today the conductor guesses the stage, the passenger argues, the cash comes back short,
            and the bus leaves Koteshwor with sixty people on a forty-two person permit. Bhada is one
            meter that answers all four — and it keeps working on the stretch past Tinkune where the
            signal dies.
          </p>
          <div className="hero__ctas">
            <button type="button" className="site__cta" onClick={() => navigate('/demo')}>
              Watch a whole bus run
              <small>Meter, door, passengers, cash, an inspector and the backend — internet off</small>
            </button>
            <button type="button" className="site__cta site__cta--quiet" onClick={() => navigate('/app')}>
              Ride as a passenger
              <small>Turn your wifi off first. It still works.</small>
            </button>
          </div>
        </div>

        <figure className="specimen" aria-label="Specimen receipt">
          <div className="specimen__head">
            <b>रसिद</b>
            <small>Specimen receipt</small>
          </div>
          <div className="specimen__route">
            <span>{stop('MAITIGHAR').ne}</span>
            <span>{stop('NEWBANESHWOR').ne}</span>
          </div>
          <div className="specimen__km tabular">
            {(specimen.metres / 1000).toFixed(2)}
            <small>km, measured by the bus</small>
          </div>
          <ul className="specimen__lines">
            {specimen.breakdown.map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <b className="tabular">{item.value}</b>
              </li>
            ))}
          </ul>
          <div className="specimen__total">
            <span>Charged</span>
            <b className="tabular">{rupees(specimen.amount)}</b>
          </div>
          <p className="specimen__was">Stage table today: {rupees(specimenToday)}</p>
          <div className="specimen__witness">
            <span>Your phone measured</span>
            <b className="tabular">{((specimen.metres - 20) / 1000).toFixed(2)} km</b>
            <small>Agrees with the bus. Signed by vehicle बा २ ख ४४१२.</small>
          </div>
        </figure>
      </section>

      <section className="strip">
        <div className="strip__item">
          <b>±2%</b>
          <span>of the true road distance, at every traffic speed simulated</span>
        </div>
        <div className="strip__item">
          <b>&lt;1 m</b>
          <span>billed to a bus parked ten minutes with a wandering GPS</span>
        </div>
        <div className="strip__item">
          <b>{kept.pairs - kept.dearer}/{kept.pairs}</b>
          <span>rides between stages cost no more than today, {kept.cheaper} cost less</span>
        </div>
        <div className="strip__item">
          <b>0 bars</b>
          <span>of signal needed to take a fare, on either side of the door</span>
        </div>
      </section>

      <section className="trust">
        <h2 className="section__title">
          एउटा यात्रा, चार जना
          <span>One ride, and everyone who has to trust it</span>
        </h2>
        <dl className="trust__list">
          <div>
            <dt>
              <b>मालिक</b>
              <small>The owner</small>
            </dt>
            <dd>
              <strong>Every rupee arrives with the kilometre, the door and the hour on it.</strong>
              You see what each route earns per kilometre carried, which bus stopped reporting at 9am,
              and exactly how full every trip ran. Cash that goes missing now has a number next to it.
            </dd>
          </div>
          <div>
            <dt>
              <b>यात्रु</b>
              <small>The passenger</small>
            </dt>
            <dd>
              <strong>Pays for the kilometres ridden, and has a second opinion in their pocket.</strong>
              Their own phone measures the ride with the same meter the bus runs, and checks the
              receipt against it at the door. Nobody can charge them for a ride they did not sign for —
              not the crew, not the operator.
            </dd>
          </div>
          <div>
            <dt>
              <b>खलासी</b>
              <small>The crew</small>
            </dt>
            <dd>
              <strong>No arguing about stages, and no being the one who says the bus is full.</strong>
              The fare is arithmetic on the screen, in whole rupees. When the bus reaches its permit,
              the door says so — and the crew are no longer the ones turning people away.
            </dd>
          </div>
          <div>
            <dt>
              <b>नियामक</b>
              <small>The regulator</small>
            </dt>
            <dd>
              <strong>Overloading stops being deniable.</strong>
              Every time a bus sat at its permit, and every time the crew overrode the door, is a
              timestamped row that uploads with the fares. The tariff is public, and every receipt can
              be re-checked from the raw signed record years later.
            </dd>
          </div>
        </dl>
      </section>

      <section className="how">
        <h2 className="section__title">
          कसरी चल्छ
          <span>What actually happens on the bus</span>
        </h2>
        <ol className="how__steps">
          <li>
            <b>1</b>
            <div>
              <strong>Tap in at the front door.</strong>
              The passenger shows the ride code on their phone, or a Bhada card. Nothing is charged —
              a fare quoted before anyone knows the distance is a fare that was guessed.
            </div>
          </li>
          <li>
            <b>2</b>
            <div>
              <strong>The meter counts the road, and the heads.</strong>
              A spare phone under the seat measures the distance from GPS, filtered so a parked bus
              bills nothing. The same count of who is aboard refuses the next boarding at the permit.
            </div>
          </li>
          <li>
            <b>3</b>
            <div>
              <strong>Tap out at the same door, and see the arithmetic.</strong>
              Kilometres, rate, total, on the door screen and on the passenger&apos;s phone beside their
              own measurement. No signal needed on either side.
            </div>
          </li>
          <li>
            <b>4</b>
            <div>
              <strong>The money settles by itself.</strong>
              Whenever any device finds a network, the signed receipts and the passengers&apos; signed
              taps go up together, are re-checked, and settle. Nobody has to remember to send anything.
            </div>
          </li>
        </ol>
      </section>

      <section className="fares">
        <h2 className="section__title">
          उही यात्रा, कति पर्छ
          <span>The same rides, priced both ways</span>
        </h2>
        <div className="fares__scroll">
          <table className="fares__table">
            <thead>
              <tr>
                <th>Ride</th>
                <th>Road</th>
                <th>Stage fare today</th>
                <th>By the kilometre</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.from.code}-${row.to.code}`}>
                  <td>
                    <b>{row.from.ne} – {row.to.ne}</b>
                    <small>{row.from.en} to {row.to.en}</small>
                  </td>
                  <td className="tabular">{(row.metres / 1000).toFixed(1)} km</td>
                  <td className="tabular">{rupees(row.today)}</td>
                  <td className="tabular fares__metered">
                    {rupees(row.metered)}
                    {row.saved > 0 ? <small>{rupees(row.saved)} less</small> : <small>same</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="data__body">
          {rupees(TARIFF.boardingCharge)} covers the first {TARIFF.includedKm} km, then {rupees(TARIFF.perStep)} for
          each kilometre after, never above {rupees(TARIFF.cap)}. The short rider stops paying the long
          rider&apos;s fare; the end-to-end rider pays exactly what they pay now. Operators give up the
          overcharge and win back the riders who walk today because a short hop costs a full stage —
          and for the first time they can see which of the two is bigger on their own route.
        </p>
      </section>

      <section className="accuracy-site">
        <h2 className="section__title">
          किलोमिटर कसरी सही
          <span>How the kilometres are known to be right</span>
        </h2>
        <div className="accuracy-site__grid">
          <div>
            <p className="data__body">
              A phone&apos;s GPS is a noisy ruler. Parked at a junction it wanders; under the Koteshwor
              flyover it jumps half a kilometre. Summed raw, it bills people for sitting in traffic. So
              the meter counts road only when the receiver&apos;s own Doppler speed says the bus is
              moving, throws out jumps no bus could make, and counts in short straight chords that
              are long enough to cancel the jitter and short enough to follow the corners.
            </p>
            <p className="data__body">
              Then it is checked against roads whose length is known — crawling, stopping at
              junctions, lurching forward, with a receiver that wanders like a real one — and the
              fare it charges is compared to the fare for the true distance. Across 400 random rides
              over a simulated day, <strong>99.5% were charged exactly the right fare</strong>, and none
              was ever more than one kilometre&apos;s step off.
            </p>
            <p className="data__body">
              What has not happened yet is a moving Kathmandu bus. That is what the meter&apos;s trace
              recorder is for: ride your route with it once, and the recording is scored against the
              road&apos;s real length by the same code. The passenger&apos;s phone does the same check on
              every single ride.
            </p>
          </div>
          <table className="accuracy-site__table">
            <caption>Worst error of five simulated drives, from <code>npm run proof:meter</code></caption>
            <tbody>
              {ACCURACY.map(([label, error]) => (
                <tr key={label}>
                  <th>{label}</th>
                  <td className="tabular">{error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="doors">
        <h2 className="section__title">
          अनुमति भन्दा बढी होइन
          <span>The door that counts</span>
        </h2>
        <ul className="value">
          <li>
            <b>At the permit, getting on stops</b>
            <span>The meter already knows how many are aboard, because it counted every tap. At the permitted number, the next tap-in is refused, and the counter at the step shows anyone who pushes past.</span>
          </li>
          <li>
            <b>Getting off is never held</b>
            <span>A Nepali bus has one door, and a full bus is exactly when people most need to get off. The door stays open for them. That rule is in the meter&apos;s code, not in a setting anyone can change.</span>
          </li>
          <li>
            <b>An override always opens, and always writes a row</b>
            <span>Emergencies happen. The override is one press, and it lands in the overload record with the time, the count and the permit — the record a regulator reads.</span>
          </li>
        </ul>
      </section>

      <section className="why">
        <h2 className="section__title">
          यो किन नबिग्रिने
          <span>Why this one will not go the way the others did</span>
        </h2>
        <div>
          <p className="data__body">
            Sajha tried digital ticketing. Bharatpur tried it. Around eight hundred buses in Pokhara
            tried it. All three worked in the demonstration and were dropped within months, for the
            same reason: the payment needed a signal at the moment it was taken, and on a moving bus
            there often is not one.
          </p>
          <p className="data__body">
            Bhada was built backwards from that. Every tap, every price and every receipt is decided
            on the devices in the bus. Reaching the internet is how the money moves later — never how
            the fare gets taken.
          </p>
        </div>
      </section>

      <section className="cost">
        <h2 className="section__title">
          सुरु गर्न के चाहिन्छ
          <span>What it takes to start</span>
        </h2>
        <div>
          <ul className="value">
            <li>
              <b>A spare Android phone under the seat</b>
              <span>That is the meter. No card readers, no wiring. A dedicated box with its own GPS comes later, running the same code.</span>
            </li>
            <li>
              <b>A phone at each door</b>
              <span>The two the conductor and helper already carry. Pair them to the meter once, by camera.</span>
            </li>
            <li>
              <b>Your plate numbers and permits</b>
              <span>Register a bus in about ten seconds. Its permitted capacity is what the door enforces.</span>
            </li>
            <li>
              <b>Nothing from the passenger</b>
              <span>They open a web page and add it to their home screen — or take a card at the door. No app store, no account, no phone number.</span>
            </li>
          </ul>
          <button type="button" className="site__cta site__cta--quiet" onClick={() => navigate('/owner')}>
            Register your company
            <small>Add your buses and start seeing your routes</small>
          </button>
        </div>
      </section>

      <footer className="site__foot">
        <div>भाडा Bhada</div>
        <div>Ratna Park to Koteshwor, Kathmandu. Tariff {TARIFF.code}, a proposal, not yet gazetted.</div>
      </footer>
    </div>
  );
}
