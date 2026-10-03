// Which app a path belongs to, and where an old link now lives.
//
// Bhada is three apps — Rider (/app), Crew (/crew), Owner (/owner) — plus the
// public site, the Staff console (/staff) and three internal tools. Paths printed on QR stickers and saved
// on home screens before the split still have to land somewhere useful, so
// every old surface redirects into the app that took it over.

const APPS = {
  app: 'rider',
  crew: 'crew',
  owner: 'owner',
  staff: 'staff',
  admin: 'admin',
  inspect: 'inspect',
  demo: 'demo',
  _ui: 'kit',
};

// Old first segment (and optional second) → new path.
const LEGACY = [
  [['app', 'account'], '/app/wallet'],
  [['operator'], '/owner'],
  [['device'], '/crew/bus'],
  [['terminal'], '/crew/door'],
];

function segments(pathname) {
  return String(pathname ?? '/').split('/').filter(Boolean);
}

export function resolveSurface(pathname) {
  const parts = segments(pathname);
  for (const [prefix, target] of LEGACY) {
    if (prefix.every((part, i) => parts[i] === part)) {
      const next = resolveSurface(target);
      return { ...next, redirect: target };
    }
  }
  const app = APPS[parts[0]];
  if (!app) return { app: 'site', page: parts.join('/'), redirect: null };
  return { app, page: parts.slice(1).join('/'), redirect: null };
}

// The full URL to replace the current one with, or null. The query and hash
// travel with it: eSewa returns to /app/account?data=…, and that data is the
// payment being finished.
export function redirectTarget({ pathname, search = '', hash = '' }) {
  const { redirect } = resolveSurface(pathname);
  return redirect ? `${redirect}${search}${hash}` : null;
}
