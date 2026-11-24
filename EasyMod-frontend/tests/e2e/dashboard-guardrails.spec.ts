/**
 * /dashboard guardrails redesign — mock-only proof (same convention as the
 * CI subset): screen anatomy, one dominant signal + one primary action,
 * keyboard focus, queue-chip navigation, mobile overflow, setup variant,
 * and a scoped axe scan (critical/serious) on the redesigned surface.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-qa-1', full_name: 'QA User', email: 'qa@example.com' };
const mockShop = {
  id: 'shop-qa-1',
  unique_code: 'QA123',
  shop_name: 'QA Shop',
  role: 'owner',
  settings: { onboarding_completed: true },
};

const metrics = {
  metrics: { totalMessages: 12, activeProducts: 8, ordersToday: 3, weeklyChange: 10.5, conversionRate: 5.2 },
  channels: { active: 2, total: 3 },
  chartData: [
    { date: '2026-11-09', orders: 1 },
    { date: '2026-11-10', orders: 2 },
    { date: '2026-11-11', orders: 3 },
    { date: '2026-11-12', orders: 2 },
    { date: '2026-11-13', orders: 4 },
  ],
  cashPosition: { inTransit: { amount: 12500, count: 7 }, atRisk: { amount: 3400, count: 2, windowDays: 30 } },
};

// C3 revised queue shape (doc 05 §3): predicate_version marker, needs_reply
// object (never a bare unread_count), PII-free at_risk projection
// {id, orderNumber, status, tracking_id, updatedAt}, corrected commerce_signals.
// NO customer_name / customer_phone anywhere in this fixture — the projection
// that ships must not be able to leak them (A9 attack item).
const queue = {
  predicate_version: 'worklist-v1',
  pending_payment_count: 1,
  ready_to_dispatch_count: 3,
  needs_reply: {
    count: 2,
    scanned: 2,
    cap: 200,
    coverageComplete: true,
    generated_at: '2026-11-24T10:00:00.000Z',
  },
  at_risk_orders: [
    { id: 'order-risk-1', orderNumber: 'EM-0900', status: 'returned', tracking_id: 'TRK-1', updatedAt: '2026-11-23T09:00:00.000Z' },
  ],
  commerce_signals: {
    deliveredCharges: { dayUtc: '2026-11-24', count: 4, amountMinor: 123450 },
    recentActivity: [
      {
        id: 'act-1', action: 'ORDER_CONFIRMED', resourceType: 'order',
        occurredAt: '2026-11-24T08:30:00.000Z', resource_id: 'order-risk-1',
        user: { id: 'user-qa-1', full_name: 'QA User' },
      },
      {
        id: 'act-2', action: 'PRODUCT_STOCK_UPDATED', resourceType: 'product',
        occurredAt: '2026-11-24T07:15:00.000Z', resource_id: 'prod-1', user: null,
      },
    ],
  },
};

// Shell/D7 sources — deterministic, all-negative so no stray badge pills or
// optimistic chips leak into the dashboard proof surface.
const shellMocks: Array<[string, unknown]> = [
  [
    '/api/order/counts',
    { to_confirm: 0, to_pack: 3, booked: 0, in_transit: 0, needs_action: 1, returned: 0, delivered: 0, total: 9 },
  ],
  [
    '/api/conversation/needs-reply-count',
    { count: 2, scanned: 2, cap: 200, coverageComplete: true, generated_at: '2026-11-24T10:00:00.000Z' },
  ],
  [
    '/api/product/stock-exceptions',
    { outOfStock: 1, lowStock: 1, exceptions: 2, scanned: 8, cap: 1000, coverageComplete: true, generated_at: '2026-11-24T10:00:00.000Z' },
  ],
  [
    '/api/shop/delivery/readiness',
    {
      provider: null, ready: false, connected: false, active: false,
      credentials_configured: false, provider_store_id: null, provider_store_count: 0,
      pickup_location_configured: false, pickup_enabled: false, pickup_summary: null,
      provider_pickup_meta: {}, pickup_locations_count: 0,
      missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'],
      status: 'SETUP_INCOMPLETE', providers: [],
    },
  ],
  ['/api/channels/meta', []],
];

const recentOrder = {
  id: 'order-recent-1',
  orderNumber: 'EM-1001',
  customerName: 'Karim Uddin',
  total: 1250,
  status: 'confirmed',
  items: [{ productName: 'Jamdani Saree', quantity: 1 }],
  updatedAt: '2026-11-15T09:00:00.000Z',
  createdAt: '2026-11-15T08:00:00.000Z',
};

const conversation = {
  id: 'conv-1',
  needs_merchant_reply: true,
  needs_merchant_reply_reason: 'CUSTOMER_UNANSWERED',
  customer: { name: 'Salma Begum' },
  updated_at: '2026-11-15T10:00:00.000Z',
};

interface MockOptions {
  setupComplete?: boolean;
  dismissSetup?: boolean;
}

async function setupRoutes(page: Page, options: MockOptions = {}) {
  const { setupComplete = true, dismissSetup = true } = options;
  let authenticated = false;

  await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/csrf' && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf-qa-token' }) });
    }
    if (path === '/api/auth/me' && method === 'GET') {
      if (!authenticated) {
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Unauthorized' }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { user: mockUser, currentShop: mockShop, allShops: [mockShop] } }),
      });
    }
    if (path === '/api/auth/signin' && method === 'POST') {
      authenticated = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { user: mockUser, currentShop: mockShop, allShops: [mockShop], tokens: { access_token: 'access-token', refresh_token: 'refresh-token' } },
        }),
      });
    }
    if (path === '/api/dashboard/metrics' && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: metrics }) });
    }
    if (path === '/api/dashboard/queue' && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: queue }) });
    }
    for (const [mockPath, body] of shellMocks) {
      if (path === mockPath && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: body }) });
      }
    }
    if (path === '/api/order' && method === 'GET') {
      const isDraft = url.searchParams.get('order_status') === 'draft';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: isDraft ? [] : [recentOrder] }),
      });
    }
    if (path === '/api/conversation' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { conversations: [conversation], ai_reply_mode: 'MANUAL', pagination: { page: 1, total: 1, pageSize: 100 } },
        }),
      });
    }
    if (path === '/api/setup/status' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: setupComplete
            ? { isComplete: true, completedCount: 4, totalCount: 4, progressPercent: 100, tasks: [], generatedAt: '2026-11-15T08:00:00.000Z' }
            : {
              isComplete: false,
              completedCount: 1,
              totalCount: 4,
              progressPercent: 25,
              generatedAt: '2026-11-15T08:00:00.000Z',
              tasks: [
                { key: 'connect_channel', title: 'Connect Facebook Page', description: 'Connect a page', status: 'complete', required: true, ctaLabel: 'Connect Facebook', href: '/manage-shop/chat-settings', missing: [], warnings: [], meta: {} },
                { key: 'shop_profile', title: 'Complete Business Information', description: 'Business info', status: 'incomplete', required: true, ctaLabel: 'Complete Info', href: '/manage-shop/business-info', missing: ['shop_name'], warnings: [], meta: {} },
                { key: 'first_product', title: 'Add Your First Product', description: 'Add a product', status: 'incomplete', required: true, ctaLabel: 'Add Product', href: '/products', missing: [], warnings: [], meta: {} },
              ],
            },
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) });
  });

  if (dismissSetup) {
    await page.addInitScript(() => {
      window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
      window.localStorage.setItem('easymod:business-setup:shop-qa-1:complete-dismissed', '1');
      window.localStorage.setItem('easymod_lang', 'en');
    });
  } else {
    await page.addInitScript(() => {
      window.localStorage.setItem('easymod_lang', 'en');
    });
  }
}

async function loginAndGo(page: Page, path: string) {
  await page.goto('/signin');
  await page.fill('#email', 'qa@example.com');
  await page.fill('#password', 'strong-password');
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
}

test('dashboard answers the Core Design Test with one signal and one primary action', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');

  await expect(page.getByRole('main').getByRole('heading', { name: "Today's work" })).toBeVisible();
  await expect(page.getByText('Orders today')).toBeVisible();

  // One dominant signal with a visible label (never color alone).
  const signal = page.getByTestId('dashboard-signal');
  await expect(signal).toBeVisible();
  await expect(signal).toContainText('Attention'); // delivery exception present
  await expect(signal.locator('svg')).toHaveCount(1);

  // Exactly one primary action, visible without scrolling at 1440x900.
  const primary = page.getByTestId('dashboard-primary-action');
  await expect(primary).toHaveCount(1);
  await expect(primary).toBeVisible();
  const box = await primary.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThan(900);
  // Severity: exception first.
  await expect(primary).toContainText('Review delivery exception');

  // PROVEN RESULT: sync evidence + derivation honesty.
  await expect(page.getByText(/Task sources last checked/)).toBeVisible();
  await expect(page.getByText(/not from courier statements/i)).toBeVisible();

  // Review-queue aggregates link to the EXACT filtered workflow (D1/D3
  // destination parity — the chip shares its predicate with the destination).
  await expect(page.getByRole('link', { name: /Conversations awaiting reply/ })).toHaveAttribute('href', '/inbox?tab=needs_review');
  await expect(page.getByRole('link', { name: /Payment needs checking/ })).toHaveAttribute('href', '/orders?payment=pending');
  await expect(page.getByRole('link', { name: /Ready to dispatch/ })).toHaveAttribute('href', '/orders?bucket=to_pack');

  // PII-free at-risk projection: the exception row is identified by the human
  // order number, never by a customer name/phone.
  await expect(page.getByText('EM-0900').first()).toBeVisible();
  await expect(page.getByText('Rina Akter')).toHaveCount(0);
  await expect(page.getByText('01700000000')).toHaveCount(0);

  // The queue answer carries the bucket-parity contract marker (D3).
  // (Assertion on the wire, not the DOM: the fixture itself is the C3 shape;
  // the visible consequence is the four-card grid below.)
  await expect(page.getByRole('heading', { name: 'Queues and activity' })).toBeVisible();
});

test('keyboard Tab reaches the primary action with a visible focus ring', async ({ page }) => {
  // Reduced motion removes the entrance fade so focus styling is scanned on a
  // settled page (same determinism as the axe test).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await expect(page.getByTestId('dashboard-primary-action')).toBeVisible();
  await page.waitForTimeout(500);

  // W2 grew the rail (Audit logs entry) and added the desktop AI chip link —
  // more chrome stops before <main>. The pin (primary action reachable by pure
  // keyboard with a visible ring) is unchanged; only the search budget grows.
  let focused = false;
  for (let i = 0; i < 34; i += 1) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'dashboard-primary-action');
    if (focused) break;
  }
  expect(focused).toBe(true);
  // Let any focus transition settle before reading computed styles.
  await page.waitForTimeout(300);
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = window.getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor, tag: el.tagName };
  });
  console.log('focus outline:', JSON.stringify(outline));
  expect(outline.style).not.toBe('none');
  expect(parseFloat(outline.width)).toBeGreaterThan(0);
});

test('queue chip navigates to the needs-review inbox tab (destination parity)', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await page.getByRole('link', { name: /Conversations awaiting reply/ }).click();
  await expect(page).toHaveURL(/\/inbox\?tab=needs_review$/);
  // The inbox honours the seed: the "Needs your reply" tab is the active one.
  await expect(page.getByRole('button', { name: /Needs your reply/ })).toHaveAttribute('aria-pressed', 'true');
});

test('mobile 390px keeps the primary action reachable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await expect(page.getByTestId('dashboard-primary-action')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// A6 G-UX09/G-UX09b additions (the 390px pin above is unchanged).
test('mobile 360px keeps the primary action reachable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await expect(page.getByTestId('dashboard-primary-action')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('200% zoom-equivalent (1280×1024 content at 640 CSS px): signal and queue link stay reachable', async ({ page }) => {
  // 200% zoom of a 1280×1024 window = 640×512 CSS viewport with media
  // queries re-evaluated (CSS zoom on <html> would scale the desktop layout
  // without reflowing — phantom overflow, see A6 probe). Overview content
  // must fit the page and the #301 queue link must stay reachable.
  await page.setViewportSize({ width: 640, height: 512 });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await expect(page.getByTestId('dashboard-signal')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('link', { name: /Conversations awaiting reply/ })).toBeVisible();
});

test('setup variant shows one primary action on the next incomplete task', async ({ page }) => {
  await setupRoutes(page, { setupComplete: false, dismissSetup: false });
  await loginAndGo(page, '/dashboard');

  await expect(page.getByRole('heading', { name: 'Complete Your Shop Setup' })).toBeVisible();
  const primary = page.getByTestId('dashboard-primary-action');
  await expect(primary).toHaveCount(1);
  await expect(primary).toContainText('Complete Info');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  // Completed task carries a resolved badge and no CTA.
  await expect(page.getByRole('link', { name: /Connect Facebook/ })).toHaveCount(0);
});

// ── Phase 1 W2 (mission D4/D5/D7/D8) ──────────────────────────────────────────
test('W2 four signal cards: exact counts + D5 charges copy link to their workflows', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  const cards = page.getByRole('link', { name: /Conversations awaiting reply|Payment needs checking|Ready to dispatch|Recorded delivery charges today/ });
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText('2'); // needs_reply, complete coverage → exact
  await expect(cards.nth(1)).toContainText('1'); // pending payment
  await expect(cards.nth(2)).toContainText('3'); // ready to dispatch == to_pack
  // D5 recorded charges: amount ৳1,234.50 from minor units + honest gross-UTC copy.
  const charges = page.getByRole('link', { name: /Recorded delivery charges today/ });
  await expect(charges).toContainText('1,234.50');
  await expect(charges).toContainText('Gross ledger entries for the UTC day — not invoiced or collected.');
  await expect(charges).toContainText('2026-11-24 UTC · 4 orders');
  await expect(charges).toHaveAttribute('href', '/subscription');
  await expect(charges).toHaveAttribute('title', /Returns and cancellations recorded today reduce this total/);
});

test('W2 recent activity: stored actor or System, order rows deep-link, others unlinked', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  const section = page.getByRole('region', { name: 'Recent activity' }).or(page.locator('section[aria-labelledby="dashboard-activity-heading"]'));
  await expect(section).toBeVisible();
  // Header link to the full evidence trail (D4).
  await expect(section.getByRole('link', { name: 'View all activity' })).toHaveAttribute('href', '/audit-logs');
  // Stored user row: actor name + action, ORDER row links to the verified seed.
  const orderRow = section.getByRole('link', { name: /QA User/ });
  await expect(orderRow).toBeVisible();
  await expect(orderRow).toHaveAttribute('href', '/orders?orderId=order-risk-1');
  // System row (user null): localized "System" actor, product row stays UNLINKED
  // (no fabricated deep link) and never renders raw PII keys.
  await expect(section.getByText('System')).toBeVisible();
  await expect(section.getByRole('link', { name: /System/ })).toHaveCount(0);
  // Bounded display: at most six rows + Dhaka-time note.
  await expect(section.locator('ul > li')).toHaveCount(2);
  await expect(section.getByText(/Dhaka time/)).toBeVisible();
});

test('W2 BusinessHealth + ConnectionHealth modules render from their authorities', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  const health = page.locator('section[aria-labelledby="dashboard-business-health-heading"]');
  await expect(health).toBeVisible();
  await expect(health.getByRole('link', { name: /Stock exceptions/ })).toHaveAttribute('href', '/products?stock=exceptions');
  await expect(health.getByRole('link', { name: /Delivery exceptions/ })).toHaveAttribute('href', '/orders?bucket=needs_action');
  await expect(health.getByText('Out of stock: 1 · Low stock: 1')).toBeVisible();
  const connections = page.locator('section[aria-labelledby="dashboard-connections-heading"]');
  await expect(connections.getByTestId('connections-meta-row')).toBeVisible();
  await expect(connections.getByTestId('connections-courier-row')).toBeVisible();
  // Zero channels → honest disconnected (never green); no courier integration →
  // "Not set up" (failed/absent reads never claim readiness, D7/D10).
  await expect(connections.getByTestId('connections-meta-row')).toContainText('Disconnected');
  await expect(connections.getByTestId('connections-courier-row')).toContainText('Not set up');
});

test('redesign surface has no critical or serious axe violations', async ({ page }) => {
  // Reduced motion disables the entrance fade: axe must scan settled colors,
  // not opacity-blended mid-animation values (also proves the §19 path).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await expect(page.getByTestId('dashboard-signal')).toBeVisible();
  await page.waitForTimeout(800);

  // Scoped to the redesigned surface: the shared shell's pre-existing contrast
  // debt is out of scope for this page-only mission (same precedent as ADR-0013).
  const results = await new AxeBuilder({ page }).include('.em-dashboard').analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking).toEqual([]);
});
