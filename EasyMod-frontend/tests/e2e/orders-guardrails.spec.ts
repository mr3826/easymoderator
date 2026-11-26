/**
 * Orders-worklist guardrails proof (mock-only, CI subset). Execution-class
 * worklist (header-removal C1/C6): no permanent signal band — the honest
 * counts live in the worklist bucket toolbar, create/export stay in that
 * toolbar; create-order dialog focus trap + Escape + label, docked detail
 * region + payment-reconciliation alert honesty, 390px no-overflow,
 * axe `.em-orders`. Allowlist+abort discipline mirrors
 * order-management.spec.ts (no new endpoints). The detailed filter/courier/
 * correction contracts remain covered by order-management.spec.ts.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const orders = [
    {
        id: 'order-1', order_number: 'ORD-001', customer_name: 'Ahmed Hassan', customer_phone: '01711000001',
        delivery_address: 'House 1, Mirpur, Dhaka', items: [{ product_name: 'Blue T-Shirt', quantity: 2, price: 750 }],
        total: 1500, status: 'draft', channel: 'facebook', payment_method: 'COD', payment_status: 'unpaid',
        fulfillment_status: 'unfulfilled', delivery_status: null, created_at: '2026-11-01T08:00:00Z', metadata: {},
    },
    {
        id: 'order-2', order_number: 'ORD-002', customer_name: 'Fatima Begum', customer_phone: '01711000002',
        delivery_address: 'House 2, Dhanmondi, Dhaka', items: [{ product_name: 'Red Hijab', quantity: 2, price: 400 }],
        total: 800, status: 'confirmed', channel: 'whatsapp', payment_method: 'bKash', payment_status: 'paid',
        fulfillment_status: 'booked', delivery_status: 'booked', delivery_provider: 'steadfast',
        delivery_tracking_code: 'TRK-OLD', created_at: '2026-11-02T08:00:00Z',
        metadata: { payment_reconciliation: { required: true, code: 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM' } },
    },
];

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/product', '/api/payment/config',
    '/api/notifications/in-app', '/api/subscription', '/api/order/counts', '/api/order',
    '/api/conversation', '/api/commercial/claims', '/api/public/commercial-contract',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/order\/[^/]+$/,
    /^\/api\/order\/[^/]+\/courier\/eligibility$/,
    /^\/api\/order-confidence\/orders\/[^/]+$/,
    /^\/api\/conversation\/[^/]+\/messages$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page) {
    const state = { signedIn: false, unexpected: [] as string[] };
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
        if (path === '/api/product') return route.fulfill({ json: json([]) });
        if (path === '/api/payment/config') return route.fulfill({ json: json([{ id: 'cod-config', gateway: 'cod', is_enabled: true }]) });
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/subscription') return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' }) });
        if (path === '/api/order/counts') return route.fulfill({ json: json({ total: 2, to_confirm: 1, to_pack: 0, booked: 1, in_transit: 0, needs_action: 0, returned: 0, delivered: 0 }) });
        if (path === '/api/order' && method === 'GET') return route.fulfill({ json: json(orders) });
        if (/^\/api\/order\/[^/]+$/.test(path) && method === 'GET') {
            const found = orders.find((o) => o.id === path.split('/').pop());
            return found ? route.fulfill({ json: json(found) }) : route.fulfill({ status: 404, json: { success: false } });
        }
        if (/^\/api\/order\/[^/]+\/courier\/eligibility$/.test(path)) return route.fulfill({ json: json({ provider: 'steadfast', decision: 'SERVICEABLE', reason_code: 'AREA_MATCHED', source: 'order_destination', checked_at: new Date().toISOString(), ttl_seconds: 300 }) });
        if (/^\/api\/order-confidence\/orders\/[^/]+$/.test(path)) return route.fulfill({ json: json({ mode: 'off', decision: null }) });
        if (path === '/api/conversation') return route.fulfill({ json: json({ data: [], total: 0, page: 1, pageSize: 1 }) });
        if (/^\/api\/conversation\/[^/]+\/messages$/.test(path)) return route.fulfill({ json: json({ messages: [], pagination: { page: 1, totalPages: 1 } }) });
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
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
    await page.goto('/orders');
    // Header-removal C6: the signal testid is gone; the worklist bucket
    // toolbar is the stable mount anchor.
    await expect(page.getByTestId('orders-bucket-all')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('no header band: sr-only title, honest counts in the toolbar, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
    // C6: the page-level signal badge must NOT exist any more.
    await expect(page.getByTestId('orders-signal')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    // C4: the same facts survive record/bucket-level — the toolbar chips are
    // server-aggregated counts (total 2 / needs_action 0 from the mock).
    await expect(page.getByTestId('orders-bucket-count-all')).toHaveText('2');
    await expect(page.getByTestId('orders-bucket-count-needs_action')).toHaveText('0');
    // Create keeps its toolbar home (C2).
    await expect(page.getByRole('button', { name: 'Create Order' })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('create-order dialog is labelled, traps focus, and closes on Escape', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByRole('button', { name: 'Create Order' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'create-order-title');
    await expect.poll(() => page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.contains(document.activeElement) : false;
    })).toBe(true);
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('detail is a labelled region and shows the reconciliation alert honestly', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByRole('button', { name: 'ORD-002' }).click();
    const panel = page.getByTestId('order-detail-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'region');
    await expect(panel.getByRole('alert')).toContainText('Verified payment needs courier reconciliation');
    await expect(panel.getByText(/settled COD|cash received|courier settlement/i)).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow on the worklist', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('orders-bucket-all')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

// A6 G-UX09/G-UX09b additions (the 390px pin above is unchanged).
test('360px: no horizontal overflow and the create action stays reachable', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('orders-bucket-all')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Primary task action reachable and functional at true 360px.
    await page.getByRole('button', { name: 'Create Order' }).click();
    await expect(page.getByTestId('create-order-modal')).toBeVisible();
    const dialogOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(dialogOverflow).toBeLessThanOrEqual(1);
});

test('200% zoom-equivalent (1280×1024 content at 640 CSS px): worklist fits, create action reachable', async ({ page }) => {
    // Real 200% zoom = 640×512 CSS viewport WITH media-query re-evaluation
    // (plain CSS zoom would scale the desktop table's min-w-[1240px] into a
    // phantom page-overflow that no actual zoom produces — probed). The
    // desktop table therefore drops to the mobile worklist here; the page
    // must not scroll horizontally and the task action must stay reachable.
    await page.setViewportSize({ width: 640, height: 512 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('orders-bucket-all')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Create Order' }).click();
    await expect(page.getByTestId('create-order-modal')).toBeVisible();
    const dialogOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(dialogOverflow).toBeLessThanOrEqual(1);
});

test('axe: no critical or serious violations in the orders surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('orders-bucket-all')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-orders').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
