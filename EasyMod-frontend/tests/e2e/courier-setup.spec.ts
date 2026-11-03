/**
 * Courier setup - Playwright system tests.
 *
 * The activation flow is intentionally API-isolated. Courier provider hosts are
 * never contacted; only the merchant delivery endpoints are mocked here.
 */

import { expect, test, type Page } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };

const deliverySettings = {
    default_delivery_charge: 60,
    cod_enabled: false,
    cod_charge: 0,
    non_refundable: false,
    area_pricing: [
        { zone: 'inside_dhaka', charge: 60, cod_enabled: false },
        { zone: 'sub_dhaka', charge: 80, cod_enabled: false },
        { zone: 'outside_dhaka', charge: 120, cod_enabled: false },
    ],
    weight_tiers: [{ from_kg: 0, to_kg: 1, extra_charge: 0 }],
};

type MockProvider = {
    provider: string;
    display_name: string;
    is_connected: boolean;
    is_active: boolean;
    is_sandbox: boolean;
    activation_status: 'NOT_CONFIGURED' | 'SETUP_INCOMPLETE' | 'VALIDATING' | 'ACTIVE' | 'ACTION_REQUIRED';
    activation_error: string | null;
    is_ai_default: boolean;
    missing: string[];
    pickup_enabled: boolean;
    pickup_location_id: string | null;
    pickup_summary: Record<string, unknown> | null;
    provider_store_id: string | number | null;
    provider_pickup_meta: Record<string, unknown> | null;
    metadata: Record<string, unknown>;
    last_validated_at: string | null;
    connected_at: string | null;
    setup_complete: boolean;
};

type CapturedRequest = {
    method: string;
    path: string;
    body: Record<string, unknown>;
};

// Mirrors EasyMod-backend/src/modules/delivery/provider-capabilities.js for the
// operations these tests assert. The backend module is the source of truth; the
// ceiling here is deliberately the same so the UI can never be shown a claim
// the server would refuse to make.
function capabilitiesFor(provider: string) {
    const implemented = { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' };
    const unsupportedInPortal = {
        level: 'UNSUPPORTED',
        reason_code: 'NO_PROVIDER_API',
        manual_step_code: 'CANCEL_IN_PROVIDER_PORTAL',
    };
    const capabilities: Record<string, unknown> = {
        version: 1,
        ceiling: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
        last_verified_at: null,
        coverage: implemented,
        rate_quote: implemented,
        create_parcel: implemented,
        tracking: implemented,
        cancel: implemented,
        edit: implemented,
    };
    if (provider === 'steadfast') {
        return {
            ...capabilities,
            coverage: { level: 'UNKNOWN', reason_code: 'TEXT_ONLY_COVERAGE', manual_step_code: null },
            rate_quote: {
                level: 'UNSUPPORTED',
                reason_code: 'NO_PROVIDER_API',
                manual_step_code: 'RATE_SHOWN_AFTER_BOOKING',
            },
            cancel: unsupportedInPortal,
            edit: { ...unsupportedInPortal, manual_step_code: 'EDIT_IN_PROVIDER_PORTAL' },
        };
    }
    if (provider === 'pathao') {
        return {
            ...capabilities,
            cancel: unsupportedInPortal,
            edit: { ...unsupportedInPortal, manual_step_code: 'EDIT_IN_PROVIDER_PORTAL' },
        };
    }
    return capabilities;
}

function jsonResponse(data: unknown, status = 200) {
    return {
        status,
        contentType: 'application/json',
        body: JSON.stringify({ success: status < 400, data }),
    };
}

function providerStatus(provider: string, overrides: Partial<MockProvider> = {}): MockProvider {
    const displayName = `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Courier`;
    const metadata = overrides.metadata || {};
    const isConnected = overrides.is_connected ?? false;
    const isActive = overrides.is_active ?? false;
    const setupComplete = overrides.setup_complete ?? Boolean(
        metadata.pickup_name || metadata.pickup_phone || metadata.pickup_address,
    );
    const activationStatus = overrides.activation_status ?? (
        isActive ? 'ACTIVE' : isConnected ? (setupComplete ? 'ACTION_REQUIRED' : 'SETUP_INCOMPLETE') : 'NOT_CONFIGURED'
    );
    const missing = overrides.missing ?? (
        activationStatus === 'SETUP_INCOMPLETE' ? ['pickup_location', 'provider_store'] : []
    );

    return {
        provider,
        display_name: displayName,
        is_connected: isConnected,
        is_active: isActive,
        is_sandbox: false,
        activation_status: activationStatus,
        activation_error: null,
        is_ai_default: false,
        missing,
        pickup_enabled: false,
        pickup_location_id: null,
        pickup_summary: null,
        provider_store_id: null,
        provider_pickup_meta: null,
        metadata,
        last_validated_at: null,
        connected_at: null,
        setup_complete: setupComplete,
        ...overrides,
        activation_status: activationStatus,
        missing,
    };
}

async function setupRoutes(
    page: Page,
    options: {
        providers: MockProvider[];
    },
) {
    let authenticated = false;
    const providers = options.providers.map((provider) => ({
        ...provider,
        metadata: { ...provider.metadata },
    }));
    const requests: CapturedRequest[] = [];
    let pickupLocation: Record<string, unknown> | null = null;

    // Match request paths, not Vite source-module URLs that happen to contain /api/.
    await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        const method = route.request().method();
        const body = (route.request().postDataJSON() || {}) as Record<string, unknown>;

        if (path === '/api/csrf' && method === 'GET') {
            return route.fulfill(jsonResponse({ csrfToken: 'csrf-test' }));
        }

        if (path === '/api/auth/signin' && method === 'POST') {
            authenticated = true;
            return route.fulfill(jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }));
        }

        if (path === '/api/auth/me' && method === 'GET') {
            return route.fulfill(authenticated
                ? jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] })
                : {
                    status: 401,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: false, message: 'Unauthorized' }),
                });
        }

        if (path === '/api/shop/delivery/settings' && method === 'GET') {
            return route.fulfill(jsonResponse({
                providers: providers.map((provider) => ({
                    ...provider,
                    metadata: { ...provider.metadata },
                    capabilities: capabilitiesFor(provider.provider),
                })),
                settings: deliverySettings,
                pickup_locations: pickupLocation ? [pickupLocation] : [],
            }));
        }

        if (path === '/api/shop/delivery/pickup-locations' && method === 'GET') {
            return route.fulfill(jsonResponse(pickupLocation ? [pickupLocation] : []));
        }

        if (path === '/api/shop/delivery/pickup-locations' && method === 'POST') {
            requests.push({ method, path, body });
            pickupLocation = {
                id: 'pickup-1',
                display_name: String(body.display_name || ''),
                contact_name: String(body.contact_name || ''),
                phone: String(body.phone || ''),
                address: String(body.address || ''),
                area_name: String(body.area_name || ''),
                city_name: body.city_name || null,
                zone_name: body.zone_name || null,
                is_default: false,
            };
            return route.fulfill(jsonResponse(pickupLocation, 201));
        }

        const syncMatch = path.match(/^\/api\/shop\/delivery\/([^/]+)\/pickup\/sync$/);
        if (syncMatch && method === 'POST') {
            requests.push({ method, path, body });
            const provider = providers.find((item) => item.provider === syncMatch[1]);
            const providerPickupMeta = body.provider_pickup_meta;

            if (provider) {
                provider.setup_complete = true;
                provider.activation_status = 'SETUP_INCOMPLETE';
                provider.activation_error = null;
                provider.missing = [];
                provider.pickup_enabled = true;
                provider.pickup_location_id = pickupLocation ? String(pickupLocation.id) : null;
                provider.pickup_summary = pickupLocation;
                provider.provider_pickup_meta = providerPickupMeta && typeof providerPickupMeta === 'object'
                    ? providerPickupMeta as Record<string, unknown>
                    : {};
                provider.provider_store_id = provider.provider_pickup_meta?.pickup_store_id as string | number | null || null;
            }

            return route.fulfill(jsonResponse(provider
                ? {
                    provider: provider.provider,
                    pickup_enabled: provider.pickup_enabled,
                    pickup_location_id: provider.pickup_location_id,
                    pickup_store_id: provider.provider_store_id,
                }
                : {}));
        }

        if (path === '/api/shop/delivery/activate' && method === 'POST') {
            requests.push({ method, path, body });
            const providerName = String(body.provider || '');
            const provider = providers.find((item) => item.provider === providerName);

            if (provider && !provider.setup_complete) {
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        error: {
                             code: 'DELIVERY_NOT_READY',
                             message: 'Courier is not ready for activation',
                            details: {
                                provider: providerName,
                                missing: ['pickup_not_enabled', 'pickup_location_not_configured'],
                                reason: 'pickup_profile_required',
                            },
                        },
                    }),
                });
            }

            if (provider) {
                provider.is_active = true;
                provider.activation_status = 'ACTIVE';
                provider.activation_error = null;
                provider.missing = [];
            }

            return route.fulfill(jsonResponse({
                provider: providerName,
                is_active: provider?.is_active || false,
                activation_status: provider?.activation_status,
            }));
        }

        if (path === '/api/shop/delivery/deactivate' && method === 'POST') {
            requests.push({ method, path, body });
            const provider = providers.find((item) => item.provider === body.provider);
            if (provider) {
                provider.is_active = false;
                provider.is_ai_default = false;
                provider.activation_status = 'SETUP_INCOMPLETE';
            }
            return route.fulfill(jsonResponse(provider || {}));
        }

        if (path === '/api/shop/delivery/ai-default' && method === 'POST') {
            requests.push({ method, path, body });
            const providerName = String(body.provider || '');
            for (const provider of providers) {
                provider.is_ai_default = provider.provider === providerName;
            }
            const provider = providers.find((item) => item.provider === providerName);
            return route.fulfill(jsonResponse(provider || {}));
        }

        if (path === '/api/shop/delivery/pathao/cities' && method === 'GET') {
            return route.fulfill(jsonResponse({ cities: [{ id: 1, name: 'Dhaka' }] }));
        }

        const zonesMatch = path.match(/^\/api\/shop\/delivery\/pathao\/cities\/([^/]+)\/zones$/);
        if (zonesMatch && method === 'GET') {
            return route.fulfill(jsonResponse({ zones: [{ id: 10, city_id: Number(zonesMatch[1]), name: 'Dhanmondi Zone' }] }));
        }

        const areasMatch = path.match(/^\/api\/shop\/delivery\/pathao\/zones\/([^/]+)\/areas$/);
        if (areasMatch && method === 'GET') {
            return route.fulfill(jsonResponse({ areas: [{ id: 100, zone_id: Number(areasMatch[1]), name: 'Dhanmondi' }] }));
        }

        if (path === '/api/shop/me' && method === 'GET') {
            return route.fulfill(jsonResponse({ ...mockShop, settings: {} }));
        }

        if (path === '/api/notifications/in-app' && method === 'GET') {
            return route.fulfill(jsonResponse([]));
        }

        if (path.startsWith('/api/subscription')) {
            return route.fulfill(jsonResponse({ plan_code: 'SHURU', plan_name: 'Shuru', features: {} }));
        }

        return route.fulfill(jsonResponse({}));
    });

    // A mistaken direct provider request must fail locally rather than reach a courier host.
    await page.route((url) => /pathao|packzy|redx/i.test(new URL(url).hostname), (route) => route.abort());

    return { requests };
}

class SignInPage {
    constructor(private readonly page: Page) {}

    async login() {
        await this.page.goto('/signin');
        await this.page.getByLabel(/email/i).fill(mockUser.email);
        await this.page.getByLabel(/password/i).fill('password123');
        await this.page.getByRole('button', { name: /sign in/i }).click();
        await expect(this.page).toHaveURL(/\/dashboard$/);
    }
}

class DeliverySettingsPage {
    constructor(private readonly page: Page) {}

    providerHeading(name: string) {
        return this.page.getByRole('heading', { name, exact: true });
    }

    async goto() {
        await this.page.goto('/manage-shop/delivery-settings');
        await expect(this.page.getByRole('heading', { name: 'Delivery Settings', exact: true })).toBeVisible({
            timeout: 15_000,
        });
    }

    activateButton() {
        return this.page.getByRole('button', { name: /^Activate$/i });
    }

    setDefaultButton() {
        return this.page.getByRole('button', { name: 'Set as AI default', exact: true });
    }
}

async function loginAndGoToDelivery(page: Page) {
    await new SignInPage(page).login();
    const deliveryPage = new DeliverySettingsPage(page);
    await deliveryPage.goto();
    return deliveryPage;
}

function requestsFor(requests: CapturedRequest[], method: string, path: string) {
    return requests.filter((request) => request.method === method && request.path === path);
}

test('incomplete courier activation collects pickup details, validates, activates, and sets the AI default', async ({ page }) => {
    const fixture = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', {
                is_connected: true,
                is_active: false,
                connected_at: '2026-08-28T00:00:00.000Z',
                metadata: {
                    stores: [{ store_id: 'store-1', store_name: 'Main Pathao store' }],
                },
                missing: ['pickup_not_enabled', 'pickup_location_not_configured'],
            }),
            providerStatus('steadfast'),
            providerStatus('redx'),
        ],
    });
    const deliveryPage = await loginAndGoToDelivery(page);

    await expect(page.getByText('Setup incomplete', { exact: true })).toBeVisible();
    await expect(deliveryPage.activateButton()).toHaveCount(1);

    const activationRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/shop/delivery/activate' && request.method() === 'POST';
    });
    const activationResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/shop/delivery/activate' && response.request().method() === 'POST';
    });

    await deliveryPage.activateButton().click();

    expect((await activationRequest).postDataJSON()).toEqual({ provider: 'pathao' });
    expect((await activationResponse).status()).toBe(409);

    const pickupDialog = page.getByRole('dialog');
    await expect(pickupDialog).toBeVisible();
    await expect(pickupDialog.getByRole('heading', { name: 'Pickup details', exact: true })).toBeVisible();

    await pickupDialog.getByRole('textbox', { name: /^Pickup name/i }).fill('Test Owner');
    await pickupDialog.getByRole('textbox', { name: /^Pickup phone/i }).fill('01711000000');
    await pickupDialog.getByRole('textbox', { name: /^Pickup address/i }).fill('House 10, Road 2, Dhanmondi, Dhaka');
    const citySelect = pickupDialog.getByRole('combobox', { name: 'City', exact: true });
    const zoneSelect = pickupDialog.getByRole('combobox', { name: 'Zone', exact: true });
    const areaSelect = pickupDialog.getByRole('combobox', { name: 'Area', exact: true });
    await citySelect.selectOption('1');
    await expect(zoneSelect).toBeEnabled();
    await zoneSelect.selectOption('10');
    await expect(areaSelect).toBeEnabled();
    await areaSelect.selectOption('100');

    await pickupDialog.getByRole('button', { name: 'Save & validate', exact: true }).click();

    await expect.poll(() => requestsFor(
        fixture.requests,
        'POST',
        '/api/shop/delivery/pickup-locations',
    ).length).toBe(1);
    await expect.poll(() => requestsFor(
        fixture.requests,
        'POST',
        '/api/shop/delivery/pathao/pickup/sync',
    ).length).toBe(1);
    await expect.poll(() => requestsFor(
        fixture.requests,
        'POST',
        '/api/shop/delivery/activate',
    ).length).toBe(2);

    const pickupRequest = requestsFor(fixture.requests, 'POST', '/api/shop/delivery/pickup-locations')[0];
    expect(pickupRequest.body).toEqual({
        display_name: 'Test Owner',
        contact_name: 'Test Owner',
        phone: '01711000000',
        address: 'House 10, Road 2, Dhanmondi, Dhaka',
        area_name: 'Dhanmondi',
        city_name: 'Dhaka',
        zone_name: 'Dhanmondi Zone',
    });

    const syncRequest = requestsFor(fixture.requests, 'POST', '/api/shop/delivery/pathao/pickup/sync')[0];
    expect(syncRequest.body).toEqual({
        pickup_location_id: 'pickup-1',
        provider_pickup_meta: {
            city_id: 1,
            zone_id: 10,
            area_id: 100,
        },
    });

    const finalActivationRequest = requestsFor(fixture.requests, 'POST', '/api/shop/delivery/activate')[1];
    expect(finalActivationRequest.body).toEqual({ provider: 'pathao' });
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByText('Setup incomplete', { exact: true })).toHaveCount(0);

    const defaultRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/shop/delivery/ai-default' && request.method() === 'POST';
    });
    await deliveryPage.setDefaultButton().click();

    expect((await defaultRequest).postDataJSON()).toEqual({ provider: 'pathao' });
    await expect(page.getByText('AI Default', { exact: true })).toHaveCount(1);
    await expect(deliveryPage.providerHeading('Pathao Courier').locator('..').getByText('AI Default', { exact: true }))
        .toBeVisible();
});

test('switches the AI default between two active courier providers', async ({ page }) => {
    const fixture = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', {
                is_connected: true,
                is_active: true,
                setup_complete: true,
                activation_status: 'ACTIVE',
                is_ai_default: true,
                pickup_summary: {
                    id: 'pickup-pathao',
                    display_name: 'Pathao Pickup',
                    phone: '01711000001',
                    address: 'Dhanmondi, Dhaka',
                    area_name: 'Dhanmondi',
                    is_default: true,
                },
                metadata: {
                    pickup_name: 'Pathao Pickup',
                    pickup_phone: '01711000001',
                    pickup_address: 'Dhanmondi, Dhaka',
                },
            }),
            providerStatus('steadfast', {
                is_connected: true,
                is_active: true,
                setup_complete: true,
                activation_status: 'ACTIVE',
                pickup_summary: {
                    id: 'pickup-steadfast',
                    display_name: 'Steadfast Pickup',
                    phone: '01711000002',
                    address: 'Gulshan, Dhaka',
                    area_name: 'Gulshan',
                    is_default: false,
                },
                metadata: {
                    pickup_name: 'Steadfast Pickup',
                    pickup_phone: '01711000002',
                    pickup_address: 'Gulshan, Dhaka',
                },
            }),
            providerStatus('redx'),
        ],
    });
    const deliveryPage = await loginAndGoToDelivery(page);
    const pathaoHeading = deliveryPage.providerHeading('Pathao Courier');
    const steadfastHeading = deliveryPage.providerHeading('Steadfast Courier');

    await expect(pathaoHeading).toBeVisible();
    await expect(steadfastHeading).toBeVisible();
    await expect(page.getByText('Active', { exact: true })).toHaveCount(2);
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();
    await expect(deliveryPage.setDefaultButton()).toHaveCount(1);

    await deliveryPage.setDefaultButton().click();
    await expect.poll(() => requestsFor(fixture.requests, 'POST', '/api/shop/delivery/ai-default').length).toBe(1);
    expect(requestsFor(fixture.requests, 'POST', '/api/shop/delivery/ai-default')[0].body).toEqual({ provider: 'steadfast' });
    await expect(steadfastHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toHaveCount(0);

    await deliveryPage.setDefaultButton().click();
    await expect.poll(() => requestsFor(fixture.requests, 'POST', '/api/shop/delivery/ai-default').length).toBe(2);
    expect(requestsFor(fixture.requests, 'POST', '/api/shop/delivery/ai-default')[1].body).toEqual({ provider: 'pathao' });
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();
    await expect(page.getByText('AI Default', { exact: true })).toHaveCount(1);
});

test('states what each courier can do without claiming live verification', async ({ page }) => {
    await setupRoutes(page, {
        providers: [providerStatus('steadfast'), providerStatus('pathao')],
    });
    await loginAndGoToDelivery(page);

    const steadfast = page.getByTestId('provider-capabilities-steadfast');
    await expect(steadfast).toBeVisible();
    await expect(steadfast).toContainText('Never verified with a live account.');
    await steadfast.locator('summary').click();
    await expect(page.getByTestId('capability-steadfast-rate_quote')).toHaveText('Not supported');
    await expect(page.getByTestId('capability-steadfast-coverage')).toHaveText('Cannot be checked');
    await expect(page.getByTestId('capability-steadfast-create_parcel')).toHaveText('Implemented, not live-verified');
    await expect(steadfast).toContainText('The charge is shown after the parcel is created.');
    await expect(steadfast).toContainText('Cancel it in the courier');

    const pathao = page.getByTestId('provider-capabilities-pathao');
    await pathao.locator('summary').click();
    await expect(page.getByTestId('capability-pathao-cancel')).toHaveText('Not supported');
    await expect(page.getByTestId('capability-pathao-create_parcel')).toHaveText('Implemented, not live-verified');

    // Nothing above the ceiling may ever reach the merchant's screen.
    await expect(page.getByText('Live-verified', { exact: true })).toHaveCount(0);
});
