import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 45000, workers: 1,
  use: { baseURL: 'http://localhost:5310', headless: true, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npx vite --config tests/browser/vite.config.mjs --port 5320 --strictPort', url: 'http://localhost:5320/tests/browser/index.html', timeout: 60000, reuseExistingServer: false },
    { command: 'node tests/browser/backend.mjs', url: 'http://localhost:8890/health', timeout: 60000, reuseExistingServer: false },
    { command: 'npx vite build --config tests/browser/vite.config.mjs && npx vite preview --config tests/browser/vite.config.mjs', url: 'http://localhost:5310/tests/browser/index.html', timeout: 60000, reuseExistingServer: false },
  ],
});
