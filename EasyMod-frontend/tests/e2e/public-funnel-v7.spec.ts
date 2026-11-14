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
 * All API traffic is mocked. The public contract payload must pass the same
 * fail-closed validator the app uses, so a stale price would fail this spec.
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
  const user = { id: 'v7-preview-user', email: 'v7-preview@example.invalid', full_name: 'V7 Preview Merchant', role: 'MERCHANT', shop_id: 'v7-preview-shop' };
  const shop = { id: 'v7-preview-shop', code: 'V7TEST', shop_name: 'V7 Preview Shop' };

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
      return json(201, { success: true, data: { user, shop, currentShop: shop, allShops: [shop] } }, { 'set-cookie': 'v7-preview-session=1; Path=/; SameSite=Lax' });
    }
    if (url.pathname === '/api/auth/signin' && request.method() === 'POST') {
      return json(200, { success: true, data: { user, shop, currentShop: shop, allShops: [shop] } }, { 'set-cookie': 'v7-preview-session=1; Path=/; SameSite=Lax' });
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

test.describe('EasyModerator public funnel V7 — single delivered-order offer (mocked API only)', () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicApi(page);
  });

  test('renders the single delivered-order offer and keeps the responsive layout intact', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    for (const width of [1440, 1280, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?lang=en');
      const heroHeading = page.getByRole('heading', { level: 1, name: 'From Messenger messages to orders, from ad reports to clearer decisions—all in one dashboard.' });
      await expect(heroHeading).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Core tools today. Extra tools by approval.', exact: true })).toBeVisible();

      // One offer. The contract price is read from the mocked public endpoint.
      const offer = page.locator('#plans article[data-contract-version="1.0.0"]');
      await expect(offer).toHaveCount(1);
      await expect(offer.getByRole('heading', { name: 'Delivered-order billing', exact: true })).toBeVisible();
      await expect(page.locator('[data-testid="landing-unit-price"]')).toHaveText('৳10.00');
      await expect(page.locator('#plans')).toContainText(/provider-confirmed delivered order/i);
      await expect(page.locator('#plans')).toContainText(/No subscription, setup fee or monthly minimum/i);
      await expectNoRetiredOffer(page);

      // Add-on pilots remain explicit and separately gated.
      await expect(page.getByRole('heading', { name: 'EasyModerator Ads Studio', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'EasyModerator Storefront', exact: true })).toBeVisible();
      await expect(page.locator('#plans article')).toHaveCount(3); // offer + 2 add-on pilots

      await expect(page.getByText('Your Business. Our Technology. Forward, Together.')).toBeVisible();
      await expect(page.locator('#feature-bar')).toContainText(/Ads Studio \+ Storefront/i);
      await expect(page.locator('#feature-bar')).toContainText(/pilot approval is required/i);
      await expect(page.locator('#capabilities article')).toHaveCount(5);
      const painTitles = await page.locator('#capabilities article h3').allTextContents();
      expect(painTitles).toEqual([
        "Business is growing, but the work isn't shrinking?",
        'Drowning in messages?',
        'Want to reduce fake orders?',
        'Worried about wasted ad spend?',
        'Cash not adding up?',
      ]);
      await expect(page.locator('#capabilities article').nth(2)).toContainText(/not proof of fraud or a delivery guarantee/i);
      await expect(page.locator('#capabilities article').nth(3)).toContainText(/merchant-supplied Meta CSV/i);
      await expect(page.locator('#capabilities article').nth(3)).toContainText(/No direct Meta ad-account connection/i);
      await expect(page.locator('#capabilities article').nth(3)).toContainText(/ROAS\/profit\/order attribution/i);
      await expect(page.locator('#capabilities article').nth(4)).toContainText(/verify actual receipt manually/i);
      await expect(page.locator('#capabilities article').nth(4)).toContainText(/no online payment verification, courier automation or cash reconciliation/i);

      const sectionIndexes = await page.locator('#public-funnel-main').evaluate((main) =>
        ['.landing-v6-hero', '#feature-bar', '#workflow', '#capabilities', '.landing-v6-story']
          .map((selector) => Array.from(main.children).indexOf(main.querySelector(selector)!)),
      );
      expect(sectionIndexes.every((index) => index >= 0)).toBe(true);
      expect(sectionIndexes).toEqual([...sectionIndexes].sort((left, right) => left - right));

      const skip = page.getByRole('link', { name: /skip to content/i });
      await skip.focus();
      await page.keyboard.press('Enter');
      const main = page.locator('#public-funnel-main');
      await expect(main).toBeFocused();
      const [mainTop, stickyHeaderHeight] = await Promise.all([
        main.evaluate((element) => element.getBoundingClientRect().top),
        page.locator('header.funnel-header').evaluate((element) => element.getBoundingClientRect().height),
      ]);
      expect(mainTop).toBeGreaterThanOrEqual(stickyHeaderHeight - 1);

      const workflowFigure = page.getByRole('figure', { name: /illustrative Messenger reply and order review workflow/i });
      await expect(workflowFigure).toContainText('AI-assisted reply');
      await expect(workflowFigure).toContainText(/draft.*not sent/i);

      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(dimensions.page, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport);

      await page.screenshot({ path: resolve(screenshots, `landing-en-${width}.png`), fullPage: true });
      await page.getByRole('link', { name: /see the three steps/i }).click();
      await expect(page).toHaveURL(/#workflow$/);
      await page.goto('/?lang=en');
      await page.getByRole('link', { name: /create your easymoderator account/i }).first().click();
      await expect(page).toHaveURL(/\/signup\?lang=en/);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?lang=en');
    await page.getByRole('link', { name: /create your easymoderator account/i }).first().click();
    await expect(page).toHaveURL(/\/signup\?lang=en/);
    await expect(page.getByRole('heading', { name: /create your EasyModerator account/i })).toBeVisible();

    await page.goto('/?lang=en');
    await page.getByRole('link', { name: /see the three steps/i }).click();
    await expect(page).toHaveURL(/#workflow$/);
    await page.getByRole('navigation', { name: /primary navigation/i }).getByRole('link', { name: /^plans$/i }).click();
    await expect(page).toHaveURL(/#plans$/);
    await expect(page.locator('#plans article[data-contract-version="1.0.0"]')).toHaveCount(1);

    await page.goto('/?lang=en');
    const billingFaq = page.locator('details').filter({ hasText: /How does a new account get billed\?/i });
    await billingFaq.locator('summary').click();
    await expect(billingFaq).toContainText(/billed per provider-confirmed delivered order/i);
    await page.getByRole('link', { name: /sign in/i }).first().click();
    await expect(page).toHaveURL(/\/signin\?lang=en/);
    await expect(page.getByRole('heading', { name: /sign in to EasyModerator/i })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('switches languages and keeps the mobile menu usable at 390px and 320px', async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?lang=en');
      const menuToggle = page.locator('button[aria-controls="public-funnel-navigation"]');
      const controlledMenu = page.locator('#public-funnel-navigation');
      await expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(controlledMenu).toHaveCount(1);
      await expect(controlledMenu).toBeHidden();
      await page.getByRole('button', { name: /open navigation/i }).click();
      await expect(page.getByRole('button', { name: /close navigation/i })).toHaveAttribute('aria-expanded', 'true');
      await page.getByRole('button', { name: /switch to bengali/i }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'মেসেঞ্জারের মেসেজ থেকে অর্ডার, বিজ্ঞাপনের রিপোর্ট থেকে সিদ্ধান্ত—সব এক ড্যাশবোর্ডে' })).toBeVisible();
      await expect(page.getByText('আপনার ব্যবসা। আমাদের প্রযুক্তি। এগিয়ে চলি একসাথে।')).toBeVisible();
      const painTitles = await page.locator('#capabilities article h3').allTextContents();
      expect(painTitles).toEqual([
        'ব্যবসা বাড়ছে, কিন্তু কাজ কমছে না?',
        'মেসেজে ডুবে যাচ্ছেন?',
        'ফেক অর্ডার কমাতে চান?',
        'বিজ্ঞাপনের টাকা অপচয়?',
        'ক্যাশ মিলছে না?',
      ]);
      await expect(page.locator('#capabilities article').nth(3)).toContainText(/সরাসরি Meta ad-account সংযোগ নয়/i);
      await expect(page.locator('#capabilities article').nth(4)).toContainText(/cash reconciliation নেই/i);
      await expect(page.locator('#capabilities article').nth(3).getByRole('link')).toHaveAttribute('href', /\/signin\?lang=bn$/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'bn');

      const commercialSection = page.locator('#plans');
      await expect(commercialSection.locator('article[data-contract-version="1.0.0"]')).toHaveCount(1);
      await expect(commercialSection.getByRole('heading', { name: 'ডেলিভারি অর্ডার বিলিং', exact: true })).toBeVisible();
      await expect(page.locator('[data-testid="landing-unit-price"]')).toContainText('৳১০.০০');
      await expectNoRetiredOffer(page);

      await expect(menuToggle).toHaveAttribute('aria-expanded', 'true');
      await menuToggle.click();
      await expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(controlledMenu).toBeHidden();
      await page.screenshot({ path: resolve(screenshots, `landing-bn-${width}.png`), fullPage: true });
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport);
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
    // No plan-selection control remains on the public offer.
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