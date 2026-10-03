// A router small enough to read in one sitting.
//
// Three surfaces, no nesting, no params. Pulling in a routing library for that
// would cost more bytes than the pages, and every byte is precached before a
// phone can go offline.

import { useEffect, useState } from 'react';
import { redirectTarget, resolveSurface } from './surface.mjs';

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

// An old path printed on a sticker or kept on a home screen is moved to the app
// that took it over, keeping its query (an eSewa return carries its payment
// there). Called once at boot, before the first render.
export function followRedirect() {
  const target = redirectTarget(window.location);
  if (!target) return true;
  if (!servedHere(new URL(target, window.location.origin).pathname)) {
    window.location.replace(target);
    return false;
  }
  window.history.replaceState({}, '', target);
  return true;
}

/*
  Which surfaces this build serves. The site and the three apps are separate
  builds, so a link into another one is a page load, not a history push: the
  other app's code is not in this bundle.
*/
const BUILD = typeof __BHADA_APP__ === 'string' ? __BHADA_APP__ : 'site';
const OWNS = {
  site: ['site', 'admin', 'inspect', 'demo', 'kit'],
  rider: ['rider'],
  crew: ['crew'],
  owner: ['owner'],
  staff: ['staff'],
};

export function servedHere(pathname) {
  return (OWNS[BUILD] ?? OWNS.site).includes(resolveSurface(pathname).app);
}

export function navigate(to) {
  const url = new URL(to, window.location.origin);
  to = redirectTarget(url) ?? to;
  if (!servedHere(new URL(to, window.location.origin).pathname)) {
    window.location.assign(to);
    return;
  }
  if (window.location.pathname + window.location.search === to) return;
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
