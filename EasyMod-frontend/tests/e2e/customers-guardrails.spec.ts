/**
 * Customers-worklist guardrails proof (mock-only, CI subset). Execution-class
 * worklist (§29): signal header + factual pills (pilot + legacy), tabpanel
 * semantics, docked detail sections, legacy create-dialog focus trap + Escape,
 * 390px no-overflow, axe `.em-customers`. Allowlist mirrors customer-intelligence
 * (no new endpoints). The detailed opportunity/confidence/deep-link contracts
 * remain covered by customer-intelligence.spec.ts.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'Pilot Shop', role: 'owner' };
const json = (data: unknown, status = 200) => ({ success: status < 400, data });

const repeatBuyer = {
    id: 'cust-1', name: 'Rahim Uddin', phone: '01711111111', channel_type: 'messenger',
    state: 'REPEAT_BUYER', state_reasons: [{ code: 'MULTIPLE_DELIVERIES', params: { delivered: 2 } }],
    total_orders: 3, delivered_orders: 2, returned_orders: 0, delivered_value: 3000,
    last_activity_at: new Date().toISOString(), open_opportunity: null,
};

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const customerDetail = {
    customer: { ...repeatBuyer, last_inbound_at: iso(-3600000), page: { id: 'pg', name: 'Pilot Page', platform: 'facebook' } },
    contactability: { platform: 'facebook', window_open: true, window_closes_at: iso(23 * 3600000), reason: 'WITHIN_24H_WINDOW' },
    state: 'REPEAT_BUYER', state_reasons: repeatBuyer.state_reasons, state_rules_version: 'customer-state/1.0.0',
    summary: {
        total_orders: 3, delivered_orders: 2, returned_orders: 0, cancelled_orders: 1, in_progress_orders: 0,
        ordered_value: 3000, delivered_value: 3000, first_order_at: iso(-20 * 86400000), last_order_at: iso(-5 * 86400000),
        last_delivered_at: iso(-3 * 86400000),
    },
    rto_signal: { available: true, tier: 'clear', risk_score: 0, list: null, network: null },
    orders: [
        { id: 'ord-d1', order_number: 'ORD-100', created_at: iso(-10 * 86400000), total: 1000, order_status: 'delivered', payment_status: 'pending', delivery_status: 'delivered', delivery_provider: 'pathao', outcome: 'DELIVERED', link: 'CUSTOMER', confidence: null },
    ],
    conversations: [],
    opportunities: [],
    timeline: [
        { type: 'ORDER_DELIVERED', at: iso(-3 * 86400000), order_id: 'ord-d1', order_number: 'ORD-100' },
    ],
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/dashboard/metrics',
    '/api/dashboard/queue', '/api/subscription', '/api/notifications/in-app', '/api/notifications/telegram',
    '/api/rto-shield/settings', '/api/product', '/api/customer-intelligence/status',
    '/api/customer-intelligence/customers', '/api/customer-intelligence/opportunities',
    '/api/commercial/claims', '/api/public/commercial-contract', '/api/customer',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/customer-intelligence\/customers\/[\w-]+$/,
    /^\/api\/customer\/[\w-]+$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, options: { pilot?: boolean } = {}) {
    const pilot = options.pilot ?? true;
    const state = { signedIn: false, unexpected: [] as string[] };
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.fulfill({ json: json([]) });
        }
        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 } }) });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] } }) });
        }
        if (path === '/api/channels/meta' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
        }

        if (path === '/api/csrf') return route.fulfill({ json: json({ csrfToken: 'csrf-test' }) });
        if (path === '/api/auth/me') {
            if (!state.signedIn) return route.fulfill({ status: 401, json: { success: false } });
            return route.fulfill({ json: json({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }) });
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            state.signedIn = true;
            return route.fulfill({ json: json({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }) });
        }
        if (path === '/api/setup/status') return route.fulfill({ json: json({ isComplete: true, completedCount: 4, totalCount: 4, progressPercent: 100, tasks: [] }) });
        if (path === '/api/dashboard/metrics') return route.fulfill({ json: json({}) });
        if (path === '/api/dashboard/queue') return route.fulfill({ json: json({}) });
        if (path === '/api/subscription') return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' }) });
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/notifications/telegram') return route.fulfill({ json: json({ connected: false }) });
        if (path === '/api/rto-shield/settings') return route.fulfill({ json: json({ contribute: true, enforce: true }) });
        if (path === '/api/product') return route.fulfill({ json: json([]) });
        if (path === '/api/customer-intelligence/status') return route.fulfill({ json: json({ customer_intelligence: pilot, order_confidence_mode: pilot ? 'enforce' : 'off' }) });
        if (path === '/api/customer-intelligence/customers' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [repeatBuyer], total: 1, page: 1, pageSize: 20 }) });
        if (/^\/api\/customer-intelligence\/customers\/[\w-]+$/.test(path)) return route.fulfill({ json: json(customerDetail) });
        if (path === '/api/customer-intelligence/opportunities') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [], total: 0, page: 1, pageSize: 20 }) });
        if (path === '/api/customer' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [{ id: 'cust-1', name: 'Rahim Uddin', phone: '01711111111', channel_type: 'messenger', created_at: new Date().toISOString() }], total: 1, page: 1, pageSize: 20 }) });
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndGo(page: Page, target = '/customers') {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto(target);
    await expect(page.getByTestId('customers-signal').or(page.getByTestId('customer-state')).first()).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('pilot execution header: title + signal + pills + tabpanel, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: true });
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
    await expect(page.getByTestId('customers-signal')).toContainText('Customers active');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByText(/Total:/)).toBeVisible();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('legacy worklist keeps its honest header + result count', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: false });
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Customer Management', exact: true })).toBeVisible();
    await expect(page.getByTestId('customers-result-count')).toContainText('1 customers in this shop');
    await expect(page.getByTestId('customers-tab-opportunities')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('detail exposes the labelled commerce / risk / orders / timeline sections', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: true });
    await loginAndGo(page, '/customers/cust-1');
    await expect(page.getByTestId('customer-state')).toContainText('Repeat buyer');
    await expect(page.getByTestId('commerce-summary')).toContainText('3,000');
    await expect(page.getByTestId('rto-signal')).toBeVisible();
    await expect(page.getByTestId('customer-orders')).toContainText('#ORD-100');
    await expect(page.getByTestId('customer-timeline')).toBeVisible();
    await expect(page.getByTestId('reply-window')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('legacy create-customer dialog traps focus and closes on Escape', async ({ page }) => {
    const state = await setupRoutes(page, { pilot: false });
    await loginAndGo(page);
    await page.getByRole('button', { name: 'Add Customer' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.contains(document.activeElement) : false;
    })).toBe(true);
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('390px: cards visible, table hidden, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page, { pilot: true });
    await loginAndGo(page);
    await expect(page.getByTestId('customer-list-mobile')).toBeVisible();
    await expect(page.getByTestId('customer-table')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('axe: no critical or serious violations in the customers surface', async ({ page }) => {
    await setupRoutes(page, { pilot: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('customers-signal')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-customers').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
