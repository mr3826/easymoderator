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

const queue = {
  unread_count: 2,
  pending_payment_count: 1,
  ready_to_dispatch_count: 3,
  at_risk_orders: [
    { id: 'order-risk-1', customer_name: 'Rina Akter', customer_phone: '01700000000', status: 'returned', tracking_id: 'TRK-1' },
  ],
};

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

  // Review-queue aggregates link to workflows.
  await expect(page.getByRole('link', { name: /Conversations awaiting reply/ })).toHaveAttribute('href', '/inbox');
});

test('keyboard Tab reaches the primary action with a visible focus ring', async ({ page }) => {
  // Reduced motion removes the entrance fade so focus styling is scanned on a
  // settled page (same determinism as the axe test).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await expect(page.getByTestId('dashboard-primary-action')).toBeVisible();
  await page.waitForTimeout(500);

  let focused = false;
  for (let i = 0; i < 20; i += 1) {
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

test('queue chip navigates to the inbox workflow', async ({ page }) => {
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await page.getByRole('link', { name: /Conversations awaiting reply/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test('mobile 390px keeps the primary action reachable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupRoutes(page);
  await loginAndGo(page, '/dashboard');
  await expect(page.getByTestId('dashboard-primary-action')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
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
