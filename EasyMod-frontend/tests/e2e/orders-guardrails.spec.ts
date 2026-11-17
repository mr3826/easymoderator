/**
 * Orders-worklist guardrails proof (mock-only, CI subset). Execution-class
 * worklist (§29): signal header + factual pills, create-order dialog focus trap
 * + Escape + label, docked detail region + payment-reconciliation alert honesty,
 * 390px no-overflow, axe `.em-orders`. Allowlist+abort discipline mirrors
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
    await expect(page.getByTestId('orders-signal')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + worklist signal + pills, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
    await expect(page.getByTestId('orders-signal')).toContainText('Orders flowing');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByText(/Total:/)).toBeVisible();
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
    await expect(page.getByTestId('orders-signal')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the orders surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('orders-signal')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-orders').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
