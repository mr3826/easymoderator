/**
 * Products-catalog guardrails proof (mock-only, CI subset). Execution-class
 * worklist (§29): signal header + factual pills, table, upload dialog focus trap
 * + Escape, add-form publish contract, 390px no-overflow, axe `.em-products`.
 * Allowlist mirrors integration-flows (no new endpoints).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'Pilot Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const products = [
    { id: 'prod-1', name: 'Demo Hoodie', price: 1299, description: 'Comfort fit demo product', category: 'Apparel', sku: 'HD-1', status: 'active', is_active: true, quantity: 12, track_quantity: true, low_stock_threshold: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

// D2 fixtures for the stock-filter proofs: low (0 < 3 ≤ threshold 5) and
// out (0 ≤ 0) — disjoint by construction. The header/signal proofs keep their
// original single-product fixture so their "Catalog ready" pin stays valid.
const stockProducts = [
    ...products,
    { id: 'prod-2', name: 'Low Tee', price: 599, description: 'Basic tee', category: 'Apparel', sku: 'LT-1', status: 'active', is_active: true, quantity: 3, track_quantity: true, low_stock_threshold: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'prod-3', name: 'Out Cap', price: 450, description: 'Cap', category: 'Apparel', sku: 'OC-1', status: 'active', is_active: true, quantity: 0, track_quantity: true, low_stock_threshold: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

// A8 MAJOR-1 fixture: a RETIRED but still-tracked zero-stock product. The
// server exception scan is `is_active: true` — this row belongs in neither
// the exception count (badge) nor the ?stock= filter (list).
const retiredStockProducts = [
    ...stockProducts,
    { id: 'prod-4', name: 'Retired Cap', price: 350, description: 'Retired line', category: 'Apparel', sku: 'RC-1', status: 'inactive', is_active: false, quantity: 0, track_quantity: true, low_stock_threshold: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

interface StockExceptionPayload {
    outOfStock: number;
    lowStock: number;
    exceptions: number;
    coverageComplete: boolean;
}
const stockExceptionPayload = (fx?: Partial<StockExceptionPayload>) => ({
    outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true,
    generated_at: '2026-01-01T00:00:00.000Z', ...fx,
});

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/dashboard/metrics',
    '/api/dashboard/queue', '/api/subscription', '/api/notifications/in-app', '/api/product',
    '/api/category', '/api/order', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/product/images',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/product\/[\w-]+$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, catalog: typeof products = products, exceptions?: Partial<StockExceptionPayload>) {
    const state = { signedIn: false, unexpected: [] as string[], createPayloads: [] as Record<string, unknown>[] };
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
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: stockExceptionPayload(exceptions) }) });
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
        if (path === '/api/product' && method === 'GET') return route.fulfill({ json: json(catalog) });
        if (path === '/api/product' && method === 'POST') {
            state.createPayloads.push(request.postDataJSON());
            return route.fulfill({ status: 201, json: json({ id: 'prod-new', name: 'New Product', price: 100 }) });
        }
        if (path === '/api/category') return route.fulfill({ json: json([{ id: 'cat-1', name: 'Apparel' }]) });
        if (path === '/api/order') return route.fulfill({ json: json([]) });
        if (path === '/api/product/images') return route.fulfill({ json: json({ url: 'https://example.com/img.png' }) });
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndGo(page: Page, target = '/products') {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto(target);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('page header: compact title + relocated count + table, no signal band, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    // Removal pinned: the page-level signal badge must not exist.
    await expect(page.getByTestId('products-signal')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Products & Inventory', exact: true })).toBeVisible();
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    // The catalog count survived band removal — it lives in the worklist toolbar.
    await expect(page.getByText(/Total:/)).toBeVisible();
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('upload dialog is labelled, traps focus, and closes on Escape', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Upload Product File' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'products-upload-title');
    await expect.poll(() => page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.contains(document.activeElement) : false;
    })).toBe(true);
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('add form publishes a product and returns to the worklist', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/products/add');
    await expect(page.getByRole('heading', { name: /add.*product/i })).toBeVisible({ timeout: 15_000 });
    await page.locator('#product-name').fill('New Product');
    await page.locator('#selling-price').fill('100');
    await page.getByRole('button', { name: /publish product/i }).click();
    await expect.poll(() => state.createPayloads.length).toBe(1);
    expect(state.createPayloads[0].name).toBe('New Product');
    expect(state.createPayloads[0].price).toBe(100);
    await expect(page).toHaveURL(/\/products$/);
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow on the worklist', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Products & Inventory', exact: true })).toBeVisible({ timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('axe: no critical or serious violations in the products surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Products & Inventory', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-products').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});

// ── Phase 1 W2 (A4) / W3 (A6): merchant-controlled stock filter (D2) ─────────
test('W2 stock control: segmented exception toggles replace the old checkbox, seed + clear work', async ({ page }) => {
    const state = await setupRoutes(page, stockProducts);
    await loginAndGo(page);
    await expect(page.getByTestId('products-stock-exceptions')).toBeVisible({ timeout: 15_000 });
    // Old parent-only checkbox vocabulary is gone (replaced by the D2 tri-state).
    await expect(page.getByText('Low stock only')).toHaveCount(0);
    await expect(page.locator('#lowStockOnly')).toHaveCount(0);
    // All three D2 products start visible.
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    // ?stock=exceptions seed (badge destination parity): exceptions = low ∪ out.
    await page.goto('/products?stock=exceptions');
    await expect(page.getByTestId('products-stock-exceptions')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    await expect(page.getByText('Demo Hoodie')).toHaveCount(0);
    // Narrow to out-of-stock only.
    await page.getByTestId('products-stock-out').click();
    await expect(page.getByText('Out Cap')).toBeVisible();
    await expect(page.getByText('Low Tee')).toHaveCount(0);
    // Low toggle replaces (single-select control), then clear restores all.
    await page.getByTestId('products-stock-low').click();
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toHaveCount(0);
    await page.getByTestId('products-stock-clear').click();
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    // Honest aria descriptions on the exception controls.
    await expect(page.getByTestId('products-stock-exceptions')).toHaveAttribute('aria-label', 'Show only products that are out of stock or low on stock');
    expect(state.unexpected).toEqual([]);
});

test('W2 unknown ?stock= seed fails closed to the full list (mirrors Orders bucket seed)', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/products?stock=bogus');
    await expect(page.getByTestId('products-stock-exceptions')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

// A8 MAJOR-1 badge↔list parity: the nav badge (server scan, `is_active: true`
// scope) and the ?stock=exceptions list (client predicate) must agree — a
// retired-but-tracked product appears in NEITHER the count nor the filter,
// yet stays a normal catalog row.
test('badge↔list parity: retired-but-tracked product is in neither the exception count nor the ?stock= filter', async ({ page }) => {
    const state = await setupRoutes(page, retiredStockProducts, { outOfStock: 1, lowStock: 1, exceptions: 2, coverageComplete: true });
    await loginAndGo(page);
    const rail = page.locator('aside nav').first();

    // Catalog truth: the retired row is still a product (visible unfiltered),
    // but it carries no exception claim (badge stays at the server's 2).
    await expect(page.getByText('Retired Cap')).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Products 2 products have stock exceptions' })).toBeVisible();

    // Badge destination parity: the filtered list rows == the badge count.
    await page.goto('/products?stock=exceptions');
    await expect(page.getByText('Low Tee')).toBeVisible();
    await expect(page.getByText('Out Cap')).toBeVisible();
    await expect(page.getByText('Retired Cap')).toHaveCount(0);
    await expect(page.getByText('Demo Hoodie')).toHaveCount(0);
    const filteredRows = await page.getByRole('table').locator('tbody tr').count();
    expect(filteredRows).toBe(2);
    expect(state.unexpected).toEqual([]);
});
