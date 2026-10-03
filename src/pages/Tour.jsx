// How a ride works, as the swipe-through intro every app opens with: one
// picture and one line per card, dots, Skip, Next. Swipe, tap or use the
// arrow keys.

import { useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../lib/router';
import { Icon } from '../ui';
import './tour.css';

const SLIDES = [
  {
    art: 'wallet',
    ne: 'एक पटक टप-अप',
    title: 'Top up once',
    text: 'Add money through eSewa. Your ride balance is ready even when you are offline.',
  },
  {
    art: 'code',
    ne: 'चढ्दा कोड देखाउनुहोस्',
    title: 'Show your code',
    text: 'Getting on? Show the code to the conductor. That’s it.',
  },
  {
    art: 'road',
    ne: 'बसले किलोमिटर गन्छ',
    title: 'The bus counts the km',
    text: 'Your phone counts them too, so you can check.',
  },
  {
    art: 'receipt',
    ne: 'जति गयो, उति तिर्नुहोस्',
    title: 'Pay for what you rode',
    text: 'Get off and see your fare. A short ride costs less.',
  },
  {
    art: 'offline',
    ne: 'सिग्नल चाहिँदैन',
    title: 'No signal? No problem',
    text: 'Your ride and its signed receipt are saved offline. The fare settles when the bus is back online.',
  },
];

function Art({ kind }) {
  if (kind === 'wallet') {
    return (
      <div className="tr-art tr-art--wallet">
        <div className="tr-card"><small>Balance</small><b>रु 500</b></div>
        <span className="tr-chip"><Icon name="topup" /> eSewa</span>
      </div>
    );
  }
  if (kind === 'code') {
    return (
      <div className="tr-art">
        <div className="tr-phone"><Icon name="qr" /><span>चढ्नुहोस्</span></div>
        <span className="tr-check"><Icon name="check" /></span>
      </div>
    );
  }
  if (kind === 'road') {
    return (
      <div className="tr-art tr-art--road">
        <span className="tr-road" />
        <span className="tr-bus"><Icon name="bus" /></span>
        <b className="tr-km">6.4 km</b>
      </div>
    );
  }
  if (kind === 'receipt') {
    return (
      <div className="tr-art">
        <div className="tr-receipt">
          <span>रत्नपार्क → कोटेश्वर</span>
          <span>6.4 km</span>
          <b>रु 30</b>
        </div>
      </div>
    );
  }
  return (
    <div className="tr-art">
      <span className="tr-big"><Icon name="offline" /></span>
      <span className="tr-chip tr-chip--ok"><Icon name="sync" /> Synced later</span>
    </div>
  );
}

export default function Tour({ onClose }) {
  const [index, setIndex] = useState(0);
  const start = useRef(null);
  const last = index === SLIDES.length - 1;
  const close = useCallback(() => (onClose ? onClose() : navigate('/')), [onClose]);
  const next = useCallback(() => (last ? navigate('/app') : setIndex((i) => i + 1)), [last]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'ArrowRight') next();
      if (event.key === 'ArrowLeft') back();
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, close]);

  const slide = SLIDES[index];
  return (
    <div
      className="tr"
      role="dialog"
      aria-modal="true"
      aria-label="How Bhada works"
      onPointerDown={(e) => { start.current = e.clientX; }}
      onPointerUp={(e) => {
        if (start.current === null) return;
        const moved = e.clientX - start.current;
        start.current = null;
        if (moved < -50) next();
        if (moved > 50) back();
      }}
    >
      <header className="tr-top">
        <span className="bx-top__mark">भाडा</span>
        <button type="button" className="tr-skip" onClick={close}>{last ? 'Close' : 'Skip'}</button>
      </header>

      <div className="tr-stage" key={index}>
        <Art kind={slide.art} />
        <p className="tr-ne">{slide.ne}</p>
        <h2>{slide.title}</h2>
        <p className="tr-text">{slide.text}</p>
      </div>

      <footer className="tr-foot">
        <div className="tr-dots" role="tablist" aria-label="Slides">
          {SLIDES.map((s, i) => (
            <button key={s.title} type="button" role="tab" aria-selected={i === index} aria-label={`${i + 1}: ${s.title}`} onClick={() => setIndex(i)} />
          ))}
        </div>
        <button type="button" className="bx-btn bx-btn--primary bx-btn--lg bx-btn--block" onClick={next}>
          {last ? 'Start riding' : 'Next'}
        </button>
      </footer>
    </div>
  );
}
