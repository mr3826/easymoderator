import { expect, test, type Page } from '@playwright/test';

/**
 * Facebook Login for Business authorization contract — browser proof.
 *
 * Incident 2026-09-22: production opened a classic Facebook Login dialog
 * (`scope=...`, no `config_id`) against an app Meta serves as Facebook Login
 * for Business, and merchants saw only "Feature unavailable".
 * See docs/incidents/2026-09-22-meta-login-unavailable.md.
 *
 * SCOPE OF THIS TEST. This is the mock-boundary half of the proof: it asserts
 * that the merchant journey reaches a Facebook dialog and that the frontend
 * opens the backend's authorization URL in a popup **verbatim** — no rewriting,
 * no dropped or added parameters. It deliberately does NOT prove that the
 * backend emits the right URL; that is pinned by the backend suite
 * (MetaMessengerProvider.test.js) and proven against real production in the
 * incident record. A mock-only browser test is not production OAuth proof.
 *
 * AUTH_URL below is the exact contract the backend is pinned to emit, so if the
 * backend contract changes without this file changing, the two proofs disagree
 * and the divergence is visible in review.
 */

const APP_ID = '2040799330176198';
const CONFIG_ID = '1685388446490514';
const REDIRECT_URI = 'https://app.easymod.tech/channels/oauth-callback';
// Preserved in the Meta dashboard, but NOT the merchant login path. It must
// never reach the dialog.
const SYSTEM_USER_CONFIG_ID = '35885387384409543';
const STATE = `facebook:shop-1:user-1:${'a'.repeat(32)}`;

const AUTH_URL =
  'https://www.facebook.com/v22.0/dialog/oauth'
  + `?client_id=${APP_ID}`
  + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
  + `&config_id=${CONFIG_ID}`
  + '&response_type=code'
  + `&state=${encodeURIComponent(STATE)}`;

const mockUser = {
  id: 'user-1',
  full_name: 'Test Owner',
  email: 'owner@shop.bd',
};

const mockShop = {
  id: 'shop-1',
  unique_code: 'SHOP1',
  shop_name: 'OAuth Contract Shop',
  role: 'owner',
  settings: { onboarding_completed: true },
};

function jsonResponse(data: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  };
}

function isKnownApiPath(path: string): boolean {
  return [
    '/api/csrf',
    '/api/auth/me',
    '/api/auth/signin',
    '/api/setup/status',
    '/api/dashboard/metrics',
    '/api/dashboard/queue',
    '/api/order',
    '/api/subscription',
    '/api/notifications/in-app',
    '/api/notifications/telegram',
    '/api/shop/business-info',
    '/api/shop/ai-settings',
    '/api/conversation',
    '/api/conversation/events',
    '/api/templates',
    '/api/channels/meta',
    '/api/channels/meta/oauth/initiate',
    '/api/audit',
  ].includes(path);
}

async function setupRoutes(page: Page) {
  let authenticated = false;
  const initiateCalls: string[] = [];

  await page.addInitScript(() => {
    window.localStorage.setItem('easymod_lang', 'en');
    window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
    window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
  });

  // The Facebook dialog is never really contacted: serve a stand-in so the
  // popup still resolves to the real authorization URL. This is registered on
  // the CONTEXT, not the page: the dialog opens in a popup, which is a separate
  // Page, and a page-level route would let the request reach Facebook for real
  // (it answers with a redirect to /login.php, losing the parameters).
  await page.context().route(
    (url) => new URL(url).hostname === 'www.facebook.com',
    (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><h1>Facebook login dialog (intercepted)</h1></body></html>',
    }),
  );

  // Keep the fallback API-only. A broad glob also matches Vite's /src/api
  // modules and prevents the application bundle from loading.
  await page.route(
    (url) => {
      const path = new URL(url).pathname;
      return path.startsWith('/api/') && !isKnownApiPath(path);
    },
    (route) => route.fulfill(jsonResponse({})),
  );

  await page.route(
    (url) => isKnownApiPath(new URL(url).pathname),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();

      if (path === '/api/csrf' && method === 'GET') {
        return route.fulfill(jsonResponse({ csrfToken: 'csrf-test' }));
      }

      if (path === '/api/auth/signin' && method === 'POST') {
        authenticated = true;
        return route.fulfill(jsonResponse({
          user: mockUser, currentShop: mockShop, allShops: [mockShop],
        }));
      }

      if (path === '/api/auth/me' && method === 'GET') {
        return route.fulfill(authenticated
          ? jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] })
          : { status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) });
      }

      if (path === '/api/subscription' && method === 'GET') {
        return route.fulfill(jsonResponse({
          subscription: {
            plan_code: 'SHURU',
            plan_name: 'Shuru',
            features: {
              image_understanding: false,
              advanced_ai: false,
              priority_support: false,
              custom_branding: false,
            },
          },
        }));
      }

      // No Page connected yet, so the connect card renders.
      if (path === '/api/channels/meta' && method === 'GET') {
        return route.fulfill(jsonResponse([]));
      }

      // The endpoint under test. Returns the exact URL the backend is pinned to
      // build; the assertions check the browser opens it unchanged.
      if (path === '/api/channels/meta/oauth/initiate' && method === 'POST') {
        initiateCalls.push(request.postData() || '');
        return route.fulfill(jsonResponse({ redirectUrl: AUTH_URL, state: STATE }));
      }

      if (path === '/api/conversation/events' && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'retry: 10000\n\n',
        });
      }

      return route.fulfill(jsonResponse({}));
    },
  );

  return { initiateCalls };
}

async function loginAndGo(page: Page, path: string): Promise<void> {
  await page.goto('/signin');
  await page.getByLabel(/email/i).fill(mockUser.email);
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(path);
}

test('Connect Facebook Page opens a Login for Business dialog with config_id and no scope', async ({ page }) => {
  const fixture = await setupRoutes(page);
  // ADR-0013 §9: /manage-shop/chat-settings redirects to the channel
  // workspace. With no connected Page the overview shows its empty-state CTA,
  // which reveals the extracted connection manager (the connect flow under test).
  await loginAndGo(page, '/manage-shop/channels');
  await expect(page).toHaveURL(/\/manage-shop\/channels$/);

  const reveal = page.getByRole('button', { name: 'Connect a Page' });
  if (await reveal.count()) await reveal.click();

  const connect = page.getByRole('button', { name: /Connect Facebook Page/i }).first();
  await expect(connect).toBeVisible();

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    connect.click(),
  ]);
  await popup.waitForLoadState('domcontentloaded');

  // The merchant action actually asked the backend to start OAuth.
  expect(fixture.initiateCalls).toHaveLength(1);

  const opened = new URL(popup.url());

  // Reaches Facebook's dialog, on the shared Graph version.
  expect(opened.origin).toBe('https://www.facebook.com');
  expect(opened.pathname).toBe('/v22.0/dialog/oauth');

  // The Facebook Login for Business contract.
  expect(opened.searchParams.get('client_id')).toBe(APP_ID);
  expect(opened.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  expect(opened.searchParams.get('config_id')).toBe(CONFIG_ID);
  expect(opened.searchParams.get('response_type')).toBe('code');

  // The regression guards for the outage.
  expect(opened.searchParams.has('scope')).toBe(false);
  expect(opened.searchParams.has('override_default_response_type')).toBe(false);
  expect(popup.url()).not.toContain(SYSTEM_USER_CONFIG_ID);

  // CSRF state is present, non-empty and passed through untouched.
  expect(opened.searchParams.get('state')).toBe(STATE);
  expect((opened.searchParams.get('state') || '').length).toBeGreaterThan(20);

  // Nothing beyond the agreed parameter set reaches Meta.
  expect([...opened.searchParams.keys()].sort()).toEqual([
    'client_id',
    'config_id',
    'redirect_uri',
    'response_type',
    'state',
  ]);

  // The frontend opens the backend's URL verbatim.
  expect(popup.url()).toBe(AUTH_URL);

  await popup.close();
});
