/**
 * Business & FAQ workspace shell proofs (A6 battery). Route truth: both
 * /manage-shop/business-info and /manage-shop/faqs render the SAME tabbed
 * workspace (BusinessFaqWorkspace) on their legacy tab; switching tabs is
 * local state (URL never changes, S6); only the active panel mounts (S7), so
 * tab data loads lazily and the e2e allowlists stay meaningful. Roving-focus
 * tablist (ArrowRight/Left wrap, Home/End) mirrors the delivery pattern.
 * Drawer focus discipline: trap cycles inside the dialog, Escape closes,
 * focus restores to the invoking control. 360px overflow pins for ALL three
 * tabs. Abort discipline: state.unexpected === [] everywhere.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const richFaq = {
    id: 'faq-1',
    question: 'What is the delivery charge?',
    category_tag: 'Delivery',
    answers: { en: 'Inside Dhaka delivery is 80 BDT.', bn: 'ঢাকার ভেতরে ডেলিভারি ৳৮০।' },
    keywords: [], notes: null,
    status: 'published', is_active: true, priority: 5, use_count: 3,
    created_at: '2026-07-04T00:00:00.000Z', updated_at: '2026-07-04T00:00:00.000Z',
    sync_status: 'synced', sync_version: 2, synced_at: '2026-07-04T00:10:00.000Z',
    answer: 'Inside Dhaka delivery is 80 BDT.',
    category: 'What is the delivery charge?',
    template_en: 'Inside Dhaka delivery is 80 BDT.', template_bn: 'ঢাকার ভেতরে ডেলিভারি ৳৮০।',
    confidence: 1.0, source: 'manual', active: true, usageCount: 3,
    createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
};

async function setupRoutes(page: Page) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        faqListCalls: 0,
        policiesGetCalls: 0,
        businessInfoGetCalls: 0,
    };
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known =
            ['/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
                '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
                '/api/shop/business-info', '/api/shop/business-policies', '/api/shop/list',
                '/api/knowledge/faqs', '/api/knowledge/gap-suggestions', '/api/knowledge/faq/search',
                '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta']
                .includes(path) ||
            /^\/api\/knowledge\/faqs\/[\w-]+(\/(archive|restore|resync))?$/.test(path) ||
            /^\/api\/knowledge\/gap-suggestions\/[\w-]+\/(review|dismiss|publish)$/.test(path);
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
        }
        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 } } });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } } });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } } });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] } } });
        }
        if (path === '/api/channels/meta' && method === 'GET') return route.fulfill({ json: { success: true, data: [] } });
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
            state.businessInfoGetCalls += 1;
            return route.fulfill({ json: json({ businessInfo: { shopName: 'Shell Test Shop', phone: '01711000000', socialLinks: { facebook: 'https://facebook.com/test' } }, shop: mockShop }) });
        }
        if (path === '/api/shop/list') return route.fulfill({ json: json([mockShop]) });
        if (path === '/api/shop/business-policies' && method === 'GET') {
            state.policiesGetCalls += 1;
            return route.fulfill({ json: json({ returns: { stance: 'offered', period_days: 7, details: 'Unworn with tags.' } }) });
        }
        if (path === '/api/knowledge/faqs' && method === 'GET') {
            state.faqListCalls += 1;
            return route.fulfill({ json: json([richFaq]) });
        }
        if (path === '/api/knowledge/gap-suggestions' && method === 'GET') {
            return route.fulfill({ status: 409, json: { success: false, error: { code: 'FEATURE_DISABLED' } } });
        }
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function signIn(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('both legacy URLs mount the workspace on their own initial tab', async ({ page }) => {
    const state = await setupRoutes(page);
    await signIn(page);
    await page.goto('/manage-shop/business-info');
    await expect(page.getByTestId('business-faq-tab-profile')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#business-faq-panel-profile')).toBeVisible();
    await page.goto('/manage-shop/faqs');
    await expect(page.getByTestId('business-faq-tab-faqs')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#business-faq-panel-faqs')).toBeVisible();
    // S7: exactly one panel mounted.
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    expect(state.unexpected).toEqual([]);
});

test('tab switching is local state: URL stays on the entry route (S6)', async ({ page }) => {
    const state = await setupRoutes(page);
    await signIn(page);
    await page.goto('/manage-shop/faqs');
    await expect(page.getByTestId('business-faq-tab-faqs')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('business-faq-tab-profile').click();
    await expect(page.getByTestId('business-faq-tab-profile')).toHaveAttribute('aria-selected', 'true');
    expect(page.url()).toContain('/manage-shop/faqs');
    await page.getByTestId('business-faq-tab-policies').click();
    await expect(page.getByTestId('policies-signal')).toBeVisible();
    expect(page.url()).toContain('/manage-shop/faqs');
    expect(state.unexpected).toEqual([]);
});

test('roving tablist keyboard: ArrowRight/Left wrap, Home/End jump, selection follows focus', async ({ page }) => {
    const state = await setupRoutes(page);
    await signIn(page);
    await page.goto('/manage-shop/business-info');
    await expect(page.getByLabel('Shop Name', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('business-faq-tab-profile').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('business-faq-tab-faqs')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('business-faq-tab-faqs')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('business-faq-tab-policies')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight'); // wraps (delivery pattern)
    await expect(page.getByTestId('business-faq-tab-profile')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('business-faq-tab-policies')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('business-faq-tab-profile')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('business-faq-tab-profile')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('business-faq-tab-policies')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('business-faq-tab-policies')).toBeFocused();
    expect(state.unexpected).toEqual([]);
});

test('lazy per-tab data: profile mount fetches neither FAQ nor policies endpoints', async ({ page }) => {
    const state = await setupRoutes(page);
    await signIn(page);
    await page.goto('/manage-shop/business-info');
    await expect(page.getByLabel('Shop Name', { exact: true })).toHaveValue('Shell Test Shop', { timeout: 15_000 });
    expect(state.businessInfoGetCalls).toBeGreaterThanOrEqual(1);
    expect(state.faqListCalls).toBe(0);
    expect(state.policiesGetCalls).toBe(0);
    await page.getByTestId('business-faq-tab-faqs').click();
    await expect(page.getByTestId('faq-row-faq-1')).toBeVisible();
    expect(state.faqListCalls).toBeGreaterThanOrEqual(1);
    expect(state.policiesGetCalls).toBe(0);
    await page.getByTestId('business-faq-tab-policies').click();
    await expect(page.getByTestId('policy-stance-returns')).toHaveValue('offered');
    expect(state.policiesGetCalls).toBeGreaterThanOrEqual(1);
    expect(state.unexpected).toEqual([]);
});

test('drawer focus trap cycles inside the dialog; Escape closes and restores focus', async ({ page }) => {
    const state = await setupRoutes(page);
    await signIn(page);
    await page.goto('/manage-shop/faqs');
    await expect(page.getByTestId('faq-signal')).toBeVisible({ timeout: 15_000 });
    const add = page.getByTestId('faq-add');
    await add.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Tab through every control — focus must never escape the dialog.
    for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => {
            const active = document.activeElement;
            return Boolean(active && active.closest('[role="dialog"]'));
        });
        expect(inside, `focus escaped the dialog after Tab #${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    expect(state.unexpected).toEqual([]);
});

test('360px across all three tabs: tablist scrolls, panels reflow, zero horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const state = await setupRoutes(page);
    await signIn(page);
    await page.goto('/manage-shop/business-info');
    await expect(page.getByTestId('business-faq-tab-profile')).toHaveAttribute('aria-selected', 'true');
    const overflowProfile = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowProfile).toBeLessThanOrEqual(0);
    await page.getByTestId('business-faq-tab-faqs').click();
    await expect(page.getByTestId('faq-row-faq-1')).toBeVisible();
    const overflowFaq = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowFaq).toBeLessThanOrEqual(0);
    await page.getByTestId('business-faq-tab-policies').click();
    await expect(page.getByTestId('policy-card-returns')).toBeVisible();
    const overflowPolicies = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowPolicies).toBeLessThanOrEqual(0);
    expect(state.unexpected).toEqual([]);
});
