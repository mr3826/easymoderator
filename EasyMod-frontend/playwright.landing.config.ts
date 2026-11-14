import { defineConfig } from '@playwright/test';

/**
 * Contract-derived landing E2E (ADR-0011).
 *
 * The public contract + claim-decision endpoints are mocked per test with
 * page.route, so no backend or provider evidence is required. retries stay 0 —
 * a truth failure must be a real failure, never a retried flake. The bare
 * `npx playwright test tests/landing/` form runs nothing under the default
 * config (testDir ./tests/e2e), so this config is the entry point.
 */

const host = '127.0.0.1';
const port = 4277;
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: './tests/landing',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/landing',
  use: {
    baseURL,
    locale: 'en',
    storageState: {
      cookies: [],
      origins: [{ origin: baseURL, localStorage: [{ name: 'easymod_lang', value: 'en' }] }],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --host ${host} --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_API_BASE_URL: '/api',
      VITE_APP_URL: baseURL,
      VITE_MARKETING_URL: baseURL,
      VITE_BKASH_ENABLED: 'false',
      VITE_ENV: 'development',
    },
  },
});