// The public front page, laid out the way eSewa, Khalti and Pathao lay theirs
// out, so it reads at a glance: one line, the buttons, a phone showing the
// app, and the three apps as tiles. Everything else lives in the apps.

import { useState } from 'react';
import { navigate } from '../lib/router';
import { Icon } from '../ui';
import '../styles/tokens.css';
import '../ui/ui.css';
import './home.css';
import Tour from './Tour';

const go = (to) => (event) => { event.preventDefault(); navigate(to); };

const APPS = [
  { to: '/app', icon: 'ticket', name: 'Bhada', who: 'यात्रु · Riders', line: 'Pay your bus fare by the km.' },
  { to: '/crew', icon: 'scan', name: 'Bhada Crew', who: 'खलासी · Conductors', line: 'Collect fares, even offline.' },
  { to: '/owner', icon: 'bus', name: 'Bhada Owner', who: 'मालिक · Bus owners', line: 'Your buses and your money.' },
];

export default function Home() {
  const [tour, setTour] = useState(false);
  return (
    <div className="hm">
      <header className="hm-nav">
        <a href="/" className="hm-nav__mark" aria-label="Bhada"><span className="bx-top__mark">भाडा</span></a>
        <nav aria-label="Apps">
          <a href="/owner" onClick={go('/owner')}>For bus owners</a>
          <a className="bx-btn bx-btn--primary" href="/app" onClick={go('/app')}>Open app</a>
        </nav>
      </header>

      <main className="hm-hero">
        <div className="hm-hero__copy">
          <p className="bx-eyebrow">भाडा · Bhada</p>
          <h1>Bus fares by distance. <span>Even without a signal.</span></h1>
          <p>Measure the ride, record it offline with a signed receipt, and settle the fare when a connection comes back.</p>
          <div className="hm-hero__cta">
            <a className="bx-btn bx-btn--primary bx-btn--lg" href="/app" onClick={go('/app')}>
              <Icon name="ticket" /> Start riding
            </a>
            <button type="button" className="bx-btn bx-btn--secondary bx-btn--lg" onClick={() => setTour(true)}>
              <Icon name="info" /> How it works
            </button>
          </div>
          <ul className="hm-hero__ticks">
            <li><Icon name="gauge" /> Fare by the km</li>
            <li><Icon name="offline" /> Rides recorded offline</li>
            <li><Icon name="receipt" /> A signed receipt every ride</li>
          </ul>
        </div>

        <div className="hm-phone" aria-hidden="true">
          <div className="hm-phone__screen">
            <div className="hm-phone__bar"><span className="bx-top__mark">भाडा</span><span className="hm-phone__pill">● Offline</span></div>
            <div className="hm-phone__card">
              <small>● यात्रामा · On ride · 18 min</small>
              <b>4.2 km</b>
              <div className="hm-phone__actions">
                <span>Fare so far</span>
                <span><b className="hm-phone__fare">रु 21</b></span>
              </div>
            </div>
            <div className="hm-phone__board">
              <span className="hm-phone__verb">ओर्लनुहोस्</span>
              <span className="hm-phone__qr"><Icon name="qr" /></span>
            </div>
            <div className="hm-phone__row"><span>Ride saved on this phone</span><b className="in">✓</b></div>
            <div className="hm-phone__row"><span>Last ride · 3.1 km</span><b>− रु 18</b></div>
          </div>
        </div>
      </main>

      <section className="hm-apps" aria-label="Apps">
        {APPS.map((app) => (
          <a key={app.to} className="hm-app" href={app.to} onClick={go(app.to)}>
            <span className="hm-app__icon"><Icon name={app.icon} /></span>
            <span className="hm-app__text">
              <b>{app.name}</b>
              <small>{app.who}</small>
              <span>{app.line}</span>
            </span>
            <Icon name="chevron" className="hm-app__go" />
          </a>
        ))}
      </section>

      {tour ? (
        <>
          <div className="tr-scrim" onClick={() => setTour(false)} />
          <Tour onClose={() => setTour(false)} />
        </>
      ) : null}

      <footer className="hm-foot">
        <span>© Bhada · Kathmandu</span>
        <nav aria-label="More">
          <a href="/demo" onClick={go('/demo')}>Demo</a>
          <a href="/inspect" onClick={go('/inspect')}>Inspectors</a>
          <a href="/review">Document review</a>
        </nav>
      </footer>
    </div>
  );
}
