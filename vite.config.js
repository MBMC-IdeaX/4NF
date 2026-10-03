import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// The camera needs a secure origin. On a hosted domain that is HTTPS; for phone
// testing over the LAN, basicSsl gives dev a self-signed certificate so
// getUserMedia is allowed there too.
//
// BHADA_HTTP=1 turns it off. A headless browser will not take a self-signed
// certificate, so anything driving this server — a screenshot run, a smoke
// test — needs plain HTTP. localhost is a secure origin either way, so the
// camera still works there; only LAN phone testing needs the certificate.
const HTTPS = process.env.BHADA_HTTP !== '1';

/*
  Looking at the office screens without a login.

  The operator, account and admin portals all sit behind a Supabase session, so
  any work on how they look stalls behind a password that should not be typed
  into a test browser. BHADA_FIXTURES=1 swaps the Supabase client for
  lib/supabase-fixtures.js, which answers the same calls with rows copied from a
  live query — enough to render, screenshot and judge every screen offline.

  It is a build-time alias, so a normal build cannot reach it. What it proves is
  that a screen renders its data correctly; it says nothing about row-level
  security or the SQL behind the views, which is what `npm run proof:legs` is
  for.
*/
const FIXTURES = process.env.BHADA_FIXTURES === '1';

/*
  BHADA_LOCAL_DB=1 swaps the client for lib/supabase-local.js instead, which
  sends every call to the local sync server: real migrations, real row-level
  security, demo logins for every role. For driving the office screens end to
  end before a migration is live. Like the fixtures, unreachable in a normal build.
*/
const LOCAL_DB = process.env.BHADA_LOCAL_DB === '1';

const FIXTURE_MODULE = fileURLToPath(new URL(LOCAL_DB ? './src/lib/supabase-local.js' : './src/lib/supabase-fixtures.js', import.meta.url));

// A resolver rather than an alias: every portal imports the client relatively
// (`../../lib/supabase`), and an alias matches the specifier that was written
// rather than the file it lands on.
const fixturesPlugin = {
  name: 'bhada-supabase-fixtures',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!source.includes('lib/supabase') || source.includes('supabase-fixtures') || source.includes('supabase-local')) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!resolved) return null;
    return resolved.id.split('\\').join('/').endsWith('/src/lib/supabase.js') ? FIXTURE_MODULE : null;
  },
};
/*
  Four independent builds from one repository.

  The public site and the three apps share source (protocol/, the UI kit, the
  device code) but nothing at runtime: each has its own entry, bundle, service
  worker, manifest and on-device database, and they meet only through the
  Supabase API. `BHADA_APP` picks which one this run builds or serves:

    site   /        landing, /demo, /inspect, /admin, the /_ui kit
    rider  /app/    the passenger app, installs as "Bhada"
    crew   /crew/   the conductor's phone is the bus, installs as "Bhada Crew"
    owner  /owner/  the bus owner, installs as "Bhada Owner"
    staff  /staff/  Bhada's own staff: onboarding, review, payouts

  Each app keeps its path prefix, so the four can be served from one domain
  (dist/, dist/app, dist/crew, dist/owner) or each from its own.
*/
const APP = process.env.BHADA_APP || 'site';

const ICONS = (base) => [
  // Chrome on Android will not offer "install" without 192 and 512.
  { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
  { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
  { src: `${base}icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

// The voice clips are the recorded Nepali announcements (scripts/make-voice.mjs):
// a door or a ticket with no signal still has to speak.
const WITH_VOICE = ['**/*.{js,css,html,svg,png,woff2}', 'voice/*.{json,wav,mp3,ogg,webm}'];
const NO_VOICE = ['**/*.{js,css,html,svg,png,woff2}'];

const APPS = {
  site: {
    root: '.',
    base: '/',
    outDir: 'dist',
    port: 5199,
    manifest: false,
    globPatterns: NO_VOICE,
    // An inspector is exactly the person on a bus with no signal, so /inspect
    // is precached. The demo carries Postgres (about 16 MB) and the admin
    // console is an office tool: both are fetched only when opened.
    globIgnores: ['app/**', 'crew/**', 'owner/**', 'staff/**', 'voice/**', '**/Admin-*.js', '**/supabase-*.js', '**/Demo-*.js', '**/demo-*.js', '**/pglite-*.js', '**/stage-*.js', '**/backend-*.js', '**/Demo-*.css'],
    denylist: [/^\/app/, /^\/crew/, /^\/owner/, /^\/staff/, /^\/admin/, /^\/demo/],
  },
  rider: {
    root: 'apps/rider',
    base: '/app/',
    outDir: '../../dist/app',
    port: 5201,
    manifest: {
      name: 'Bhada — ride with no signal',
      short_name: 'Bhada',
      description: 'Transparent bus fares for Kathmandu: your stage fare and a signed receipt, even with no signal.',
      theme_color: '#ffffff',
      background_color: '#ffffff',
    },
    globPatterns: WITH_VOICE,
    // The wallet is online by nature (statement, eSewa). Its chunk and the
    // Supabase client are fetched when opened, not on install.
    globIgnores: ['**/Account-*.js', '**/supabase-*.js'],
    denylist: [/^\/app\/wallet/],
  },
  crew: {
    root: 'apps/crew',
    base: '/crew/',
    outDir: '../../dist/crew',
    port: 5202,
    manifest: {
      name: 'Bhada Crew — the bus in your pocket',
      short_name: 'Bhada Crew',
      description: 'Meter, door and fares for the conductor, all offline.',
      theme_color: '#ffffff',
      background_color: '#ffffff',
    },
    globPatterns: WITH_VOICE,
    // The meter loads the Supabase client only to open a realtime channel,
    // which by definition needs a network.
    globIgnores: ['**/supabase-*.js'],
    denylist: [],
  },
  owner: {
    root: 'apps/owner',
    base: '/owner/',
    outDir: '../../dist/owner',
    port: 5203,
    manifest: {
      name: 'Bhada Owner — every bus, every rupee',
      short_name: 'Bhada Owner',
      description: 'Every bus, every rupee, every conductor, from one screen.',
      theme_color: '#ffffff',
      background_color: '#ffffff',
    },
    globPatterns: NO_VOICE,
    globIgnores: ['voice/**'],
    denylist: [],
  },
  // An office tool on a desk with a connection: installable, but nothing in it
  // works offline, so only the shell is cached.
  staff: {
    root: 'apps/staff',
    base: '/staff/',
    outDir: '../../dist/staff',
    port: 5204,
    manifest: {
      name: 'Bhada Staff',
      short_name: 'Bhada Staff',
      description: 'Onboarding, review and payouts for Bhada staff.',
      theme_color: '#ffffff',
      background_color: '#ffffff',
    },
    globPatterns: NO_VOICE,
    globIgnores: ['voice/**', 'fonts/**'],
    denylist: [],
  },
};

const app = APPS[APP];
if (!app) throw new Error(`BHADA_APP must be one of ${Object.keys(APPS).join(', ')}`);

// In development the site server stands in front of the three app servers, so
// one address shows the whole product the way the deployed domain does.
// It also passes /sync and /local/* to the local backend (npm run sync:local),
// so a phone on the Wi-Fi reaches everything through this one HTTPS address:
// an HTTPS page may not call the backend's plain-HTTP port directly.
const LOCAL_BACKEND = process.env.BHADA_LOCAL_BACKEND || 'http://localhost:8787';
const proxy = APP === 'site'
  ? {
    ...Object.fromEntries(['rider', 'crew', 'owner', 'staff'].map((name) => [`^${APPS[name].base.slice(0, -1)}(/|$)`, { target: `http${HTTPS ? 's' : ''}://localhost:${APPS[name].port}`, ws: true, secure: false, rewrite: (path) => (path === APPS[name].base.slice(0, -1) ? APPS[name].base : path) }])),
    '^/sync$': { target: LOCAL_BACKEND, changeOrigin: true },
    '^/local/': { target: LOCAL_BACKEND, changeOrigin: true },
  }
  : undefined;

export default defineConfig({
  root: app.root,
  base: app.base,
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  // Which build a crash report came from, and which of the four this is.
  define: {
    __BHADA_BUILD__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7)),
    __BHADA_APP__: JSON.stringify(APP),
  },
  server: {
    port: app.port,
    strictPort: true,
    // Reachable from a phone on the same Wi-Fi.
    host: true,
    proxy,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
  },
  plugins: [
    ...(FIXTURES || LOCAL_DB ? [fixturesPlugin] : []),
    react(),
    ...(HTTPS ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      // Everything the app needs offline is precached on install, so a phone in
      // airplane mode can cold-start it.
      workbox: {
        globPatterns: app.globPatterns,
        globIgnores: app.globIgnores,
        navigateFallback: `${app.base}index.html`,
        navigateFallbackDenylist: app.denylist,
        // The Devanagari faces push the precache past the 2MB default, and a
        // font that misses the precache means no Devanagari offline.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: app.manifest && {
        id: app.base,
        start_url: app.base,
        scope: app.base,
        display: 'standalone',
        orientation: 'portrait',
        lang: 'ne',
        icons: ICONS(app.base),
        ...app.manifest,
      },
    }),
  ],
  // PGlite ships its own WebAssembly and must not be pre-bundled; in the build
  // it gets a chunk of its own, so the precache rules can leave it out by name.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: {
    outDir: app.outDir,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@electric-sql/pglite')) return 'pglite';
          return undefined;
        },
      },
    },
  },
});
