import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Contract-derived landing — B-series acceptance (ADR-0011).
 *
 * Only the network is mocked; the real <ClaimProvider surface="landing"> and
 * <Claim> nodes render, so these assertions exercise the shipped component
 * contract: render:'none' => DOM ABSENCE (toHaveCount(0)), never a hidden CSS
 * state.
 */

const CONTRACT_VERSION = '1.0.0';
const CONTRACT_HASH = `sha256:${'b'.repeat(64)}`;
const REGISTRY_HASH = `sha256:${'a'.repeat(64)}`;

const publicPayload = {
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
    blockCourierBooking: true, pauseAutomatedAi: true, keepInboxReadable: true,
    keepHistoryReadable: true, deleteData: false,
  },
  description: { en: '৳10.00 per delivered order.', bn: 'প্রতি ডেলিভারি অর্ডারে ৳১০.০০।' },
};

type Render = 'claim' | 'fallback' | 'none';
interface Plan { render: Render; available: boolean; textKey: string | null; productionVerified?: boolean; scopeMatch?: boolean }

const BASE: Record<string, Plan> = {
  'price.unit': { render: 'claim', available: true, textKey: 'claims.price.unit.en' },
  'price.zero': { render: 'claim', available: true, textKey: 'claims.price.zero.en' },
  'price.nosub': { render: 'claim', available: true, textKey: 'claims.price.nosub.en' },
  'courier.booking': { render: 'fallback', available: false, textKey: 'claims.courier.booking.fallback.en', productionVerified: false, scopeMatch: false },
  'courier.payout': { render: 'claim', available: true, textKey: 'claims.courier.payout.en', productionVerified: true, scopeMatch: false },
  'rto.verify': { render: 'fallback', available: false, textKey: 'claims.rto.verify.fallback.en', productionVerified: false },
  'voice.transcribe': { render: 'fallback', available: false, textKey: 'claims.voice.transcribe.fallback.en', productionVerified: false },
  'ai.notrain': { render: 'claim', available: true, textKey: 'claims.ai.notrain.en' },
  'order.fromchat': { render: 'fallback', available: false, textKey: 'claims.order.fromchat.fallback.en', productionVerified: false },
  'customer.ledger': { render: 'fallback', available: false, textKey: 'claims.customer.ledger.fallback.en', productionVerified: false },
  'knowledge.gaps': { render: 'fallback', available: false, textKey: 'claims.knowledge.gaps.fallback.en', productionVerified: false },
  'queue.priority': { render: 'fallback', available: false, textKey: 'claims.queue.priority.fallback.en', productionVerified: false },
  'handoff.human': { render: 'fallback', available: false, textKey: 'claims.handoff.human.fallback.en', productionVerified: false },
};

function buildDecisions(overrides: Record<string, Partial<Plan>> = {}) {
  return Object.entries(BASE).map(([id, base]) => {
    const p = { ...base, ...overrides[id] };
    return {
      claimId: id,
      available: p.available,
      render: p.render,
      textKey: p.textKey,
      locale: 'en',
      surface: 'landing',
      scope: {
        claimedProviders: id === 'courier.payout' ? ['pathao', 'steadfast', 'redx'] : null,
        verifiedProviders: id === 'courier.payout' ? ['steadfast'] : null,
        match: p.scopeMatch ?? true,
        text: null,
      },
      interpolation: {
        unitPrice: '৳10.00', unitPriceBn: '৳১০.০০', zeroAmount: '৳0.00', zeroAmountBn: '৳০.০০',
        providerCount: '1', providerCountBn: '১',
      },
      mode: 'enforce',
      predicate: {
        code_present: true, merchant_enabled: true,
        production_verified: p.productionVerified ?? true,
        deprecated: false, internal_only: false, scope_match: p.scopeMatch ?? true,
      },
      wouldBlock: false,
      contractVersion: CONTRACT_VERSION,
      registryHash: REGISTRY_HASH,
    };
  });
}

const claimDescriptors = Object.keys(BASE).map((id) => ({
  id,
  verified_scope: 'global',
  surfaces: ['landing'],
  i18n_key: { en: `claims.${id}.en`, bn: `claims.${id}.bn` },
  fallback_i18n_key: { en: `claims.${id}.fallback.en`, bn: `claims.${id}.fallback.bn` },
}));

async function mockApi(page: Page, overrides: Record<string, Partial<Plan>> = {}) {
  const decisions = buildDecisions(overrides);
  const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (p === '/api/csrf') return route.fulfill({ status: 200, headers, body: JSON.stringify({ success: true, data: { token: 't' } }) });
    if (p === '/api/auth/me') return route.fulfill({ status: 401, headers, body: JSON.stringify({ success: false }) });
    if (p === '/api/public/commercial-contract') {
      const surface = url.searchParams.get('surface');
      const filtered = surface ? decisions.filter((d) => d.surface === surface) : decisions;
      return route.fulfill({
        status: 200, headers,
        body: JSON.stringify({
          success: true,
          data: { ...publicPayload, registry_hash: REGISTRY_HASH, claims: claimDescriptors, decisions: filtered },
        }),
      });
    }
    if (p === '/api/analytics/funnel') return route.fulfill({ status: 200, headers, body: JSON.stringify({ success: true }) });
    return route.fulfill({ status: 200, headers, body: JSON.stringify({ success: true, data: {} }) });
  });
  await page.route('https://api.easymod.tech/**', (r) => r.abort());
  await page.route('https://app.easymod.tech/**', (r) => r.abort());
}

async function openLanding(page: Page, overrides: Record<string, Partial<Plan>> = {}) {
  await mockApi(page, overrides);
  await page.goto('/');
  await page.waitForSelector('[data-testid="lv7-unit-price"]');
}

test('renders every price from the contract and gates capability claims', async ({ page }) => {
  await openLanding(page);
  await expect(page.getByTestId('lv7-unit-price')).toHaveText('৳10.00');
  await expect(page.locator('[data-claim-id="price.unit"]')).toHaveCount(1);
  await expect(page.locator('[data-claim-id="price.unit"]')).toHaveAttribute('data-contract-version', CONTRACT_VERSION);
  // B5: payout scoped to one verified provider, brand-free count copy.
  await expect(page.locator('[data-claim-id="courier.payout"]')).toContainText('1 courier service');
  // Capability claims fall back truthfully.
  await expect(page.locator('[data-claim-id="rto.verify"]')).toHaveAttribute('data-claim-render', 'fallback');
});

test('B3 — price.zero failing closed is DOM-absent (not hidden)', async ({ page }) => {
  await openLanding(page, { 'price.zero': { render: 'none', available: false, textKey: null } });
  await expect(page.locator('[data-claim-id="price.zero"]')).toHaveCount(0);
  await expect(page.getByTestId('lv7-zero-mark')).toHaveCount(0);
});

test('B4 — price.nosub failing closed is DOM-absent', async ({ page }) => {
  await openLanding(page, { 'price.nosub': { render: 'none', available: false, textKey: null } });
  await expect(page.locator('[data-claim-id="price.nosub"]')).toHaveCount(0);
});

test('B6 — no third-party brand token is rendered', async ({ page }) => {
  await openLanding(page);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/pathao|steadfast|redx|bkash|nagad|whatsapp|instagram|shopify|woocommerce|telegram|daraz|amazon/i);
});

test('B7 — mock data carries a sample label at 360px and 1440px', async ({ page }) => {
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openLanding(page);
    await expect(page.getByText(/not a real customer or order/i).first()).toBeVisible();
    await page.screenshot({ path: `test-results/landing/landing-${width}.png`, fullPage: true });
  }
});

test('B8 — FAQ, calculator and sticky CTA are keyboard operable', async ({ page }) => {
  await openLanding(page);
  // FAQ toggles with the keyboard.
  const summary = page.locator('.lv7-faq summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.lv7-faq details').first()).toHaveAttribute('open', '');
  // Calculator slider responds to arrow keys.
  const slider = page.locator('input[type="range"]').first();
  await slider.focus();
  const before = await slider.inputValue();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => slider.inputValue()).not.toBe(before);
  // Sticky CTA exists and is a focusable link.
  await page.mouse.wheel(0, 1600);
  const stickyLink = page.locator('.lv7-sticky a');
  await expect(stickyLink).toHaveCount(1);
  await stickyLink.focus();
  await expect(stickyLink).toBeFocused();
});

test('B9 — axe reports zero critical violations', async ({ page }) => {
  await openLanding(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const critical = results.violations.filter((v) => v.impact === 'critical');
  expect(critical, JSON.stringify(critical.map((v) => v.id))).toEqual([]);
});

test('B12 — page_view carries contract_version', async ({ page }) => {
  const bodies: Array<Record<string, unknown>> = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/analytics/funnel')) {
      try { bodies.push(req.postDataJSON()); } catch { /* ignore */ }
    }
  });
  await openLanding(page);
  await page.waitForTimeout(400);
  const pageView = bodies.find((b) => b.event === 'page_view');
  expect(pageView).toBeTruthy();
  expect((pageView?.metadata as Record<string, unknown>)?.contract_version).toBe(CONTRACT_VERSION);
});

test('fails closed when the public contract is unavailable', async ({ page }) => {
  await page.route((url) => url.pathname === '/api/public/commercial-contract', (route) =>
    route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ success: false }) }));
  await page.route((url) => url.pathname.startsWith('/api/') && url.pathname !== '/api/public/commercial-contract', (route) =>
    route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ success: true, data: {} }) }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(/pricing is unavailable/i);
  await expect(page.getByTestId('lv7-unit-price')).toHaveCount(0);
});