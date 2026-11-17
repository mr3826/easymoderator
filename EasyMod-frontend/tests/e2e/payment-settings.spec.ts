/**
 * Payment Settings - Playwright system tests.
 *
 * Tests the current COD + bKash payment gateway UI. Nagad and Rocket are not
 * rendered in the current component. Merchant API mode is tested as
 * presentation only because the backend does not support merchant credentials
 * under the self-mfs gateway.
 */

import { expect, test, type Page } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };

function jsonResponse(data: unknown, status = 200) {
    return {
        status,
        contentType: 'application/json',
        body: JSON.stringify({ success: status < 400, data }),
    };
}

async function setupRoutes(page: Page, options: { savedConfigs?: any[] } = {}) {
    let authenticated = false;
    const savedConfigs = options.savedConfigs || [];

    await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        const method = route.request().method();

        if (path === '/api/csrf') return route.fulfill(jsonResponse({ csrfToken: 'csrf-test' }));
        if (path === '/api/auth/signin' && method === 'POST') {
            authenticated = true;
            return route.fulfill(jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }));
        }
        if (path === '/api/auth/me') {
            return route.fulfill(authenticated
                ? jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] })
                : jsonResponse({}, 401));
        }
        if (path === '/api/payment/config' && method === 'GET') {
            return route.fulfill(jsonResponse(savedConfigs));
        }
        if (path === '/api/payment/config/test' && method === 'POST') {
            return route.fulfill(jsonResponse({ success: true, message: 'Connection verified' }));
        }
        if (path === '/api/payment/config' && method === 'POST') {
            return route.fulfill(jsonResponse({ id: 'cfg-1', gateway: 'self-mfs', is_enabled: false }));
        }
        if (path.startsWith('/api/payment/config/') && method === 'DELETE') {
            return route.fulfill(jsonResponse({ success: true }));
        }
        if (path === '/api/shop/me') {
            return route.fulfill(jsonResponse({ ...mockShop, settings: {} }));
        }
        if (path === '/api/shop/platform-priority') {
            return route.fulfill(jsonResponse({ payment: [], delivery: [] }));
        }
        if (path === '/api/shop/update') {
            return route.fulfill(jsonResponse({}));
        }
        if (path === '/api/notifications/in-app') {
            return route.fulfill(jsonResponse([]));
        }
        if (path.startsWith('/api/subscription')) {
            return route.fulfill(jsonResponse({ plan_code: 'SHURU', plan_name: 'Shuru', features: {} }));
        }

        return route.fulfill(jsonResponse({}));
    });
}

async function loginAndGo(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill(mockUser.email);
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/manage-shop/payment-settings');
    // Wait for the Suspense-loaded PaymentSettings component to mount
    await expect(page.getByRole('heading', { name: 'Payment Settings' })).toBeVisible({ timeout: 15_000 });
    // Gateway cards render after lazy chunk loads; allow extra time
    await expect(page.getByText('Cash on Delivery')).toBeVisible({ timeout: 15_000 });
}

test('payment settings page loads with COD and bKash', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);

    await expect(page.getByText('Cash on Delivery')).toBeVisible();
    await expect(page.getByText('bKash', { exact: true })).toBeVisible();
});

test('bKash expand reveals self-MFS phone input', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);

    // Expand the bKash card via its stable testid (redesign migrated off class locators)
    await page.locator('[data-testid="gateway-expand-bkash"]').click();

    await expect(page.getByPlaceholder('01XXXXXXXXX')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Self MFS/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Merchant API/i })).toBeVisible();
});

test('reload hydrates the saved bKash receiver number from credential_summary', async ({ page }) => {
    await setupRoutes(page, {
        savedConfigs: [{
            gateway: 'self-mfs',
            is_enabled: true,
            credential_summary: {
                has_credentials: true,
                mfs_type: 'bkash',
                mfs_mode: 'self',
                mfs_number: '01711000000',
            },
        }],
    });
    await loginAndGo(page);

    await page.locator('[data-testid="gateway-expand-bkash"]').click();
    await expect(page.getByPlaceholder('01XXXXXXXXX')).toHaveValue('01711000000');
});

test('save bKash self-MFS calls test then save endpoint', async ({ page }) => {
    await setupRoutes(page);
    let testCalled = false;
    let saveCalled = false;

    await page.route((url) => new URL(url).pathname === '/api/payment/config/test', async (route) => {
        testCalled = true;
        const body = route.request().postDataJSON();
        expect(body.gateway).toBe('self-mfs');
        expect(body.credentials.mfs_number).toBe('01711000000');
        return route.fulfill(jsonResponse({ success: true, message: 'Verified' }));
    });
    await page.route((url) => new URL(url).pathname === '/api/payment/config', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        saveCalled = true;
        return route.fulfill(jsonResponse({ id: 'cfg-1', gateway: 'self-mfs', is_enabled: false }));
    });

    await loginAndGo(page);

    // Expand the bKash card via its stable testid (redesign migrated off class locators)
    await page.locator('[data-testid="gateway-expand-bkash"]').click();
    await page.getByPlaceholder('01XXXXXXXXX').fill('01711000000');
    await page.getByRole('button', { name: /Save bKash/i }).click();

    await expect.poll(() => testCalled).toBe(true);
    await expect.poll(() => saveCalled).toBe(true);
});

test('advance payment radio selection changes state', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);

    await expect(page.locator('input[name="advance-payment"][value="none"]')).toBeChecked();

    await page.locator('input[name="advance-payment"][value="percentage"]').check();
    await expect(page.locator('input[name="advance-payment"][value="percentage"]')).toBeChecked();
    await expect(page.locator('input[type="number"]:not([disabled])')).toBeVisible();
});
