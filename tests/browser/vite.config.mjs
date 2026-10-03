import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', includeAssets: [], manifest: false, workbox: { navigateFallback: 'tests/browser/index.html', globPatterns: ['**/*.{html,js,css}'] } })],
  define: { 'import.meta.env.VITE_BROWSER_TESTS': JSON.stringify('1'), 'import.meta.env.VITE_LOCAL_DB_URL': JSON.stringify('/'), 'import.meta.env.VITE_SYNC_URL': JSON.stringify('/sync') },
  build: { outDir: '.bench/browser-build', rollupOptions: { input: 'tests/browser/index.html' } },
  preview: { port: 5310, strictPort: true, proxy: { '/sync': 'http://localhost:8890', '/local': 'http://localhost:8890' } },
});
