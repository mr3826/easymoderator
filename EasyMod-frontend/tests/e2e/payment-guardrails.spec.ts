/**
 * Payment-settings guardrails proof (mock-only, CI subset). Execution-class
 * settings page (§29): channel signal header, gateway switch gating,
 * test-then-save with secret hygiene, default election, advance-rule state,
 * merchant-mode capability honesty. Allowlist+abort discipline: invented
 * backend calls fail here. Merchant API is presentation-only — the backend
 * does not exercise merchant credentials under the self-mfs gateway.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const savedRow = (overrides: Record<string, unknown> = {}) => ({
    gateway: 'self-mfs',
    is_enabled: false,
    credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' },
    ...overrides,
});

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/payment/config', '/api/payment/config/test', '/api/shop/me',
    '/api/shop/platform-priority', '/api/shop/update',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, options: { savedConfigs?: unknown[]; priority?: { payment: string[]; delivery: string[] } } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        testCalls: 0,
        saveCalls: 0,
        priorityPuts: 0,
        shopUpdates: 0,
        lastTestBody: null as Record<string, unknown> | null,
        lastPriorityBody: null as Record<string, unknown> | null,
        lastShopBody: null as Record<string, unknown> | null,
        savedConfigs: options.savedConfigs ?? [],
        priority: options.priority ?? { payment: [], delivery: [] },
    };
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
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
        if (path === '/api/setup/status') return route.fulfill({ json: json({ complete: true }) });
        if (path === '/api/subscription') return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' }) });
        if (path === '/api/commercial/claims') {
            const surface = url.searchParams.get('surface') ?? 'usage-banner';
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/payment/config' && method === 'GET') return route.fulfill({ json: json(state.savedConfigs) });
        if (path === '/api/payment/config/test' && method === 'POST') {
            state.testCalls += 1;
            state.lastTestBody = request.postDataJSON();
            return route.fulfill({ json: json({ success: true, message: 'Number verified' }) });
        }
        if (path === '/api/payment/config' && method === 'POST') {
            state.saveCalls += 1;
            return route.fulfill({ json: json({ id: 'cfg-1', gateway: 'self-mfs', is_enabled: false }) });
        }
        if (path === '/api/shop/me') return route.fulfill({ json: json({ ...mockShop, settings: {}, payment_methods: null }) });
        if (path === '/api/shop/platform-priority') {
            if (method === 'PUT') {
                state.priorityPuts += 1;
                state.lastPriorityBody = request.postDataJSON();
                state.priority = state.lastPriorityBody as { payment: string[]; delivery: string[] };
                return route.fulfill({ json: json(state.priority) });
            }
            return route.fulfill({ json: json(state.priority) });
        }
        if (path === '/api/shop/update' && method === 'POST') {
            state.shopUpdates += 1;
            state.lastShopBody = request.postDataJSON();
            return route.fulfill({ json: json({}) });
        }
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndGo(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/manage-shop/payment-settings');
    // Wait for the Suspense-loaded page to mount before any assertion.
    await expect(page.getByTestId('payment-signal')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + channel signal + pills, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Payment Settings', exact: true })).toBeVisible();
    await expect(page.getByTestId('payment-signal')).toContainText('Accepting payments');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByText(/Enabled methods:/)).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('expand hydrates the receiver number then tests before saving', async ({ page }) => {
    const state = await setupRoutes(page, { savedConfigs: [savedRow({ is_enabled: true })] });
    await loginAndGo(page);
    await page.getByTestId('gateway-expand-bkash').click();
    await expect(page.getByPlaceholder('01XXXXXXXXX')).toHaveValue('01711000000');
    await page.getByRole('button', { name: /Save bKash/i }).click();
    await expect.poll(() => state.testCalls).toBe(1);
    await expect.poll(() => state.saveCalls).toBe(1);
    expect((state.lastTestBody as { gateway: string }).gateway).toBe('self-mfs');
    expect((state.lastTestBody as { credentials: { mfs_number: string } }).credentials.mfs_number).toBe('01711000000');
    expect(state.unexpected).toEqual([]);
});

test('non-COD activation is gated behind saved credentials', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('switch', { name: 'bKash' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Cash on Delivery' })).toBeEnabled();
    expect(state.unexpected).toEqual([]);
});

test('default election PUTs the reordered platform priority', async ({ page }) => {
    const state = await setupRoutes(page, {
        savedConfigs: [savedRow({ is_enabled: true })],
        priority: { payment: ['cod'], delivery: [] },
    });
    await loginAndGo(page);
    await page.getByRole('button', { name: /Set Default/i }).click();
    await expect.poll(() => state.priorityPuts).toBe(1);
    expect((state.lastPriorityBody as { payment: string[] }).payment).toEqual(['bkash', 'cod']);
    await expect(page.getByRole('status')).toContainText('bKash set as default payment method');
    expect(state.unexpected).toEqual([]);
});

test('advance rule selection enables its input and persists to the shop', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.locator('input[name="advance-payment"][value="none"]')).toBeChecked();
    await page.locator('input[name="advance-payment"][value="percentage"]').check();
    await expect(page.locator('input[type="number"]:not([disabled])')).toBeVisible();
    await page.getByRole('button', { name: 'Update Payment Info' }).click();
    await expect.poll(() => state.shopUpdates).toBe(1);
    const persisted = JSON.parse((state.lastShopBody as { payment_methods: string }).payment_methods);
    expect(persisted.advancePaymentRule).toBe('percentage');
    expect(state.unexpected).toEqual([]);
});

test('merchant mode states capability truth without claiming automated checkout', async ({ page }) => {
    await setupRoutes(page, { savedConfigs: [savedRow()] });
    await loginAndGo(page);
    await page.getByTestId('gateway-expand-bkash').click();
    await page.getByRole('button', { name: 'Merchant API' }).click();
    await expect(page.getByText(/Automated checkout is not active yet/i)).toBeVisible();
    await expect(page.getByText(/Automated checkout via official merchant API/i)).toHaveCount(0);
});

test('390px: no horizontal overflow and five mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('payment-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the payment surface', async ({ page }) => {
    await setupRoutes(page, { savedConfigs: [savedRow({ is_enabled: true })] });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('payment-signal')).toBeVisible();
    await page.getByTestId('gateway-expand-bkash').click();
    await expect(page.getByPlaceholder('01XXXXXXXXX')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-payment').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
