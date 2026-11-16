/**
 * Delivery-settings guardrails proof (mock-only, CI subset). Execution-class
 * settings page (§29): channel signal header, provider lifecycle with the
 * activation-409 pickup flow, AI-default election, capability honesty ceiling,
 * disconnect confirmation. Allowlist+abort discipline: invented backend calls
 * fail here; courier provider hosts are always aborted.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const capabilities = {
    version: 1,
    ceiling: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
    coverage: { level: 'UNKNOWN', reason_code: 'TEXT_ONLY_COVERAGE' },
    rate_quote: { level: 'UNSUPPORTED', reason_code: 'NO_PROVIDER_API', manual_step_code: 'RATE_SHOWN_AFTER_BOOKING' },
    create_parcel: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' },
    tracking: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' },
    cancel: { level: 'UNSUPPORTED', reason_code: 'NO_PROVIDER_API', manual_step_code: 'CANCEL_IN_PROVIDER_PORTAL' },
    edit: { level: 'UNSUPPORTED', reason_code: 'NO_PROVIDER_API', manual_step_code: 'EDIT_IN_PROVIDER_PORTAL' },
    last_verified_at: null,
};

const providerStatus = (provider: string, overrides: Record<string, unknown> = {}) => ({
    provider,
    display_name: `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Courier`,
    is_connected: false,
    is_active: false,
    is_sandbox: false,
    metadata: {},
    last_validated_at: null,
    connected_at: null,
    capabilities,
    ...overrides,
});

const settings = {
    default_delivery_charge: 60,
    cod_enabled: false,
    cod_charge: 0,
    non_refundable: false,
    area_pricing: [],
    weight_tiers: [],
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/shop/delivery/settings', '/api/shop/delivery/pickup-locations',
]);
const KNOWN_PATTERNS = [
    /^\/api\/shop\/delivery\/(connect|disconnect|test|activate|deactivate|ai-default)$/,
    /^\/api\/shop\/delivery\/[\w-]+\/pickup\/sync$/,
    /^\/api\/shop\/delivery\/pathao\/cities$/,
    /^\/api\/shop\/delivery\/pathao\/cities\/[\w-]+\/zones$/,
    /^\/api\/shop\/delivery\/pathao\/zones\/[\w-]+\/areas$/,
    /^\/api\/shop\/delivery\/[\w-]+\/areas$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, options: { providers?: unknown[] } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        activates: 0,
        disconnects: 0,
        aiDefaults: 0,
        pickupPosts: 0,
        syncs: 0,
        providers: options.providers ?? [providerStatus('pathao'), providerStatus('steadfast'), providerStatus('redx')],
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
            const registryHash = `sha256:${'a'.repeat(64)}`;
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash, decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/shop/delivery/settings' && method === 'GET') {
            return route.fulfill({ json: json({ providers: state.providers, settings, pickup_locations: [] }) });
        }
        if (path === '/api/shop/delivery/activate' && method === 'POST') {
            state.activates += 1;
            const body = request.postDataJSON() as { provider: string };
            const target = state.providers.find((p) => (p as { provider: string }).provider === body.provider) as Record<string, unknown>;
            if (state.activates === 1 && target && !target.setup_complete) {
                return route.fulfill({
                    status: 409,
                    json: {
                        success: false,
                        error: { code: 'DELIVERY_NOT_READY', details: { missing: ['pickup_not_enabled', 'pickup_location_not_configured'] }, reason: 'pickup_profile_required' },
                    },
                });
            }
            if (target) {
                target.is_active = true;
                target.activation_status = 'ACTIVE';
                target.setup_complete = true;
            }
            return route.fulfill({ json: json({ provider: body.provider, activation_status: 'ACTIVE' }) });
        }
        if (path === '/api/shop/delivery/pickup-locations' && method === 'POST') {
            state.pickupPosts += 1;
            return route.fulfill({ status: 201, json: json({ id: 'pickup-1', ...(request.postDataJSON() as object) }) });
        }
        if (/^\/api\/shop\/delivery\/[\w-]+\/pickup\/sync$/.test(path) && method === 'POST') {
            state.syncs += 1;
            return route.fulfill({ json: json({ ok: true }) });
        }
        if (path === '/api/shop/delivery/ai-default' && method === 'POST') {
            state.aiDefaults += 1;
            const body = request.postDataJSON() as { provider: string };
            state.providers = state.providers.map((p) => ({
                ...(p as object),
                is_ai_default: (p as { provider: string }).provider === body.provider,
            }));
            return route.fulfill({ json: json({ provider: body.provider }) });
        }
        if (path === '/api/shop/delivery/disconnect' && method === 'POST') {
            state.disconnects += 1;
            const body = request.postDataJSON() as { provider: string };
            state.providers = state.providers.map((p) => (
                (p as { provider: string }).provider === body.provider
                    ? { ...(p as object), is_connected: false, is_active: false, activation_status: 'NOT_CONFIGURED' }
                    : p
            ));
            return route.fulfill({ json: json({ disconnected: true }) });
        }
        if (path === '/api/shop/delivery/pathao/cities') {
            return route.fulfill({ json: json({ cities: [{ id: 1, name: 'Dhaka' }] }) });
        }
        if (/^\/api\/shop\/delivery\/pathao\/cities\/[\w-]+\/zones$/.test(path)) {
            return route.fulfill({ json: json({ zones: [{ id: 10, city_id: 1, name: 'Dhanmondi Zone' }] }) });
        }
        if (/^\/api\/shop\/delivery\/pathao\/zones\/[\w-]+\/areas$/.test(path)) {
            return route.fulfill({ json: json({ areas: [{ id: 100, zone_id: 10, name: 'Dhanmondi' }] }) });
        }
        return route.fulfill({ json: json([]) });
    });
    await page.route((url) => /pathao|packzy|redx/i.test(url.hostname), (route) => route.abort());
    return state;
}

async function loginAndGo(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/manage-shop/delivery-settings');
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
    await expect(page.getByRole('heading', { name: 'Delivery Settings', exact: true })).toBeVisible();
    await expect(page.getByTestId('delivery-signal')).toContainText('Couriers need setup');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('activation 409 collects pickup details, validates, syncs and activates', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: false, missing: ['pickup_not_enabled', 'pickup_location_not_configured'] }),
            providerStatus('steadfast'),
            providerStatus('redx'),
        ],
    });
    await loginAndGo(page);
    await expect(page.getByText('Setup incomplete', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Activate$/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Pickup details', exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: /^Pickup name/i }).fill('Test Owner');
    await dialog.getByRole('textbox', { name: /^Pickup phone/i }).fill('01711000000');
    await dialog.getByRole('textbox', { name: /^Pickup address/i }).fill('House 10, Road 2, Dhanmondi, Dhaka');
    await dialog.getByRole('combobox', { name: 'City', exact: true }).selectOption('1');
    await dialog.getByRole('combobox', { name: 'Zone', exact: true }).selectOption('10');
    await dialog.getByRole('combobox', { name: 'Area', exact: true }).selectOption('100');
    await dialog.getByRole('button', { name: 'Save & validate', exact: true }).click();
    await expect.poll(() => state.pickupPosts).toBe(1);
    await expect.poll(() => state.syncs).toBe(1);
    await expect.poll(() => state.activates).toBe(2);
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('AI default election moves the badge between active providers', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true, is_ai_default: true }),
            providerStatus('steadfast', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true }),
        ],
    });
    await loginAndGo(page);
    const pathaoHeading = page.getByRole('heading', { name: 'Pathao Courier', exact: true });
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Set as AI default', exact: true }).click();
    await expect.poll(() => state.aiDefaults).toBe(1);
    const steadfastHeading = page.getByRole('heading', { name: 'Steadfast Courier', exact: true });
    await expect(steadfastHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('capability truth stays below the live-verification ceiling', async ({ page }) => {
    await setupRoutes(page, { providers: [providerStatus('steadfast', { is_connected: true }), providerStatus('pathao')] });
    await loginAndGo(page);
    const steadfast = page.getByTestId('provider-capabilities-steadfast');
    await expect(steadfast).toContainText('Never verified with a live account.');
    await steadfast.locator('summary').click();
    await expect(page.getByTestId('capability-steadfast-rate_quote')).toHaveText('Not supported');
    await expect(page.getByTestId('capability-steadfast-coverage')).toHaveText('Cannot be checked');
    await expect(page.getByTestId('capability-steadfast-create_parcel')).toHaveText('Implemented, not live-verified');
    await expect(steadfast).toContainText('Cancel it in the courier');
    await expect(page.getByText('Live-verified', { exact: true })).toHaveCount(0);
});

test('disconnect requires an in-system danger confirmation', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await page.getByTestId('disconnect-pathao').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(state.disconnects).toBe(0);
    await page.getByTestId('disconnect-pathao').click();
    await page.getByTestId('delivery-disconnect-confirm').click();
    await expect.poll(() => state.disconnects).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow and six mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('delivery-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(6);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the delivery surface', async ({ page }) => {
    await setupRoutes(page, { providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })] });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('delivery-signal')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-delivery').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
