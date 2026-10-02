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

const FIXTURE_MODULE = fileURLToPath(new URL('./src/lib/supabase-fixtures.js', import.meta.url));

// A resolver rather than an alias: every portal imports the client relatively
// (`../../lib/supabase`), and an alias matches the specifier that was written
// rather than the file it lands on.
const fixturesPlugin = {
  name: 'bhada-supabase-fixtures',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!source.includes('lib/supabase') || source.includes('supabase-fixtures')) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!resolved) return null;
    return resolved.id.split('\\').join('/').endsWith('/src/lib/supabase.js') ? FIXTURE_MODULE : null;
  },
};

export default defineConfig({
  // Which build a crash report came from. Vercel sets the commit it built.
  define: {
    __BHADA_BUILD__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7)),
  },
  plugins: [
    ...(FIXTURES ? [fixturesPlugin] : []),
    react(),
    ...(HTTPS ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      // Everything the app needs offline is precached on install, so a phone in
      // airplane mode can cold-start the app.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The operator dashboard is an office tool that always has a network.
        // Precaching it would make every conductor phone download Recharts and
        // the Supabase client before it could go offline, which is exactly
        // backwards. It is fetched on demand instead.
        // Same argument for the Supabase client itself: the meter console and
        // the door terminals load it only to open a realtime channel, which is
        // by definition something that needs a network. Precaching it would
        // make every device download 220 KB it can never use offline.
        globIgnores: ['**/Operator-*.js', '**/Account-*.js', '**/Admin-*.js', '**/supabase-*.js', '**/Demo-*.js', '**/demo-*.js', '**/pglite-*.js', '**/stage-*.js', '**/backend-*.js', '**/Demo-*.css'],
        navigateFallback: 'index.html',
        // /operator must reach the network for its chunk rather than being
        // served the cached shell when the dashboard has never been opened.
        navigateFallbackDenylist: [/^\/operator/, /^\/admin/, /^\/app\/account/, /^\/demo/],
        // The Devanagari faces push the precache past the 2MB default, and a
        // font that misses the precache means no Devanagari offline.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: 'Bhada — bus fare with no signal',
        short_name: 'Bhada',
        description: 'Pay and collect Nepali bus fares with both phones offline.',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        lang: 'ne',
        background_color: '#16130f',
        theme_color: '#a8202f',
        // Chrome on Android will not offer "install" without 192 and 512.
        // No install means no offline cold start, which is the product.
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // PGlite ships its own WebAssembly and must not be pre-bundled; in the build
  // it gets a chunk of its own, so the precache rules can leave it out by name.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: {
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
