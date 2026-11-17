/**
 * Notification-channel guardrails proof (mock-only, CI subset). Settings /
 * execution page (§29): title + signal + pills header, per-panel primaries,
 * connect-command flow, switch preferences, destructive disconnect confirm.
 * Allowlist+abort discipline: invented backend calls fail here.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const baseStatus = {
    configured: true,
    botUsername: 'EasyModBot',
    suggestedGroupName: 'My BD Shop Alerts',
    status: 'disconnected',
    enabled: false,
    connected: false,
    chatTitle: null,
    chatType: null,
    lastError: null,
    lastTestedAt: null,
    lastSentAt: null,
    connectedAt: null,
    disconnectedAt: null,
    connectionExpiresAt: null,
    preferences: { new_order: true },
    events: [{ eventType: 'new_order', label: 'New order', labelBn: 'নতুন অর্ডার', enabled: true }],
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/notifications/telegram', '/api/commercial/claims',
    '/api/public/commercial-contract', '/api/notifications/subscriptions',
]);
const KNOWN_PATTERNS = [
    /^\/api\/notifications\/telegram\/(connect-intent|test|preferences)$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
    /^\/api\/notifications\/subscriptions\/[\w-]+$/,
];

async function setupRoutes(page: Page, options: { connected?: boolean } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        intents: 0,
        tests: 0,
        preferencePatches: 0,
        disconnects: 0,
        subscriptionPosts: 0,
        connected: options.connected === true,
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
        if (path === '/api/notifications/subscriptions' && method === 'POST') {
            state.subscriptionPosts += 1;
            return route.fulfill({ status: 201, json: { success: true, id: 'sub-1' } });
        }
        if (path === '/api/notifications/telegram' && method === 'GET') {
            return route.fulfill({ json: json(state.connected
                ? { ...baseStatus, connected: true, status: 'connected', chatTitle: 'My BD Shop Alerts' }
                : baseStatus) });
        }
        if (path === '/api/notifications/telegram' && method === 'DELETE') {
            state.disconnects += 1;
            state.connected = false;
            return route.fulfill({ json: json({ status: { ...baseStatus } }) });
        }
        if (path === '/api/notifications/telegram/connect-intent' && method === 'POST') {
            state.intents += 1;
            return route.fulfill({ json: json({ ...baseStatus, status: 'pending', pendingCommand: '/easymod_connect token', instructions: ['Create group', 'Add bot', 'Send command'] }) });
        }
        if (path === '/api/notifications/telegram/test' && method === 'POST') {
            state.tests += 1;
            return route.fulfill({ json: json({ sent: true }) });
        }
        if (path === '/api/notifications/telegram/preferences' && method === 'PATCH') {
            state.preferencePatches += 1;
            return route.fulfill({ json: json(state.connected
                ? { ...baseStatus, connected: true, status: 'connected', chatTitle: 'My BD Shop Alerts' }
                : baseStatus) });
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
    await page.goto('/manage-shop/notifications');
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + signal + channel pills, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
    await expect(page.getByTestId('notification-signal')).toContainText('Alerts need setup');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enable browser notifications' })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('connect intent shows the command and copy action', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByRole('button', { name: 'Connect Telegram group' }).click();
    await expect(page.getByText('/easymod_connect token')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    expect(state.intents).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('connected channel: switch preference PATCH, test alert, confirmed disconnect', async ({ page }) => {
    const state = await setupRoutes(page, { connected: true });
    await loginAndGo(page);
    await expect(page.getByTestId('notification-signal')).toContainText('Alerts connected');
    const toggle = page.getByRole('switch', { name: /New order/ });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect.poll(() => state.preferencePatches).toBe(1);
    await page.getByRole('button', { name: 'Send test alert' }).click();
    await expect.poll(() => state.tests).toBe(1);
    await page.getByTestId('telegram-disconnect').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Disconnect Telegram alerts?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(state.disconnects).toBe(0);
    await page.getByTestId('telegram-disconnect').click();
    await page.getByTestId('telegram-disconnect-confirm').click();
    await expect.poll(() => state.disconnects).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('browser enable requests permission and posts the subscription', async ({ page }) => {
    const state = await setupRoutes(page);
    await page.addInitScript(() => {
        Object.defineProperty(Notification, 'requestPermission', {
            value: async () => 'granted',
            configurable: true,
        });
        const mockPushManager = {
            subscribe: () => Promise.resolve({
                endpoint: 'https://fcm.googleapis.com/fcm/send/sub-guardrails',
                toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/sub-guardrails', keys: { p256dh: 'k', auth: 'a' } }),
            }),
            getSubscription: () => Promise.resolve(null),
        };
        const mockRegistration = { pushManager: mockPushManager, update: () => Promise.resolve() };
        Object.defineProperty(navigator, 'serviceWorker', {
            value: {
                register: () => Promise.resolve(mockRegistration),
                ready: Promise.resolve(mockRegistration),
                controller: null,
            },
            writable: true, configurable: true,
        });
    });
    await loginAndGo(page);
    await page.getByRole('button', { name: 'Enable browser notifications' }).click();
    await expect.poll(() => state.subscriptionPosts).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow and five mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('notification-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the notification surface', async ({ page }) => {
    await setupRoutes(page, { connected: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('notification-signal')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-notifications').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
