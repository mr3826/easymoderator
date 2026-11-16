/**
 * Business-info guardrails proof (mock-only, CI subset). Execution-class
 * settings page (§29): profile signal header, label-associated form, dirty-gated
 * save with the 6-key payload (deliveryAreas/paymentMethods excluded) + shop-list
 * refresh, social group + char counter, load-error retry, automation link, and
 * the ADR-0013 §1 boundary (no AI control/radiogroup/range). Allowlist+abort
 * discipline: invented backend calls fail here.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const businessInfo = {
    shopName: 'Automation Test Shop',
    phone: '01711000000',
    address: 'Dhaka, Bangladesh',
    openingHours: '9am-6pm',
    additionalInfo: '',
    socialLinks: { facebook: 'https://facebook.com/test' },
    deliveryAreas: ['Dhaka'],
    paymentMethods: ['COD'],
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/shop/business-info', '/api/shop/list',
]);
const KNOWN_PATTERNS = [
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, options: { loadFails?: number } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        puts: 0,
        shopListCalls: 0,
        loadFails: options.loadFails ?? 0,
        lastPutBody: null as Record<string, unknown> | null,
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
        if (path === '/api/shop/business-info' && method === 'GET') {
            if (state.loadFails > 0) {
                state.loadFails -= 1;
                return route.fulfill({ status: 500, json: { success: false, error: { message: 'Network error' } } });
            }
            return route.fulfill({ json: json({ businessInfo, shop: mockShop }) });
        }
        if (path === '/api/shop/business-info' && method === 'PUT') {
            state.puts += 1;
            state.lastPutBody = request.postDataJSON();
            return route.fulfill({ json: json({ businessInfo: state.lastPutBody }) });
        }
        if (path === '/api/shop/list') {
            state.shopListCalls += 1;
            return route.fulfill({ json: json([mockShop]) });
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
    await page.goto('/manage-shop/business-info');
    await expect(page.getByTestId('business-signal')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + profile signal + pills, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Business Info', exact: true })).toBeVisible();
    await expect(page.getByTestId('business-signal')).toContainText('Profile ready');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByText(/Social links:/)).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('save is dirty-gated and PUTs the 6-key payload then refreshes the shop list', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).toBeDisabled();
    await expect(page.getByLabel('Shop Name')).toHaveValue('Automation Test Shop');
    await page.getByLabel('Shop Name').fill('Updated Shop');
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => state.puts).toBe(1);
    expect((state.lastPutBody as { shopName: string }).shopName).toBe('Updated Shop');
    expect(state.lastPutBody).not.toHaveProperty('deliveryAreas');
    expect(state.lastPutBody).not.toHaveProperty('paymentMethods');
    await expect.poll(() => state.shopListCalls).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole('status')).toContainText('Business info saved');
    expect(state.unexpected).toEqual([]);
});

test('load failure offers a retry that recovers the form', async ({ page }) => {
    // Fail every load until the test flips the flag, so the dev double-mounted
    // effect cannot consume a single injected failure before the effective load.
    const state = await setupRoutes(page, { loadFails: 99 });
    await loginAndGo(page);
    await expect(page.getByTestId('business-signal')).toContainText('Profile unavailable');
    await expect(page.getByRole('alert')).toBeVisible();
    state.loadFails = 0;
    await page.getByRole('button', { name: 'Retry loading' }).click();
    await expect(page.getByLabel('Shop Name')).toHaveValue('Automation Test Shop');
    expect(state.unexpected).toEqual([]);
});

test('social links are a labelled group and extra info shows a char counter', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    const group = page.getByRole('group', { name: 'Social Media Links' });
    await expect(group.getByLabel('Facebook')).toHaveValue('https://facebook.com/test');
    await expect(group.getByLabel('Website')).toBeVisible();
    await page.getByLabel('Extra shop information').fill('Hello');
    await expect(page.getByText('5/3000')).toBeVisible();
});

test('ADR-0013 boundary: automation link present, no AI control or radiogroup', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('business-info-automation-link')).toHaveAttribute('href', '/manage-shop/automation');
    await expect(page.getByTestId('ai-reply-mode')).toHaveCount(0);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.getByText('Save Reply Settings', { exact: true })).toHaveCount(0);
});

test('390px: no horizontal overflow and six mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('business-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(6);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the business-info surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('business-signal')).toBeVisible();
    await expect(page.getByLabel('Shop Name')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-business').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
