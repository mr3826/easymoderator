/**
 * Shell chrome proof (mock-only, CI subset): sidebar/topbar/mobile bar on the
 * guardrails token system with the IA unchanged. Same allowlist+abort
 * discipline as inbox-guardrails — a chrome change that invents backend calls
 * fails here. Covers active state, collapse persistence, skip link, keyboard
 * focus, popup semantics, 390px mobile bar and chrome-scoped axe.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

const conversations = [
    {
        id: 'conv-1', customer_id: 'cust-1', customer: { id: 'cust-1', name: 'Alice' },
        channel: 'messenger', status: 'active', title: 'Alice', lastMessage: 'What is the price?',
        unreadCount: 0, created_at: iso(3_600_000), updated_at: iso(600_000),
    },
];
const messages = [
    {
        id: 'msg-c1', conversation_id: 'conv-1', sender: 'customer', content: 'What is the price?',
        message_type: 'text', created_at: iso(600_000), updated_at: iso(600_000), is_transcript_message: true,
    },
];
const json = (data: unknown) => ({ success: true, data });

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status',
    '/api/dashboard/metrics', '/api/dashboard/queue', '/api/order', '/api/subscription',
    '/api/notifications/in-app', '/api/notifications/telegram', '/api/shop/business-info',
    '/api/shop/ai-settings', '/api/conversation', '/api/conversation/events', '/api/templates',
    '/api/inbox/actions', '/api/channels/meta', '/api/audit', '/api/commercial/claims',
    '/api/public/commercial-contract',
]);
const KNOWN_PATTERNS = [
    /^\/api\/conversation\/[\w-]+$/,
    /^\/api\/conversation\/[\w-]+\/messages$/,
    /^\/api\/conversation\/[\w-]+\/read$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
    /^\/api\/channels\/meta\/[\w-]+\/settings$/,
];

async function setupRoutes(page: Page) {
    const state = { signedIn: false, unexpected: [] as string[] };
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
            const decisions = surface === 'subscription'
                ? [{
                    claimId: 'ai.draft_reply', available: true, render: 'claim', textKey: 'claims.ai.draft_reply.en',
                    locale: 'en', surface, scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
                    interpolation: {}, mode: 'enforce',
                    predicate: { code_present: true, merchant_enabled: true, production_verified: true, deprecated: false, internal_only: false, scope_match: true },
                    wouldBlock: false, contractVersion: '1.0.0', registryHash,
                }]
                : [];
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash, decisions }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/conversation' && method === 'GET') {
            return route.fulfill({ json: json({ conversations, ai_reply_mode: 'MANUAL', pagination: { total: 1, page: 1, pageSize: 50, totalPages: 1 } }) });
        }
        if (/^\/api\/conversation\/[\w-]+\/messages$/.test(path)) {
            return route.fulfill({ json: json({ messages, suggestions: [], pagination: { page: 1, totalPages: 1 } }) });
        }
        if (/^\/api\/conversation\/[\w-]+\/read$/.test(path)) {
            return route.fulfill({ json: json({ ...conversations[0], unreadCount: 0 }) });
        }
        if (path === '/api/conversation/events') {
            return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 10000\n\n' });
        }
        if (path === '/api/templates') return route.fulfill({ json: json([]) });
        if (path === '/api/inbox/actions') {
            return route.fulfill({ json: json({ items: [], generated_at: iso(0), partial: false, counts: { total: 0, views: { attention: 0 } } }) });
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
    await page.goto('/inbox');
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('chrome uses em tokens, keeps h-14 topbar and marks the active rail item', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const rail = page.locator('aside nav[aria-label="Workspace navigation"]');
    const active = rail.getByRole('link', { name: 'Inbox' });
    await expect(active).toHaveAttribute('aria-current', 'page');
    await expect(active).toHaveClass(/bg-em-violet-50/);
    // Shell app bar is the first header; redesigned pages render their own.
    const header = await page.locator('header').first().boundingBox();
    expect(header!.height).toBe(56);
    await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main-content');
    expect(state.unexpected).toEqual([]);
});

test('collapse persists across reload and names the toggle both ways', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    await page.getByRole('button', { name: 'Collapse', exact: true }).click();
    const rail = page.locator('aside nav[aria-label="Workspace navigation"]');
    await expect(rail.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await page.reload();
    await page.waitForURL(/\/inbox/);
    await expect(page.getByRole('button', { name: 'Expand', exact: true })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collapse', exact: true })).toBeVisible();
});

test('skip link is the first tab stop and focuses main', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('inbox-signal')).toBeVisible();
    // The inbox scrolls its transcript into view on load, which moves Chromium's
    // sequential-focus starting point to the thread end. Anchor at the sidebar
    // logo (non-focusable, no navigation) and Shift+Tab backwards: the previous
    // stop must be the skip link, proving it precedes all chrome navigation.
    await page.locator('aside img').first().click();
    await page.keyboard.press('Shift+Tab');
    const first = await page.evaluate(() => document.activeElement?.textContent);
    expect(first).toBe('Skip to content');
    await page.keyboard.press('Enter');
    const focusedId = await page.evaluate(() => document.activeElement?.id);
    expect(focusedId).toBe('main-content');
});

test('keyboard: visible focus ring on a sidebar link', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('inbox-signal')).toBeVisible();
    let focused = false;
    for (let i = 0; i < 25; i += 1) {
        await page.keyboard.press('Tab');
        focused = await page.evaluate(() => {
            const el = document.activeElement;
            return el?.tagName === 'A' && Boolean(el.closest('aside'));
        });
        if (focused) break;
    }
    expect(focused).toBe(true);
    await page.waitForTimeout(300);
    const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(outline.style).not.toBe('none');
    expect(parseFloat(outline.width)).toBeGreaterThan(0);
});

test('account popup is a dialog; Escape closes and returns focus', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    const trigger = page.getByRole('button', { name: /Account menu/ });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Account menu' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const focusedName = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    expect(focusedName).toContain('Account menu');
});

test('notification bell opens a dialog and Escape closes it', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    const bell = page.getByTestId('notification-bell');
    await bell.click();
    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
});

test('390px: six mobile destinations, no horizontal overflow, sidebar hidden', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(6);
    await expect(page.locator('aside')).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the chrome', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.locator('aside nav[aria-label="Workspace navigation"]').getByRole('link', { name: 'Inbox' })).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page })
        .include('aside')
        .include('header')
        .include('nav[aria-label="Workspace navigation"]')
        .analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
