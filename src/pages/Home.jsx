// The front page. Written for someone in Kathmandu who has never heard of
// Bhada: what it does in one line, which app is theirs, how a ride goes in
// three steps, what it costs, and every app one tap away. Nothing else.

import { useState } from 'react';
import { navigate } from '../lib/router';
import { Icon, DemoTag } from '../ui';
import { CURRENT_TARIFF } from '../../protocol/meter.mjs';
import '../styles/tokens.css';
import '../ui/ui.css';
import './home.css';
import Tour from './Tour';

const go = (to) => (event) => { event.preventDefault(); navigate(to); };

const WHO = [
  { to: '/app', icon: 'ticket', ne: 'यात्रु', name: 'I ride the bus', line: 'Show a code, ride, keep your receipt.' },
  { to: '/crew', icon: 'scan', ne: 'खलासी', name: 'I am a conductor', line: 'The meter and the door, on your phone.' },
  { to: '/owner', icon: 'bus', ne: 'बस मालिक', name: 'I own buses', line: 'Your buses, fares and payouts.' },
];

const STEPS = [
  { icon: 'qr', ne: 'चढ्दा कोड देखाउनुहोस्', en: 'Show your code at the door when you get on.' },
  { icon: 'pin', ne: 'बसको GPS ले स्टेज चिन्छ', en: 'The bus’s GPS knows which stage you got on at and which stage it is at now.' },
  { icon: 'receipt', ne: 'ओर्लंदा रसिद पाउनुहोस्', en: 'Show the code again to get off. The stage fare from the fare table is on your signed receipt.' },
];

export default function Home() {
  const [tour, setTour] = useState(false);
  return (
    <div className="hm">
      <header className="hm-nav">
        <a href="/" className="bx-top__mark" aria-label="Bhada home">भाडा</a>
        <nav aria-label="Apps">
          <a href="/owner" onClick={go('/owner')}>Bus owners</a>
          <a className="bx-btn bx-btn--primary" href="/app" onClick={go('/app')}>Open app</a>
        </nav>
      </header>

      <main>
        <section className="hm-hero">
          <h1>कहाँ चढ्नुभयो, कहाँ ओर्लनुभयो, <span>भाडा कति।</span></h1>
          <p>Transparent bus fares for Kathmandu — even without internet.</p>
          <div className="hm-hero__cta">
            <a className="bx-btn bx-btn--primary bx-btn--lg" href="/app" onClick={go('/app')}>
              <Icon name="ticket" /> Open Bhada
            </a>
            <button type="button" className="bx-btn bx-btn--secondary bx-btn--lg" onClick={() => setTour(true)}>
              How it works
            </button>
          </div>
        </section>

        <section className="hm-sec" aria-labelledby="hm-who">
          <h2 id="hm-who">तपाईं को हो? · Who are you?</h2>
          <ul className="hm-who">
            {WHO.map((w) => (
              <li key={w.to}>
                <a href={w.to} onClick={go(w.to)}>
                  <span className="hm-who__icon" aria-hidden="true"><Icon name={w.icon} /></span>
                  <span className="hm-who__text">
                    <small>{w.ne}</small>
                    <b>{w.name}</b>
                    <span>{w.line}</span>
                  </span>
                  <Icon name="chevron" className="hm-who__go" />
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="hm-sec" aria-labelledby="hm-how">
          <h2 id="hm-how">यात्रा कसरी हुन्छ · How a ride works</h2>
          <ol className="hm-steps">
            {STEPS.map((s, i) => (
              <li key={s.ne}>
                <span className="hm-steps__icon" aria-hidden="true"><Icon name={s.icon} /></span>
                <span>
                  <small>{i + 1}</small>
                  <b>{s.ne}</b>
                  <span>{s.en}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="hm-small"><Icon name="offline" /> Every step works with no internet. The ride is recorded and signed offline; payment is settled when the bus is back online.</p>
        </section>

        <section className="hm-sec" aria-labelledby="hm-fare">
          <h2 id="hm-fare">भाडा · The fare {CURRENT_TARIFF.demo ? <DemoTag>Demo fare table</DemoTag> : null}</h2>
          <p className="hm-lead">
            Bhada does not set fares. It finds the stage you got on at and the stage you got off at, and applies
            the route&rsquo;s fare table. From Ratna Park on route R11:
          </p>
          <dl className="hm-fare">
            {CURRENT_TARIFF.stages.slice(1).map((stage) => (
              <div key={stage.code}>
                <dt>{stage.ne} · {stage.en}</dt>
                <dd>रु {CURRENT_TARIFF.fares[`${CURRENT_TARIFF.stages[0].code}|${stage.code}`]}</dd>
              </div>
            ))}
          </dl>
          <p className="hm-small">Students and seniors pay half. When the official fares change, a new fare table is published; old receipts keep the table they were charged under.</p>
          <a className="bx-btn bx-btn--secondary" href="/app/routes" onClick={go('/app/routes')}>
            <Icon name="route" /> Routes and fare calculator
          </a>
        </section>
      </main>

      {tour ? (
        <>
          <div className="tr-scrim" onClick={() => setTour(false)} />
          <Tour onClose={() => setTour(false)} />
        </>
      ) : null}

      <footer className="hm-foot">
        <nav aria-label="All apps">
          <a href="/app" onClick={go('/app')}>Passenger app</a>
          <a href="/crew" onClick={go('/crew')}>Conductor app</a>
          <a href="/owner" onClick={go('/owner')}>Bus owner app</a>
          <a href="/staff">Bhada staff login</a>
          <a href="/demo" onClick={go('/demo')}>Watch a demo trip</a>
          <a href="/inspect" onClick={go('/inspect')}>Ticket inspectors</a>
        </nav>
        <p>© Bhada · Kathmandu</p>
      </footer>
    </div>
  );
}
