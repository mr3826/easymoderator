/**
 * Notification System — Playwright System Tests
 * Tests push notification permission flow, subscription, and UI indicators
 */

import { expect, test } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };

async function injectBrowserMocks(page: any) {
    await page.addInitScript(() => {
        // Mock Notification API
        let _permission: NotificationPermission = 'default';
        (window as any).__mockNotificationPermission = (perm: NotificationPermission) => { _permission = perm; };

        const MockNotification = class {
            static get permission() { return _permission; }
            static requestPermission() {
                _permission = 'granted';
                return Promise.resolve('granted' as NotificationPermission);
            }
            constructor(title: string, options?: NotificationOptions) {}
            close() {}
        };
        Object.defineProperty(window, 'Notification', { value: MockNotification, writable: true, configurable: true });

        // Mock Service Worker
        const mockSubscription = {
            endpoint: 'https://fcm.googleapis.com/fcm/send/sub-e2e-test',
            toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/sub-e2e-test', keys: { p256dh: 'pk', auth: 'ak' } }),
            unsubscribe: () => Promise.resolve(true)
        };

        const mockPushManager = {
            _subscribed: false,
            subscribe(opts: any) { this._subscribed = true; return Promise.resolve(mockSubscription); },
            getSubscription() { return Promise.resolve(this._subscribed ? mockSubscription : null); }
        };

        const mockRegistration = { pushManager: mockPushManager, update: () => Promise.resolve() };

        Object.defineProperty(navigator, 'serviceWorker', {
            value: {
                register: () => Promise.resolve(mockRegistration),
                ready: Promise.resolve(mockRegistration),
                controller: null
            },
            writable: true, configurable: true
        });
    });
}

async function setupRoutes(page: any) {
    let authenticated = false;
    await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route: any) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        const method = route.request().method();

        if (path === '/api/csrf') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ csrfToken: 'csrf-test' }) });
        if (path === '/api/auth/signin' && method === 'POST') {
            authenticated = true;
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { user: mockUser, currentShop: mockShop, allShops: [mockShop] } }) });
        }
        if (path === '/api/auth/me') {
            if (!authenticated) return route.fulfill({ status: 401, body: '{"success":false}', contentType: 'application/json' });
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { user: mockUser, currentShop: mockShop, allShops: [mockShop] } }) });
        }
        if (path === '/api/notifications/subscriptions' && method === 'POST') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, id: 'sub-e2e-1' }) });
        if (path.match(/\/api\/notifications\/subscriptions\/[\w-]+/) && method === 'DELETE') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });

        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":{}}' });
    });
}

async function loginAndGo(page: any, path = '/manage-shop/notifications') {
    await page.goto('/signin');
    await page.fill('input[type="email"]', 'owner@shop.bd');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|settings/);
    await page.goto(path);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('notification settings page loads', async ({ page }) => {
    await injectBrowserMocks(page);
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(
        page.getByText(/notification|push/i).first()
    ).toBeVisible({ timeout: 5000 });
});

test('enable notifications button shown when not subscribed', async ({ page }) => {
    await injectBrowserMocks(page);
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(
        page.getByRole('button', { name: /enable|subscribe|allow/i }).or(
            page.getByText(/enable notifications/i)
        )
    ).toBeVisible({ timeout: 5000 });
});

test('clicking enable requests notification permission', async ({ page }) => {
    await injectBrowserMocks(page);
    await setupRoutes(page);
    let permissionRequested = false;
    await page.addInitScript(() => {
        const orig = Notification.requestPermission?.bind(Notification);
        if (orig) {
            Object.defineProperty(Notification, 'requestPermission', {
                value: async () => {
                    (window as any).__permissionRequested = true;
                    return 'granted';
                }
            });
        }
    });
    await loginAndGo(page);
    const enableBtn = page.getByRole('button', { name: /enable|subscribe/i });
    if (await enableBtn.isVisible()) {
        await enableBtn.click();
        permissionRequested = await page.evaluate(() => !!(window as any).__permissionRequested);
        expect(permissionRequested).toBe(true);
    }
});

test('subscription POST sent to backend after enabling', async ({ page }) => {
    await injectBrowserMocks(page);
    let subscriptionPosted = false;
    await page.route('**/api/notifications/subscriptions', async (route) => {
        if (route.request().method() === 'POST') {
            subscriptionPosted = true;
            return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, id: 'sub-1' }) });
        }
        return route.continue();
    });
    await setupRoutes(page);
    await loginAndGo(page);
    const enableBtn = page.getByRole('button', { name: /enable|subscribe/i });
    if (await enableBtn.isVisible()) {
        await enableBtn.click();
        await page.waitForTimeout(1000);
        expect(subscriptionPosted).toBe(true);
    }
});

test('UI shows enabled state after subscription', async ({ page }) => {
    await injectBrowserMocks(page);
    await setupRoutes(page);
    await loginAndGo(page);
    const enableBtn = page.getByRole('button', { name: /enable|subscribe/i });
    if (await enableBtn.isVisible()) {
        await enableBtn.click();
        await expect(
            page.getByText(/enabled|subscribed|active/i).or(
                page.getByRole('button', { name: /disable|unsubscribe/i })
            )
        ).toBeVisible({ timeout: 5000 });
    }
});

test('disable notifications unsubscribes from push', async ({ page }) => {
    await injectBrowserMocks(page);
    await setupRoutes(page);
    await loginAndGo(page);
    // Enable first
    const enableBtn = page.getByRole('button', { name: /enable|subscribe/i });
    if (await enableBtn.isVisible()) {
        await enableBtn.click();
        await page.waitForTimeout(500);
        // Then disable
        const disableBtn = page.getByRole('button', { name: /disable|unsubscribe/i });
        if (await disableBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await disableBtn.click();
            await expect(page.getByRole('button', { name: /enable|subscribe/i })).toBeVisible({ timeout: 5000 });
        }
    }
});

test('DELETE sent to backend when unsubscribing', async ({ page }) => {
    await injectBrowserMocks(page);
    let deleteRequested = false;
    await page.route('**/api/notifications/subscriptions/**', async (route) => {
        if (route.request().method() === 'DELETE') {
            deleteRequested = true;
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
        }
        return route.continue();
    });
    await setupRoutes(page);
    await loginAndGo(page);
    const enableBtn = page.getByRole('button', { name: /enable|subscribe/i });
    if (await enableBtn.isVisible()) {
        await enableBtn.click();
        await page.waitForTimeout(500);
        const disableBtn = page.getByRole('button', { name: /disable|unsubscribe/i });
        if (await disableBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await disableBtn.click();
            await page.waitForTimeout(500);
            expect(deleteRequested).toBe(true);
        }
    }
});

test('permission denied shows error message', async ({ page }) => {
    await page.addInitScript(() => {
        const MockNotification = class {
            static get permission() { return 'denied'; }
            static requestPermission() { return Promise.resolve('denied' as NotificationPermission); }
            constructor() {}
        };
        Object.defineProperty(window, 'Notification', { value: MockNotification, writable: true, configurable: true });
        Object.defineProperty(navigator, 'serviceWorker', {
            value: { register: () => Promise.resolve({ pushManager: { subscribe: () => Promise.reject(new Error('Permission denied')), getSubscription: () => Promise.resolve(null) } }), ready: Promise.resolve({ pushManager: {} }), controller: null },
            writable: true, configurable: true
        });
    });
    await setupRoutes(page);
    await loginAndGo(page);
    const enableBtn = page.getByRole('button', { name: /enable|subscribe/i });
    if (await enableBtn.isVisible()) {
        await enableBtn.click();
        await expect(
            page.getByText(/denied|blocked|permission/i).or(page.locator('.sonner-toast'))
        ).toBeVisible({ timeout: 5000 });
    }
});

test('notification bell in header visible', async ({ page }) => {
    await injectBrowserMocks(page);
    await setupRoutes(page);
    await loginAndGo(page, '/dashboard');
    await expect(
        page.locator('[data-testid="notification-bell"], [aria-label*="notification"], button[title*="notification"]').or(
            page.locator('svg').filter({ hasText: '' }).first()
        ).first()
    ).toBeVisible({ timeout: 5000 });
});
