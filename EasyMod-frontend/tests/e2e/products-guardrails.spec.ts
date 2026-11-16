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

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/dashboard/metrics',
    '/api/dashboard/queue', '/api/subscription', '/api/notifications/in-app', '/api/product',
    '/api/category', '/api/order', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/product/images',
]);
const KNOWN_PATTERNS = [
    /^\/api\/product\/[\w-]+$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page) {
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
        if (path === '/api/product' && method === 'GET') return route.fulfill({ json: json(products) });
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

test('execution header: title + catalog signal + pills + table, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('products-signal')).toContainText('Catalog ready', { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Products & Inventory', exact: true })).toBeVisible();
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByText(/Total:/)).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText('Demo Hoodie')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('upload dialog is labelled, traps focus, and closes on Escape', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('products-signal')).toBeVisible({ timeout: 15_000 });
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
    await expect(page.getByTestId('products-signal')).toBeVisible({ timeout: 15_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('axe: no critical or serious violations in the products surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('products-signal')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-products').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
