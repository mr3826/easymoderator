/**
 * Delivery-settings guardrails proof (mock-only, CI subset). Three-tab
 * Configuration/editor surface (§5.6/§5.9/§29): execution header with no CTA,
 * tablist contract, provider lifecycle with the activation-409 → Pickup-TAB
 * routing, provider-first pickup stores (explicit link, never first-match),
 * DELIVERY_PICKUP_AMBIGUOUS explicit candidate selection, merchant-confirmed
 * external store create, safe-delete confirm round, charges save in-tab,
 * AI-default election + clear, type-to-confirm disconnect, capability honesty
 * ceiling. Allowlist+abort discipline: invented backend calls fail here; courier
 * provider hosts are always aborted. Responsive: 390px + 360px (pickup tab)
 * no-horizontal-overflow + five bottom-nav links; axe on `.em-delivery` across
 * all three tabs under reducedMotion.
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

const defaultLocations = () => ([
    {
        id: 'loc-a', display_name: 'HQ Warehouse', contact_name: 'Test Owner', phone: '01711000000',
        address: 'House 1, Dhanmondi', area_name: 'Dhanmondi', city_name: 'Dhaka', zone_name: 'Zone 1',
        provider: 'manual', provider_store_id: null, is_active: true, is_default: true, metadata: {},
    },
    {
        id: 'loc-b', display_name: 'North Hub', contact_name: 'Staff', phone: '01711000001',
        address: 'Road 9, Gulshan', area_name: 'Gulshan', city_name: 'Dhaka', zone_name: 'Zone 2',
        provider: 'pathao', provider_store_id: 's2', is_active: true, is_default: false, metadata: {},
    },
]);

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/shop/delivery/settings', '/api/shop/delivery/pickup-locations',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/shop\/delivery\/(connect|disconnect|test|activate|deactivate|ai-default)$/,
    // Redesign (2026-11-25): pickup tab endpoints — must stay in lockstep with
    // src/api/domains/order.ts. Any NEW client call failing here needs a pattern.
    /^\/api\/shop\/delivery\/pickup-locations\/[\w-]+$/,                 // GET/PUT/PATCH/DELETE (:id) — DELETE may carry ?confirm=true
    /^\/api\/shop\/delivery\/pickup-locations\/[\w-]+\/default$/,        // POST/PUT set-default
    /^\/api\/shop\/delivery\/[\w-]+\/pickup$/,                           // POST/PUT explicit link (setProviderPickup)
    /^\/api\/shop\/delivery\/[\w-]+\/pickup\/store$/,                    // POST merchant-confirmed external create
    /^\/api\/shop\/delivery\/[\w-]+\/stores$/,                           // GET provider store list
    /^\/api\/shop\/delivery\/[\w-]+\/stores\/sync$/,                     // GET/POST selective import/upsert
    /^\/api\/shop\/delivery\/[\w-]+\/ai-default$/,                       // POST set / DELETE clear (per-provider form)
    /^\/api\/shop\/delivery\/[\w-]+\/pickup\/sync$/,
    /^\/api\/shop\/delivery\/pathao\/cities$/,
    /^\/api\/shop\/delivery\/pathao\/cities\/[\w-]+\/zones$/,
    /^\/api\/shop\/delivery\/pathao\/zones\/[\w-]+\/areas$/,
    /^\/api\/shop\/delivery\/[\w-]+\/areas$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

type RouteState = Awaited<ReturnType<typeof setupRoutes>>;

async function setupRoutes(page: Page, options: {
    providers?: unknown[];
    locations?: unknown[];
    /** 'explicit' → POST /:provider/pickup succeeds; 'ambiguous' → 409 with candidates. */
    linkMode?: 'explicit' | 'ambiguous';
} = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        activates: 0,
        disconnects: 0,
        aiDefaults: 0,
        aiDefaultClears: 0,
        pickupPosts: 0,
        syncs: 0,
        syncBodies: [] as Record<string, unknown>[],
        linkBodies: [] as Record<string, unknown>[],
        storesGets: [] as string[],
        storesSyncs: [] as Record<string, unknown>[],
        createStoreBodies: [] as Record<string, unknown>[],
        deleteAttempts: [] as { path: string; confirmed: boolean }[],
        defaultPosts: [] as string[],
        settingsPuts: [] as Record<string, unknown>[],
        linkMode: options.linkMode ?? 'explicit',
        providers: options.providers ?? [providerStatus('pathao'), providerStatus('steadfast'), providerStatus('redx')],
        locations: (options.locations ?? defaultLocations()) as Record<string, unknown>[],
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
        const body = (request.postDataJSON() || {}) as Record<string, unknown>;
        const ok = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json(data)) });

        if (path === '/api/order/counts' && method === 'GET') {
            return ok({ to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return ok({ count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return ok({ outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return ok({ provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] });
        }
        if (path === '/api/channels/meta' && method === 'GET') return ok([]);

        if (path === '/api/csrf') return ok({ csrfToken: 'csrf-test' });
        if (path === '/api/auth/me') {
            if (!state.signedIn) return route.fulfill({ status: 401, json: { success: false } });
            return ok({ user: mockUser, currentShop: mockShop, allShops: [mockShop] });
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            state.signedIn = true;
            return ok({ user: mockUser, currentShop: mockShop, allShops: [mockShop] });
        }
        if (path === '/api/setup/status') return ok({ complete: true });
        if (path === '/api/subscription') return ok({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' });
        if (path === '/api/commercial/claims') {
            const surface = url.searchParams.get('surface') ?? 'usage-banner';
            return ok({ surface, locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] });
        }
        if (path === '/api/public/commercial-contract') {
            return ok({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` });
        }
        if (path === '/api/notifications/in-app') return ok([]);

        if (path === '/api/shop/delivery/settings') {
            if (method === 'PUT') {
                state.settingsPuts.push(body);
                return ok(body);
            }
            return ok({ providers: state.providers, settings, pickup_locations: state.locations });
        }
        if (path === '/api/shop/delivery/activate' && method === 'POST') {
            state.activates += 1;
            const target = state.providers.find((p) => (p as { provider: string }).provider === body.provider) as Record<string, unknown>;
            if (state.activates === 1 && target && !target.setup_complete) {
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        error: { code: 'DELIVERY_NOT_READY', details: { missing: ['pickup_not_enabled', 'pickup_location_not_configured'] }, reason: 'pickup_profile_required' },
                    }),
                });
            }
            if (target) {
                target.is_active = true;
                target.activation_status = 'ACTIVE';
                target.setup_complete = true;
            }
            return ok({ provider: body.provider, activation_status: 'ACTIVE' });
        }
        if (path === '/api/shop/delivery/ai-default' && method === 'POST') {
            state.aiDefaults += 1;
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => ({ ...p, is_ai_default: p.provider === body.provider }));
            return ok({ provider: body.provider });
        }
        if (/^\/api\/shop\/delivery\/([\w-]+)\/ai-default$/.test(path) && method === 'DELETE') {
            state.aiDefaultClears += 1;
            const provider = /([\w-]+)\/ai-default$/.exec(path)?.[1];
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => ({ ...p, is_ai_default: p.provider !== provider && p.is_ai_default === true }));
            return ok({ cleared: true });
        }
        if (path === '/api/shop/delivery/ai-default' && method === 'DELETE') {
            state.aiDefaultClears += 1;
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => ({ ...p, is_ai_default: false }));
            return ok({ cleared: true });
        }
        if (path === '/api/shop/delivery/disconnect' && method === 'POST') {
            state.disconnects += 1;
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => (
                p.provider === body.provider
                    ? { ...p, is_connected: false, is_active: false, activation_status: 'NOT_CONFIGURED', is_ai_default: false }
                    : p
            ));
            return ok({ disconnected: true });
        }
        if (path === '/api/shop/delivery/test' && method === 'POST') {
            const target = state.providers.find((p) => (p as { provider: string }).provider === body.provider) as Record<string, unknown>;
            if (target) target.last_validated_at = '2026-11-25T10:00:00.000Z';
            return ok({ valid: true });
        }
        if (path === '/api/shop/delivery/pickup-locations' && method === 'POST') {
            state.pickupPosts += 1;
            const created = { id: 'pickup-new', is_active: true, is_default: false, metadata: {}, ...body };
            state.locations = [...state.locations, created];
            return ok(created, 201);
        }
        if (path === '/api/shop/delivery/pickup-locations' && method === 'GET') {
            return ok(state.locations);
        }
        // Pickup-location :id routes (order matters: more specific default first).
        const defaultMatch = /^\/api\/shop\/delivery\/pickup-locations\/([\w-]+)\/default$/.exec(path);
        if (defaultMatch && (method === 'POST' || method === 'PUT')) {
            state.defaultPosts.push(defaultMatch[1]);
            state.locations = state.locations.map((l) => ({ ...l, is_default: l.id === defaultMatch[1] }));
            return ok(state.locations.find((l) => l.id === defaultMatch[1]));
        }
        const locationMatch = /^\/api\/shop\/delivery\/pickup-locations\/([\w-]+)$/.exec(path);
        if (locationMatch && method === 'DELETE') {
            const confirmed = url.searchParams.get('confirm') === 'true';
            state.deleteAttempts.push({ path, confirmed });
            if (!confirmed) {
                // Safe-delete guard: blocked until the merchant confirms through the dialog.
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        message: 'Pickup location is in use. Confirm the deletion to continue.',
                        code: 'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
                        details: {
                            location_id: locationMatch[1],
                            requires_confirmation: true,
                            blockers: [
                                { code: 'IS_SHOP_DEFAULT', message: 'This is the shop default pickup location. Choose another default first.' },
                                { code: 'IN_USE', message: 'This pickup location is the selected pickup for a courier integration.', providers: ['pathao'] },
                            ],
                        },
                    }),
                });
            }
            state.locations = state.locations.filter((l) => l.id !== locationMatch[1]);
            return ok({ id: locationMatch[1], deleted: true, released_providers: ['pathao'] });
        }
        // Provider store workspace.
        const storesMatch = /^\/api\/shop\/delivery\/([\w-]+)\/stores$/.exec(path);
        if (storesMatch && method === 'GET') {
            state.storesGets.push(storesMatch[1]);
            const provider = storesMatch[1];
            const stores = provider === 'pathao'
                // Two SAME-AREA stores: the UI must let the merchant choose — never first-match.
                ? [
                    { store_id: 's1', store_name: 'Dhanmondi Hub A', city_id: 1, zone_id: 10, area_id: 100 },
                    { store_id: 's2', store_name: 'Dhanmondi Hub B', city_id: 1, zone_id: 10, area_id: 100 },
                ]
                : [{ store_id: 'r1', store_name: 'RedX Gulshan Point', city_id: 7, area_id: 9 }];
            return ok({ provider, stores, pickup_locations: state.locations, capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED' });
        }
        const storesSyncMatch = /^\/api\/shop\/delivery\/([\w-]+)\/stores\/sync$/.exec(path);
        if (storesSyncMatch && (method === 'POST' || method === 'GET')) {
            state.storesSyncs.push({ provider: storesSyncMatch[1], ...body });
            return ok({ provider: storesSyncMatch[1], stores: [], pickup_locations: state.locations });
        }
        const storeCreateMatch = /^\/api\/shop\/delivery\/([\w-]+)\/pickup\/store$/.exec(path);
        if (storeCreateMatch && method === 'POST') {
            state.createStoreBodies.push({ provider: storeCreateMatch[1], ...body });
            return ok({ provider: storeCreateMatch[1], created: true, store: { store_id: 's-created', store_name: body.name }, pickup_locations: state.locations }, 201);
        }
        const pickupLinkMatch = /^\/api\/shop\/delivery\/([\w-]+)\/pickup$/.exec(path);
        if (pickupLinkMatch && (method === 'POST' || method === 'PUT')) {
            state.linkBodies.push({ provider: pickupLinkMatch[1], ...body });
            if (state.linkMode === 'ambiguous') {
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        message: 'Multiple provider pickup stores match this location. Select the intended store explicitly.',
                        code: 'DELIVERY_PICKUP_AMBIGUOUS',
                        details: {
                            provider: pickupLinkMatch[1],
                            pickup_location_id: body.pickup_location_id ?? null,
                            candidates: [
                                { store_id: 'alpha', store_name: 'Alpha Store', city_id: 1, zone_id: 10 },
                                { store_id: 'beta', store_name: 'Beta Store', city_id: 1, zone_id: 11 },
                            ],
                        },
                    }),
                });
            }
            // Mirrors delivery.service setPickupConfiguration's real return
            // shape: store_resolution is a SYNC-only field, not present here.
            return ok({ provider: pickupLinkMatch[1], pickup_enabled: true, pickup_store_id: body.store_id ?? null, pickup_location_id: body.pickup_location_id ?? null });
        }
        const syncMatch = /^\/api\/shop\/delivery\/([\w-]+)\/pickup\/sync$/.test(path);
        if (syncMatch && method === 'POST') {
            state.syncs += 1;
            state.syncBodies.push(body);
            const target = state.providers.find((p) => (p as { provider: string }).provider === body.provider) as Record<string, unknown>
                ?? state.providers.find((p) => path.includes(`/${(p as { provider: string }).provider}/`)) as Record<string, unknown>;
            if (target) target.setup_complete = true;
            return ok({ store_resolution: body.store_id ? 'LINKED' : 'MATCHED', pickup_enabled: true });
        }
        if (path === '/api/shop/delivery/pathao/cities') {
            return ok({ cities: [{ id: 1, name: 'Dhaka' }] });
        }
        if (/^\/api\/shop\/delivery\/pathao\/cities\/[\w-]+\/zones$/.test(path)) {
            return ok({ zones: [{ id: 10, city_id: 1, name: 'Dhanmondi Zone' }] });
        }
        if (/^\/api\/shop\/delivery\/pathao\/zones\/[\w-]+\/areas$/.test(path)) {
            return ok({ areas: [{ id: 100, zone_id: 10, name: 'Dhanmondi' }] });
        }
        return ok([]);
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

async function openTab(page: Page, tab: 'providers' | 'pickup' | 'charges') {
    await page.getByTestId(`delivery-tab-${tab}`).click();
    if (tab === 'charges') await expect(page.getByTestId('charges-tab')).toBeVisible();
    if (tab === 'pickup') await expect(page.getByTestId('pickup-add-location')).toBeVisible();
}

async function expectNoOverflow(page: Page) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
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

test('tab shell: three tabs, single mounted panel, arrow-key roving focus', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Courier Providers' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Courier Providers' })).toBeVisible();

    await openTab(page, 'pickup');
    await expect(page.getByRole('heading', { name: 'Pickup locations', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Courier Providers' })).toHaveCount(0);

    await openTab(page, 'charges');
    await expect(page.getByText('Saves the general, area and weight settings on this page.').first()).toBeVisible();

    await page.getByTestId('delivery-tab-providers').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'true');
    expect(state.unexpected).toEqual([]);
});

test('activation 409 from the drawer routes to the Pickup tab, then create → sync → explicit re-activate', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: false, activation_status: 'SETUP_INCOMPLETE', missing: ['pickup_not_enabled', 'pickup_location_not_configured'] }),
            providerStatus('steadfast'),
            providerStatus('redx'),
        ],
    });
    await loginAndGo(page);
    await expect(page.getByTestId('activation-status-pathao')).toContainText('Setup incomplete');

    await page.getByTestId('manage-pathao').click();
    const drawer = page.getByRole('dialog', { name: 'Manage Pathao Courier' });
    await expect(drawer).toBeVisible();
    await drawer.getByTestId('drawer-activate-pathao').click();

    // 409 → the shell switches to the Pickup tab with the create form for pathao.
    await expect(page.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'New Pathao pickup location' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const form = page.getByTestId('pickup-form');
    await form.getByTestId('pickup-form-name').fill('Test Owner');
    await form.getByLabel(/^Pickup phone/i).fill('01711000000');
    await form.getByTestId('pickup-form-address').fill('House 10, Road 2, Dhanmondi, Dhaka');
    await form.getByRole('combobox', { name: 'City', exact: true }).selectOption('1');
    await expect(form.getByRole('combobox', { name: 'Zone', exact: true })).toBeEnabled();
    await form.getByRole('combobox', { name: 'Zone', exact: true }).selectOption('10');
    await expect(form.getByRole('combobox', { name: 'Area', exact: true })).toBeEnabled();
    await form.getByRole('combobox', { name: 'Area', exact: true }).selectOption('100');
    await form.getByTestId('pickup-form-save').click();

    await expect.poll(() => state.pickupPosts).toBe(1);
    await expect.poll(() => state.syncs).toBe(1);
    expect(state.syncBodies[0]).toEqual(expect.objectContaining({ pickup_location_id: 'pickup-new' }));
    expect(state.syncBodies[0].provider_pickup_meta).toEqual({ city_id: 1, zone_id: 10, area_id: 100 });

    // Activation is now a SEPARATE explicit merchant action (§ "never conflate").
    await openTab(page, 'providers');
    await page.getByTestId('manage-pathao').click();
    await page.getByTestId('drawer-activate-pathao').click();
    await expect.poll(() => state.activates).toBe(2);
    await expect(page.getByTestId('activation-status-pathao')).toContainText('Active');
    expect(state.unexpected).toEqual([]);
});

test('pickup stores: explicit link of a chosen store — the first match is never used', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true }), providerStatus('redx', { is_connected: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');

    await page.getByTestId('pickup-fetch-stores-pathao').click();
    await expect(page.getByTestId('pickup-store-row-pathao-s1')).toBeVisible();
    await expect(page.getByTestId('pickup-store-row-pathao-s2')).toBeVisible();
    // Listing alone must not create anything external or link anything.
    expect(state.createStoreBodies).toHaveLength(0);
    expect(state.linkBodies).toHaveLength(0);

    // Both stores share one area (#1 · 10 · 100): the merchant picks the SECOND.
    await expect(page.getByTestId('pickup-store-row-pathao-s1').getByText('#1 · 10 · 100')).toBeVisible();
    await expect(page.getByTestId('pickup-store-row-pathao-s2').getByText('#1 · 10 · 100')).toBeVisible();
    await page.getByTestId('pickup-store-link-pathao-s2').click();
    await expect.poll(() => state.linkBodies.length).toBe(1);
    expect(state.linkBodies[0]).toEqual(expect.objectContaining({
        provider: 'pathao',
        store_id: 's2',
        pickup_location_id: 'loc-a',
        enabled: true,
    }));
    // resolution absent on the wire → UI resolves the real `resolutions.LINKED`
    // key ("Linked to the selected store."), never a guessed first store.
    await expect(page.getByTestId('pickup-message-pathao')).toContainText('Linked to the selected store.');
    expect(state.createStoreBodies).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
});

test('ambiguous 409 lists every candidate and re-syncs only with the merchant-chosen store id', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
        linkMode: 'ambiguous',
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-fetch-stores-pathao').click();
    await expect(page.getByTestId('pickup-store-row-pathao-s1')).toBeVisible();
    await page.getByTestId('pickup-store-link-pathao-s1').click();

    const dialog = page.getByRole('dialog', { name: 'Multiple pickup stores match' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('pickup-ambiguous-option-alpha')).toBeVisible();
    await expect(page.getByTestId('pickup-ambiguous-option-beta')).toBeVisible();
    await expect(page.getByTestId('pickup-ambiguous-confirm')).toBeDisabled();
    // No resolution without an explicit choice, and no auto external create.
    expect(state.syncBodies).toHaveLength(0);
    expect(state.createStoreBodies).toHaveLength(0);

    await page.getByTestId('pickup-ambiguous-option-beta').click();
    await expect(page.getByTestId('pickup-ambiguous-confirm')).toBeEnabled();
    await page.getByTestId('pickup-ambiguous-confirm').click();

    await expect.poll(() => state.syncs).toBe(1);
    expect(state.syncBodies[0]).toEqual(expect.objectContaining({ store_id: 'beta' }));
    await expect(dialog).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('external store create only fires after the explicit confirm step, with confirm=true', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-create-external-pathao').click();
    const dialog = page.getByRole('dialog', { name: 'New store at Pathao' });
    await expect(dialog).toBeVisible();
    expect(state.createStoreBodies).toHaveLength(0);

    await page.getByTestId('pickup-external-name').fill('Warehouse North');
    await page.getByTestId('pickup-external-address').fill('123 Ring Road, Dhaka');
    await page.getByTestId('pickup-external-request').click();
    // Confirm screen shows exactly what will be created at the courier — still no call.
    await expect(page.getByRole('heading', { name: 'Create this store at Pathao?' })).toBeVisible();
    await expect(page.getByText('Warehouse North')).toBeVisible();
    expect(state.createStoreBodies).toHaveLength(0);

    await page.getByTestId('pickup-external-confirm').click();
    await expect.poll(() => state.createStoreBodies.length).toBe(1);
    expect(state.createStoreBodies[0]).toEqual(expect.objectContaining({
        name: 'Warehouse North',
        address: '123 Ring Road, Dhaka',
        confirm: true,
    }));
    // After a create the tab re-reads the store list (no fabricated row).
    await expect.poll(() => state.storesGets.filter((p) => p === 'pathao').length).toBeGreaterThanOrEqual(1);
    expect(state.unexpected).toEqual([]);
});

test('safe delete: blocked round shows the server blockers, cancel does not delete, confirm re-issues with ?confirm=true', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await expect(page.getByTestId('pickup-location-row-loc-a')).toBeVisible();

    await page.getByTestId('pickup-delete-loc-a').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Delete “HQ Warehouse”?');
    await expect(page.getByTestId('pickup-delete-blockers')).toContainText('This is your default pickup location.');
    await expect(page.getByTestId('pickup-delete-blockers')).toContainText('In use by: pathao');
    await dialog.getByTestId('pickup-delete-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(state.deleteAttempts.every((a) => !a.confirmed)).toBe(true);

    await page.getByTestId('pickup-delete-loc-a').click();
    await page.getByTestId('pickup-delete-confirm').click();
    await expect.poll(() => state.deleteAttempts.filter((a) => a.confirmed).length).toBe(1);
    await expect(page.getByTestId('pickup-location-row-loc-a')).toHaveCount(0);
    await expect(page.getByTestId('pickup-location-row-loc-b')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('default switch posts the chosen location to the :id/default route', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-set-default-loc-b').click();
    await expect.poll(() => state.defaultPosts).toEqual(['loc-b']);
    await expect(page.getByTestId('pickup-location-default-loc-b')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('charges tab: identical save affordance saves all six keys in one PUT with the Saved indicator', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await openTab(page, 'charges');

    await expect(page.getByTestId('area-pricing-save')).toBeVisible();
    await expect(page.getByTestId('weight-charges-save')).toBeVisible();
    await expect(page.getByText('Saves the general, area and weight settings on this page.').first()).toBeVisible();

    await page.getByRole('spinbutton', { name: 'Default Delivery Charge' }).fill('75');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect.poll(() => state.settingsPuts.length).toBe(1);
    expect(state.settingsPuts[0]).toEqual(expect.objectContaining({ default_delivery_charge: 75 }));
    // The six persisted keys all travel in the single PUT.
    expect(Object.keys(state.settingsPuts[0] as object).sort()).toEqual([
        'area_pricing', 'cod_charge', 'cod_enabled', 'default_delivery_charge', 'non_refundable', 'weight_tiers',
    ]);
    await expect(page.getByText('Saved').first()).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('AI default election moves the badge between active providers; clear removes it', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true, is_ai_default: true }),
            providerStatus('steadfast', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true }),
        ],
    });
    await loginAndGo(page);
    const pathaoHeading = page.getByRole('heading', { name: 'Pathao Courier', exact: true });
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();

    // Set: the affordance lives in the management drawer.
    await page.getByTestId('manage-steadfast').click();
    await page.getByTestId('drawer-set-ai-steadfast').click();
    await expect.poll(() => state.aiDefaults).toBe(1);
    const steadfastHeading = page.getByRole('heading', { name: 'Steadfast Courier', exact: true });
    await expect(steadfastHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toHaveCount(0);

    // Clear (NEW-UI over the existing DELETE route). The drawer stays open after
    // the set action, so the clear affordance is right there in the same drawer.
    await page.getByTestId('drawer-clear-ai-steadfast').click();
    await expect.poll(() => state.aiDefaultClears).toBe(1);
    await expect(steadfastHeading.locator('..').getByText('AI Default', { exact: true })).toHaveCount(0);
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

test('disconnect requires a type-to-confirm danger dialog inside the provider drawer', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await page.getByTestId('manage-pathao').click();
    await page.getByTestId('disconnect-pathao').click();
    const dialog = page.getByRole('dialog', { name: /Are you sure you want to disconnect Pathao Courier/ });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('delivery-disconnect-confirm')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(state.disconnects).toBe(0);

    await page.getByTestId('disconnect-pathao').click();
    await dialog.getByLabel(/Type Pathao Courier to confirm/).fill('Pathao Courier');
    await expect(page.getByTestId('delivery-disconnect-confirm')).toBeEnabled();
    await page.getByTestId('delivery-disconnect-confirm').click();
    await expect.poll(() => state.disconnects).toBe(1);
    await expect(page.getByTestId('activation-status-pathao')).toContainText('Not configured');
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow and five mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('delivery-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    await expectNoOverflow(page);
});

test('360px pickup tab: store workspace and forms reflow without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await expect(page.getByTestId('pickup-provider-panel-pathao')).toBeVisible();
    await expect(page.getByTestId('pickup-location-row-loc-a')).toBeVisible();
    await page.getByTestId('pickup-add-location').click();
    await expect(page.getByTestId('pickup-form')).toBeVisible();
    await expectNoOverflow(page);
});

test('axe: no critical or serious violations in the delivery surface across all three tabs', async ({ page }) => {
    await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true }),
            providerStatus('steadfast'),
            providerStatus('redx', { is_connected: true }),
        ],
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('delivery-signal')).toBeVisible();
    await page.waitForTimeout(800);

    for (const tab of ['providers', 'pickup', 'charges'] as const) {
        if (tab !== 'providers') await openTab(page, tab);
        // Let the tab panel settle (pickup self-fetches locations + store panels).
        await page.waitForTimeout(400);
        const results = await new AxeBuilder({ page }).include('.em-delivery').analyze();
        const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
        expect(bad, `axe violations on the ${tab} tab`).toEqual([]);
    }
});
