import { defineConfig } from '@playwright/test';

/**
 * Truth-gate E2E (ADR-0011).
 *
 * Deterministic by design: the claim-decision and public-contract APIs are
 * mocked per test with page.route, so no backend, database or live provider
 * evidence is required. retries stay 0 — a truth-gate failure must be a real
 * failure, never a retried flake.
 */

const host = '127.0.0.1';
const port = 4276;
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: './tests/truth-gate',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/truth-gate',
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