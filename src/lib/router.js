// A router small enough to read in one sitting.
//
// Three surfaces, no nesting, no params. Pulling in a routing library for that
// would cost more bytes than the pages, and every byte is precached before a
// phone can go offline.

import { useEffect, useState } from 'react';

// How long the bus is held on screen during a route change. Long enough to
// read as an arrival rather than a flash, short enough that nobody waiting to
// pay notices it. Past this it stops being a transition and becomes a delay.
const CROSSING = 620;

export function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [crossing, setCrossing] = useState(false);

  // Listening is set up once. It must not depend on `path`, because re-running
  // this effect on every navigation would tear down the timer below with it.
  useEffect(() => {
    const onPop = () => {
      const next = window.location.pathname;
      setPath((previous) => {
        // Only cover an actual change of surface. Re-rendering the page you are
        // already on should never put a bus in front of you.
        if (previous !== next) setCrossing(true);
        return next;
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The crossing clears itself. Keeping this separate is what stops a
  // navigation from cancelling its own timer and leaving the bus on screen.
  useEffect(() => {
    if (!crossing) return undefined;
    const timer = setTimeout(() => setCrossing(false), CROSSING);
    return () => clearTimeout(timer);
  }, [crossing]);

  return [path, crossing];
}

export function navigate(to) {
  if (window.location.pathname === to) return;
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
