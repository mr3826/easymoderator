import { defineConfig } from '@playwright/test';

const PW_HOST = process.env.PLAYWRIGHT_HOST || 'localhost';
const PW_PORT = Number(process.env.PLAYWRIGHT_PORT || '4273');
const PW_BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://${PW_HOST}:${PW_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Live-stack founder walkthrough is run explicitly, never in CI/e2e sweeps
  // (it needs the seeded lab servers): set PW_WALKTHROUGH=1 to include it.
  testIgnore: process.env.PW_WALKTHROUGH ? [] : /walkthrough/,
  fullyParallel: true,
  // 30s left no headroom for shared-dev-server transform latency on slower
  // local machines (journey 9 measured ~27s cold). Assertions unchanged.
  timeout: 60_000,
  expect: {
    timeout: 20_000,
  },
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: PW_BASE_URL,
    storageState: {
      cookies: [],
      origins: [{
        origin: PW_BASE_URL,
        localStorage: [{ name: 'easymod_lang', value: 'en' }],
      }],
    },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host ${PW_HOST} --port ${PW_PORT}`,
    url: PW_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_API_BASE_URL: '/api',
      VITE_APP_URL: PW_BASE_URL,
      VITE_MARKETING_URL: PW_BASE_URL,
      VITE_BKASH_ENABLED: 'false',
      VITE_BKASH_SANDBOX: 'false',
      VITE_ENV: 'development',
    },
  },
});
