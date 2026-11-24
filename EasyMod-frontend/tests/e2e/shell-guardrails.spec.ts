/**
 * Shell chrome proof (mock-only, CI subset): sidebar/topbar/mobile bar on the
 * guardrails token system. The merchant IA is five destinations — Add-ons is
 * hidden (founder decision 2026-11-17) and its paths redirect to the dashboard.
 * Same allowlist+abort
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
    // Phase 1 shell read-sources (D1 badges, D6 chip, D7 readiness): a chrome
    // change that invents MORE calls still aborts here, but these honest paths
    // are part of the contract now and must be mocked deterministically.
    '/api/order/counts', '/api/conversation/needs-reply-count',
    '/api/product/stock-exceptions', '/api/shop/delivery/readiness',
]);
const KNOWN_PATTERNS = [
    /^\/api\/conversation\/[\w-]+$/,
    /^\/api\/conversation\/[\w-]+\/messages$/,
    /^\/api\/conversation\/[\w-]+\/read$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
    /^\/api\/channels\/meta\/[\w-]+\/settings$/,
];

/**
 * Phase 1 default fixture bundle: zero badge sources → NO badge pills (a
 * missing/zero source never renders "0" and never pollutes nav accessible
 * names), empty Meta channel list → honest "not connected" AI chip.
 */
const zeroNavBadgeSources: Array<[string, unknown]> = [
    [
        '/api/order/counts',
        json({ to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 }),
    ],
    [
        '/api/conversation/needs-reply-count',
        json({ count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: iso(0) }),
    ],
    [
        '/api/product/stock-exceptions',
        json({ outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: iso(0) }),
    ],
    [
        '/api/shop/delivery/readiness',
        json({
            provider: null, ready: false, connected: false, active: false,
            credentials_configured: false, provider_store_id: null, provider_store_count: 0,
            pickup_location_configured: false, pickup_enabled: false, pickup_summary: null,
            provider_pickup_meta: {}, pickup_locations_count: 0,
            missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'],
            status: 'SETUP_INCOMPLETE', providers: [],
        }),
    ],
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
        // Exact-match badge/readiness sources FIRST (needs-reply-count is
        // lexically a conversation detail path — claim it before the pattern).
        for (const [mockPath, body] of zeroNavBadgeSources) {
            if (path === mockPath) return route.fulfill({ json: body });
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
    await expect(active).toHaveClass(/bg-em-violet-700/);
    await expect(page.locator('aside')).toHaveClass(/em-dark-nav/);
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

test('390px: five mobile destinations, no horizontal overflow, sidebar hidden', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    await expect(page.locator('aside')).toBeHidden();
    await expect(page.locator('header .mw-language-toggle')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(mobile.getByRole('link')).toHaveCount(5);
    await expect(page.locator('header .mw-language-toggle')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('Add-ons, Reports and Team users are hidden: no nav entry, and retired paths redirect to the dashboard', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const navs = page.locator('nav[aria-label="Workspace navigation"]');
    await expect(navs).toHaveCount(2);
    // Neither the desktop rail nor the mobile bar may offer retired destinations.
    await expect(navs.nth(0).getByRole('link', { name: 'Add-ons' })).toHaveCount(0);
    await expect(navs.nth(1).getByRole('link', { name: 'Add-ons' })).toHaveCount(0);
    await expect(navs.nth(0).getByRole('link', { name: 'Reports' })).toHaveCount(0);
    await expect(navs.nth(1).getByRole('link', { name: 'Reports' })).toHaveCount(0);
    // /team/users was only ever offered from the account popup; the entry is
    // gone there (unit contract: TeamUsersRetirement.test) and the path
    // redirects like every retired merchant destination (D-A3-7).
    for (const path of ['/reports', '/reports/summary', '/addons', '/addons/ads-studio', '/addons/storefront', '/addons/other', '/team/users']) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/dashboard$/);
    }
    expect(state.unexpected).toEqual([]);
});

// ── Phase 1 W2/W3 (mission D1/D6/D9) ──────────────────────────────────────────
test('W2 rail IA: three labelled groups, geometry 14.75rem/4rem, promoted Audit logs', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const rail = page.locator('aside nav[aria-label="Workspace navigation"]');
    // Group headers (D9) — Workspace / Business settings / Account & ops.
    await expect(rail.getByText('Workspace', { exact: true })).toBeVisible();
    await expect(rail.getByText('Business settings', { exact: true })).toBeVisible();
    await expect(rail.getByText('Account & ops', { exact: true })).toBeVisible();
    // Audit logs is a visible rail entry now (D9 promotion), not just a menu row.
    const audit = rail.getByRole('link', { name: 'Audit Logs' });
    await expect(audit).toHaveAttribute('href', '/audit-logs');
    await expect(audit).toBeVisible();
    // Billing still lives in the same Account & ops group.
    await expect(rail.getByRole('link', { name: 'Billing' })).toHaveAttribute('href', '/subscription');
    // Geometry contract: expanded 236px == 14.75rem; the shell var feeds AddProduct.
    const aside = page.locator('aside');
    const expandedWidth = (await aside.boundingBox())!.width;
    expect(expandedWidth).toBe(236);
    await expect(aside).toHaveCSS('width', '236px');
    const shellVar = await page.locator('.em-shell').first().evaluate((el) => getComputedStyle(el).getPropertyValue('--shell-sidebar-w').trim());
    expect(shellVar).toBe('14.75rem');
    await page.getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(aside).toHaveCSS('width', '64px');
    const collapsedVar = await page.locator('.em-shell').first().evaluate((el) => getComputedStyle(el).getPropertyValue('--shell-sidebar-w').trim());
    expect(collapsedVar).toBe('4rem');
    // Collapsed rail hides the group headers but keeps icon links + tooltips.
    await expect(rail.getByText('Workspace', { exact: true })).toBeHidden();
    await expect(rail.getByRole('link', { name: 'Inbox' })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('W2 honest chrome: zero badge sources keep plain nav names; AI chip is desktop-only, link-only', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const rail = page.locator('aside nav[aria-label="Workspace navigation"]');
    // Badge sources are all zero/covered in this fixture → NO pills and NO
    // count fragments in the accessible names (D1: zero/absence never claims).
    await expect(rail.getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Products', exact: true })).toBeVisible();
    await expect(rail.locator('span.sr-only')).toHaveCount(0);
    // D6 chip: present at desktop width, resolved from the channel list only.
    const chip = page.getByTestId('ai-status-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-state', 'notConnected');
    await expect(chip).toHaveAttribute('href', '/manage-shop/channels');
    // Read-only forever: the chip is a link, never a button/toggle (D6).
    await expect(chip.evaluate((el) => el.tagName)).resolves.toBe('A');
    // No toggle control in the app bar at all (mission §10 forbids it).
    await expect(page.locator('header').getByRole('button', { name: /AI|auto|reply/i })).toHaveCount(0);
    // Below md the chip must not render (mobile sees the dashboard module).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(chip).toBeHidden();
    expect(state.unexpected).toEqual([]);
});

test('W2 viewport matrix: no horizontal overflow 360→1920 (shell chrome on /inbox)', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]] as const) {
        await page.setViewportSize({ width, height });
        await page.goto('/inbox');
        await expect(page.getByTestId('inbox-signal')).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `overflow at ${width}x${height}`).toBeLessThanOrEqual(0);
        if (width >= 768) {
            await expect(page.locator('aside')).toBeVisible();
            await expect(page.getByTestId('ai-status-chip')).toBeVisible();
        } else {
            await expect(page.locator('aside')).toBeHidden();
            await expect(page.getByTestId('ai-status-chip')).toBeHidden();
            await expect(page.locator('nav[aria-label="Workspace navigation"]').nth(1).getByRole('link')).toHaveCount(5);
        }
    }
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
