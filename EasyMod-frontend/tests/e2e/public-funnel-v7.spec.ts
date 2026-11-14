import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Public funnel V7 — the single delivered-order offer (ADR-0011).
 *
 * The shipped public surfaces no longer expose the retired three-package story
 * (Shuru / Moderator Plus / Partnership), the ৳999 subscription, top-up packs or
 * the Partnership review dialog. This spec pins the single offer instead:
 * BDT 10.00 per provider-confirmed delivered order, read from the public
 * commercial-contract endpoint, with no plan picker and no top-ups.
 *
 * The landing page is a contract-derived surface: prices come from the contract
 * payload and capability statements render through the claim gate. All API
 * traffic is mocked, and the public contract payload must pass the same
 * fail-closed validator the app uses, so a stale price fails this spec.
 */

const screenshots = resolve(process.cwd(), 'test-results', 'v7-public-funnel');
mkdirSync(screenshots, { recursive: true });

const CONTRACT_VERSION = '1.0.0';
const CONTRACT_HASH = `sha256:${'b'.repeat(64)}`;
const REGISTRY_HASH = `sha256:${'a'.repeat(64)}`;

const publicContract = {
  contract_version: CONTRACT_VERSION,
  contract_hash: CONTRACT_HASH,
  model: 'DELIVERED_ORDER',
  currency: 'BDT',
  trigger: 'ORDER_DELIVERED_PROVIDER_CONFIRMED',
  unit_price_minor: 1000,
  unit_price_bdt: 10,
  zero_rated_outcomes: ['RETURNED', 'CANCELLED', 'DRAFT', 'CONFIRMED', 'BOOKED', 'IN_TRANSIT', 'FAILED'],
  subscription_fee_bdt: 0,
  setup_fee_bdt: 0,
  monthly_minimum_bdt: 0,
  conversation_entitlement: null,
  cycle: 'MONTHLY',
  payment: 'POSTPAID',
  due_days: 7,
  on_overdue: {
    blockCourierBooking: true,
    pauseAutomatedAi: true,
    keepInboxReadable: true,
    keepHistoryReadable: true,
    deleteData: false,
  },
  description: {
    en: 'Pay BDT 10.00 per provider-confirmed delivered order. Returned or cancelled orders are billed at BDT 0.00.',
    bn: 'প্রতি প্রোভাইডার-নিশ্চিত ডেলিভারি অর্ডারে ৳১০.০০। রিটার্ন বা বাতিল অর্ডারে ৳০.০০ বিল হয়।',
  },
  registry_hash: REGISTRY_HASH,
  claims: [
    {
      id: 'billing.delivered_order',
      verified_scope: 'global',
      surfaces: ['pricing', 'landing'],
      i18n_key: { en: 'claims.billing.delivered_order.en', bn: 'claims.billing.delivered_order.bn' },
      fallback_i18n_key: null,
    },
  ],
  // The public endpoint carries server-evaluated decisions; the fail-closed
  // validator requires the array. The landing offer price renders from the
  // contract payload, so an empty decision set is a valid anonymous state.
  decisions: [],
};

const publicAddons = [
  {
    code: 'ADS_STUDIO',
    name: 'EasyModerator Ads Studio',
    category: 'advertising',
    availability: 'pilot_approval_required',
    billing_terms: 'not_activated',
    price_bdt_monthly: null,
    summary: 'Import a Meta Ads CSV report, review grounded suggestions and save an explicitly approved draft.',
    limits: ['No direct Meta Ads account connection is claimed.'],
  },
  {
    code: 'STOREFRONT',
    name: 'EasyModerator Storefront',
    category: 'commerce',
    availability: 'pilot_approval_required',
    billing_terms: 'not_activated',
    price_bdt_monthly: null,
    summary: 'Publish selected products and receive validated COD orders in the existing workspace.',
    limits: ['COD only; no online payment verification or courier automation is claimed.'],
  },
];

function claimsForSurface(surface: string | null) {
  return {
    success: true,
    data: {
      surface,
      locale: 'en',
      contractVersion: CONTRACT_VERSION,
      registryHash: REGISTRY_HASH,
      decisions: [
        {
          claimId: 'billing.delivered_order',
          available: true,
          render: 'claim',
          textKey: 'claims.billing.delivered_order.en',
          locale: 'en',
          surface,
          scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
          interpolation: {},
          mode: 'enforce',
          predicate: {
            code_present: true,
            merchant_enabled: true,
            production_verified: true,
            deprecated: false,
            internal_only: false,
            scope_match: true,
          },
          wouldBlock: false,
          contractVersion: CONTRACT_VERSION,
          registryHash: REGISTRY_HASH,
        },
      ],
    },
  };
}

/** Mock every API the public marketing surfaces reach. */
async function mockPublicApi(page: Page, { contractUnavailable = false } = {}) {
  // Pathname predicate, not `**/api/**`: the glob also matches Vite module URLs
  // like /src/api/index.ts and would answer them with JSON.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'access-control-allow-origin': request.headers().origin ?? url.origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Authorization,X-CSRF-Token,Idempotency-Key',
    };
    const json = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: 'application/json', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });

    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/api/csrf') return json(200, { csrfToken: 'v7-preview-csrf' });
    if (url.pathname === '/api/auth/me') return json(401, { success: false, error: { code: 'UNAUTHORIZED' } });
    if (url.pathname === '/api/public/commercial-contract') {
      return contractUnavailable
        ? json(503, { success: false, error: { code: 'UNAVAILABLE', message: 'unavailable' } })
        : json(200, { success: true, data: publicContract });
    }
    if (url.pathname === '/api/public/addons') return json(200, { success: true, data: publicAddons });
    if (url.pathname === '/api/commercial/claims') {
      return json(200, claimsForSurface(url.searchParams.get('surface')));
    }
    if (url.pathname === '/api/analytics/funnel') return json(200, { success: true, data: {} });
    if (url.pathname === '/api/auth/signup' && request.method() === 'POST') {
      return json(201, { success: true, data: { user: {}, shop: {}, currentShop: {}, allShops: [] } }, { 'set-cookie': 'v7-preview-session=1; Path=/; SameSite=Lax' });
    }
    return json(200, { success: true, data: {} });
  });
  await page.route('https://api.easymod.tech/**', (route) => route.abort('blockedbyclient'));
  await page.route('https://app.easymod.tech/**', (route) => route.abort('blockedbyclient'));
}

const RETIRED_COPY = [/৳\s*999/, /\btop-?ups?\b/i, /Moderator Plus/i, /Partnership/i, /Get Your Moderator/i, /\bShuru\b/i];

async function expectNoRetiredOffer(page: Page) {
  for (const pattern of RETIRED_COPY) {
    await expect(page.getByText(pattern)).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /request partnership review/i })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const HERO_EN = 'From Messenger messages to delivered orders — one ledger';

test.describe('EasyModerator public funnel V7 — single delivered-order offer (mocked API only)', () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicApi(page);
  });

  test('renders the contract-derived offer and keeps the responsive layout intact', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    for (const width of [1440, 1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?lang=en');
      await expect(page.getByRole('heading', { level: 1, name: HERO_EN })).toBeVisible();
      await expect(page.getByText('4 places → 1 ledger')).toBeVisible();

      // One offer. The contract price is read from the mocked public endpoint,
      // and renders in the price section, the hero and the close.
      await expect(page.locator('#plans')).toBeVisible();
      await expect(page.getByTestId('lv7-unit-price')).toHaveText('৳10.00');
      await expect(page.locator('#plans')).toContainText(/per delivered order/i);
      await expect(page.getByTestId('lv7-hero-price')).toContainText('৳10.00');
      await expect(page.getByTestId('lv7-close-price')).toContainText('৳10.00');
      await expectNoRetiredOffer(page);

      // No horizontal overflow at any of the target widths (including 320px).
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(dimensions.page, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);

      await page.screenshot({ path: resolve(screenshots, `landing-en-${width}.png`), fullPage: true });
    }

    // Desktop-only navigation + skip link behaviours.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?lang=en');
    const skip = page.getByRole('link', { name: /skip to content/i });
    await skip.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#public-funnel-main')).toBeFocused();

    await page.goto('/?lang=en');
    await page.getByRole('navigation', { name: /primary navigation/i }).getByRole('link', { name: /^plans$/i }).click();
    await expect(page).toHaveURL(/#plans$/);
    await expect(page.getByTestId('lv7-unit-price')).toBeVisible();

    await page.goto('/?lang=en');
    await page.getByRole('link', { name: /create your account/i }).first().click();
    await expect(page).toHaveURL(/\/signup\?lang=en/);

    expect(pageErrors).toEqual([]);
  });

  test('switches languages and keeps the mobile menu usable at 390px and 320px', async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?lang=en');
      const menuToggle = page.locator('button[aria-controls="public-funnel-navigation"]');
      await expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#public-funnel-navigation')).toBeHidden();
      await page.getByRole('button', { name: /open navigation/i }).click();
      await expect(page.getByRole('button', { name: /close navigation/i })).toHaveAttribute('aria-expanded', 'true');
      await page.getByRole('button', { name: /switch to bengali/i }).click();

      await expect(page.getByRole('heading', { level: 1, name: 'মেসেঞ্জারের মেসেজ থেকে ডেলিভারি — সব এক খাতায়' })).toBeVisible();
      await expect(page.getByText('৪ জায়গা → ১ খাতা')).toBeVisible();
      await expect(page.getByTestId('lv7-unit-price')).toContainText('৳১০.০০');
      await expect(page.locator('html')).toHaveAttribute('lang', 'bn');
      await expectNoRetiredOffer(page);

      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);

      await page.screenshot({ path: resolve(screenshots, `landing-bn-${width}.png`), fullPage: true });
      await menuToggle.click();
      await expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('pricing renders the contract price with no plan picker, top-ups or Partnership flow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const contractResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/public/commercial-contract',
    );
    await page.goto('/pricing?lang=en');
    const contractResponse = await contractResponsePromise;
    expect(contractResponse.status(), await contractResponse.text()).toBe(200);

    await expect(page.getByRole('heading', { level: 1, name: /pay only for delivered orders/i })).toBeVisible();
    const offer = page.locator('article[aria-labelledby="delivered-order-offer"]');
    await expect(page.getByRole('heading', { name: 'Delivered-order billing', exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="commercial-unit-price"]')).toHaveText('৳10.00');
    await expect(offer).toContainText(/per delivered order/i);
    await expect(offer).toContainText(/No subscription, setup fee or monthly minimum/i);
    await expect(offer).toContainText(/Returned or cancelled orders are billed at ৳0.00/i);
    await expect(offer).toContainText(/due within 7 days/i);
    await expect(page.getByText(/Contract version 1\.0\.0/)).toBeVisible();
    await expect(page.locator('article[data-contract-version="1.0.0"]')).toHaveAttribute('data-contract-hash', CONTRACT_HASH);

    await expectNoRetiredOffer(page);
    await expect(offer.getByRole('radio')).toHaveCount(0);
    await expect(offer.getByRole('combobox')).toHaveCount(0);

    await expect(page.getByRole('heading', { name: 'Choose only the pilot tools your shop needs', exact: true })).toBeVisible();
    await expect(page.locator('section[aria-labelledby="optional-addons-title"] article')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'EasyModerator Ads Studio', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'EasyModerator Storefront', exact: true })).toBeVisible();

    const cta = page.getByRole('link', { name: /create an easymoderator account/i });
    await expect(cta).toHaveAttribute('href', /\/signup\?lang=en$/);
    await page.screenshot({ path: resolve(screenshots, 'pricing-en-1280.png'), fullPage: true });
  });

  test('shows an error and never substitutes a pinned price when the public contract is unavailable', async ({ page }) => {
    await mockPublicApi(page, { contractUnavailable: true });
    await page.goto('/pricing?lang=en');
    await expect(page.getByRole('alert')).toContainText(/current pricing is unavailable/i);
    await expect(page.getByText('৳10.00')).toHaveCount(0);
    await expect(page.getByText('৳999')).toHaveCount(0);
    await page.getByRole('button', { name: /retry/i }).click();
    await expect(page.getByRole('alert')).toContainText(/current pricing is unavailable/i);
  });

  test('landing and pricing screens have no WCAG 2.1 A/AA violations in English or Bengali', async ({ page }) => {
    for (const path of ['/?lang=en', '/pricing?lang=en', '/?lang=bn', '/pricing?lang=bn']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const violations = results.violations.map(({ id, impact, description, nodes }) => ({
        id,
        impact,
        description,
        nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
      }));
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    }
  });
});