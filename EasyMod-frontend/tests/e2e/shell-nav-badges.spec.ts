/**
 * Phase 1 W3 (A6) — nav badge honesty + destination parity (mission D1/D10,
 * docs 04/05). Mock-only, allowlist+abort discipline: the shell may call the
 * five Phase-1 read sources and nothing invented.
 *
 * Proves:
 *  - badge render when the source is positive; NO badge on null (failure/403)
 *    and NO badge on zero — absence is never a "0" claim (never render 0);
 *  - "99+" display cap and the N+ lower-bound form when coverageComplete is
 *    false (capped honesty — a truncated scan is never exhaustive);
 *  - a truncated-scan count of 0 makes no positive claim → no badge;
 *  - single-anchor parity: WHEN a badge is present the nav link itself carries
 *    the filtered destination (badgeHref) and clicking lands there; there is
 *    never a nested interactive element;
 *  - Bangla numerals come from Intl at render time (bn locale), never literal
 *    digits in copy;
 *  - focus ring on the dark rail is the sunlight focus color, one tab stop per
 *    item.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Badge Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const isoNow = new Date('2026-11-24T10:00:00.000Z').toISOString();

const json = (data: unknown) => ({ success: true, data });

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status',
    '/api/dashboard/metrics', '/api/dashboard/queue', '/api/order', '/api/subscription',
    '/api/notifications/in-app', '/api/notifications/telegram', '/api/shop/business-info',
    '/api/shop/ai-settings', '/api/conversation', '/api/conversation/events', '/api/templates',
    '/api/inbox/actions', '/api/channels/meta', '/api/audit', '/api/commercial/claims',
    '/api/public/commercial-contract',
    // Phase 1 shell read-sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count',
    '/api/product/stock-exceptions', '/api/shop/delivery/readiness',
]);
const KNOWN_PATTERNS = [
    /^\/api\/conversation\/[\w-]+$/,
    /^\/api\/conversation\/[\w-]+\/messages$/,
    /^\/api\/conversation\/[\w-]+\/read$/,
    /^\/api\/payment\/config$/,
    /^\/api\/category\/?$/,
    /^\/api\/channels\/meta\/[\w-]+\/settings$/,
];

const ZERO_COUNTS = { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 };
const ZERO_REPLY = { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: isoNow };
const ZERO_STOCK = { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: isoNow };
const READINESS_NONE = {
    provider: null, ready: false, connected: false, active: false,
    credentials_configured: false, provider_store_id: null, provider_store_count: 0,
    pickup_location_configured: false, pickup_enabled: false, pickup_summary: null,
    provider_pickup_meta: {}, pickup_locations_count: 0,
    missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'],
    status: 'SETUP_INCOMPLETE', providers: [],
};

interface BadgeFixture {
    /** 'ok' normal payload; 'fail' 5xx abort; '403' forbidden; 'zero' no badge. */
    orders?: 'ok' | 'fail' | '403' | 'zero' | number;
    inbox?: 'ok' | 'fail' | '403' | 'zero' | 'capped' | 'partial' | 'partialZero';
    products?: 'ok' | 'fail' | '403' | 'zero' | number;
}

/**
 * ONE route handler per test whose payloads come from a mutable cfg object —
 * a test can change fixture values and reload without re-registering routes
 * (a second registration would reset the signed-in state).
 */
async function setupRoutes(page: Page, initial: BadgeFixture = {}) {
    const cfg: BadgeFixture = { ...initial };
    const state = { signedIn: false, unexpected: [] as string[] };
    await page.addInitScript(() => {
        // easymod_lang intentionally NOT pinned here — playwright.config.ts
        // storageState seeds 'en'; the bn test toggles + reloads through the
        // real LanguageToggle and must not be reverted by an init script.
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });

    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const fixture = cfg;
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
        }
        if (path === '/api/order/counts' && method === 'GET') {
            if (fixture.orders === 'fail' || fixture.orders === '403') {
                return route.fulfill({ status: fixture.orders === '403' ? 403 : 503, json: { success: false } });
            }
            if (fixture.orders === 'zero' || fixture.orders === undefined) return route.fulfill({ json: json(ZERO_COUNTS) });
            return route.fulfill({ json: json({ ...ZERO_COUNTS, needs_action: fixture.orders, total: fixture.orders }) });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            if (fixture.inbox === 'fail' || fixture.inbox === '403') {
                return route.fulfill({ status: fixture.inbox === '403' ? 403 : 503, json: { success: false } });
            }
            if (fixture.inbox === 'capped') {
                return route.fulfill({ json: json({ count: 150, scanned: 200, cap: 200, coverageComplete: false, generated_at: isoNow }) });
            }
            if (fixture.inbox === 'partial') {
                return route.fulfill({ json: json({ count: 8, scanned: 200, cap: 200, coverageComplete: false, generated_at: isoNow }) });
            }
            if (fixture.inbox === 'partialZero') {
                return route.fulfill({ json: json({ count: 0, scanned: 200, cap: 200, coverageComplete: false, generated_at: isoNow }) });
            }
            if (fixture.inbox === undefined) return route.fulfill({ json: json({ ...ZERO_REPLY, count: 3, scanned: 3 }) });
            return route.fulfill({ json: json(ZERO_REPLY) });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            if (fixture.products === 'fail' || fixture.products === '403') {
                return route.fulfill({ status: fixture.products === '403' ? 403 : 503, json: { success: false } });
            }
            if (fixture.products === 'zero' || fixture.products === undefined) return route.fulfill({ json: json(ZERO_STOCK) });
            return route.fulfill({ json: json({ ...ZERO_STOCK, lowStock: fixture.products, exceptions: fixture.products, scanned: fixture.products }) });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') return route.fulfill({ json: json(READINESS_NONE) });
        if (path === '/api/channels/meta' && method === 'GET') return route.fulfill({ json: json([]) });
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
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/conversation' && method === 'GET') {
            return route.fulfill({ json: json({ conversations: [], ai_reply_mode: 'MANUAL', pagination: { total: 0, page: 1, pageSize: 50, totalPages: 1 } }) });
        }
        if (path === '/api/conversation/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 10000\n\n' });
        if (path === '/api/templates') return route.fulfill({ json: json([]) });
        if (path === '/api/inbox/actions') return route.fulfill({ json: json({ items: [], generated_at: isoNow, partial: false, counts: { total: 0, views: { attention: 0 } } }) });
        if (path === '/api/order' && method === 'GET') return route.fulfill({ json: json([]) });
        if (path === '/api/product' && method === 'GET') return route.fulfill({ json: json([]) });
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: 'sha256:' + 'a'.repeat(64), decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: 'sha256:' + 'b'.repeat(64) }) });
        return route.fulfill({ json: json([]) });
    });
    return { state, cfg };
}

async function loginAndGo(page: Page, path = '/dashboard') {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    if (path !== undefined) await page.goto(path);
}

// Locale-agnostic rail locator (the nav aria-label itself is localized).
const rail = (page: Page) => page.locator('aside nav').first();

test('positive badge sources render pills and the accessible name carries the honest sentence', async ({ page }) => {
    const { state } = await setupRoutes(page, { orders: 5, products: 2 });
    // inbox default in this fixture: count 3, complete coverage.
    await loginAndGo(page);
    await expect(rail(page).getByRole('link', { name: 'Orders 5 orders need action' })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Inbox 3 messages need a reply' })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Products 2 products have stock exceptions' })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('single-anchor parity: badge present → the link itself carries the filtered destination, click lands there', async ({ page }) => {
    const { state } = await setupRoutes(page, { orders: 5, products: 2 });
    await loginAndGo(page);
    const inboxLink = rail(page).getByRole('link', { name: 'Inbox 3 messages need a reply' });
    await expect(inboxLink).toHaveAttribute('href', '/inbox?tab=needs_review');
    await expect(rail(page).getByRole('link', { name: 'Orders 5 orders need action' })).toHaveAttribute('href', '/orders?bucket=needs_action');
    await expect(rail(page).getByRole('link', { name: 'Products 2 products have stock exceptions' })).toHaveAttribute('href', '/products?stock=exceptions');
    // One anchor per item — never a nested interactive element (keyboard parity).
    await expect(rail(page).locator('a a')).toHaveCount(0);
    await inboxLink.click();
    await expect(page).toHaveURL(/\/inbox\?tab=needs_review$/);
    await expect(page.getByRole('button', { name: /Needs your reply/ })).toHaveAttribute('aria-pressed', 'true');
    expect(state.unexpected).toEqual([]);
});

test('no badge on zero and no badge on failure/403 — absence never claims "0" (D1/D10)', async ({ page }) => {
    const { state } = await setupRoutes(page, { orders: 'zero', inbox: 'zero', products: 'zero' });
    await loginAndGo(page);
    await expect(rail(page).getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Products', exact: true })).toBeVisible();
    await expect(rail(page).locator('span.sr-only')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('5xx badge sources degrade to no badge, no crash — per source', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const { state } = await setupRoutes(page, { orders: 'fail', inbox: 'fail', products: 'fail' });
    await loginAndGo(page);
    // Per-source expectation (A9): each failed source hides its OWN badge.
    await expect(rail(page).getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Products', exact: true })).toBeVisible();
    await expect(rail(page).locator('span.sr-only')).toHaveCount(0);
    expect(errors).toEqual([]);
    // No source path is aborted here — the three fixtures FULFILL 5xx
    // responses; the abort path belongs only to unknown (invented) routes.
    // state.unexpected must stay empty: the shell invented nothing.
    expect(state.unexpected).toEqual([]);
});

// A9 partial failure: honesty is per source. The failing inbox hides its own
// badge; the healthy Orders/Products badges keep rendering (no cascade).
test('partial failure is per-source: inbox 5xx never blanks healthy Orders/Products badges', async ({ page }) => {
    const { state } = await setupRoutes(page, { orders: 5, products: 2, inbox: 'fail' });
    await loginAndGo(page);
    await expect(rail(page).getByRole('link', { name: 'Orders 5 orders need action' })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Products 2 products have stock exceptions' })).toBeVisible();
    // The failed source alone: bare link, no badge, no aria claim.
    await expect(rail(page).getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('403 restricted badge sources → no badge, app keeps working (D10 restricted state)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const { state } = await setupRoutes(page, { orders: '403', inbox: '403', products: '403' });
    await loginAndGo(page);
    // Per-source: each restricted source hides only its own badge.
    await expect(rail(page).getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: 'Products', exact: true })).toBeVisible();
    await expect(rail(page).locator('span.sr-only')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(state.unexpected).toEqual([]);
});

test('cap and lower-bound honesty: 150 renders 99+; incomplete coverage renders N+; incomplete zero renders nothing', async ({ page }) => {
    const { cfg } = await setupRoutes(page, { orders: 150, inbox: 'partial' });
    await loginAndGo(page);
    // Orders bucket counts are exact → capped at 99+ purely by display cap.
    await expect(rail(page).getByRole('link', { name: 'Orders 99+ orders need action' })).toBeVisible();
    // Inbox scan saw only the cap → the number is a lower bound, never exhaustive.
    await expect(rail(page).getByRole('link', { name: 'Inbox 8+ messages need a reply' })).toBeVisible();
    // aria sentence inherits the lower-bound form.
    await expect(rail(page).getByRole('link', { name: 'Inbox 8+ messages need a reply' })).toHaveAttribute('href', '/inbox?tab=needs_review');

    cfg.inbox = 'capped';
    await page.reload();
    await expect(rail(page).getByRole('link', { name: 'Inbox 99+ messages need a reply' })).toBeVisible();
});

test('incomplete coverage with count 0 makes no positive claim → no badge', async ({ page }) => {
    const { state } = await setupRoutes(page, { inbox: 'partialZero' });
    await loginAndGo(page);
    await expect(rail(page).getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('bn locale: badge numbers are Intl-rendered Bangla numerals (never literal digits)', async ({ page }) => {
    const { state } = await setupRoutes(page, { orders: 8 });
    await loginAndGo(page);
    // Switch via the shell toggle (same path a merchant uses), then reload so
    // the shell mounts with bn resolved. DE-2 correction: badge display/aria
    // strings are DERIVED at RENDER time from raw readings, so a mid-session
    // switch already re-renders in the new locale (unit-pinned in
    // useNavBadges.test.ts); the reload below keeps the E2E rail text
    // deterministic from mount — it is no longer a workaround for a
    // fetch-time staleness gap.
    await page.locator('header .mw-language-toggle').click();
    await page.reload();
    const ordersLink = rail(page).getByRole('link', { name: /অর্ডারে ব্যবস্থা দরকার/ });
    await expect(ordersLink).toBeVisible();
    // ৮ = Bangla eight (Intl bn-BD at render time — no hand-written digits).
    const text = await ordersLink.textContent();
    expect(text).toContain('৮');
    expect(text).not.toMatch(/\b8\b/);
    // The sr-only sentence is localized too.
    expect(text).toContain('৮টি অর্ডারে ব্যবস্থা দরকার');
    expect(state.unexpected).toEqual([]);
});

test('keyboard: one tab stop per badge-carrying rail item and the sunlight focus ring on the dark rail', async ({ page }) => {
    await setupRoutes(page, { orders: 5, inbox: 'partial' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    const workspaceLinks = rail(page).locator('div.space-y-0\\.5').first().locator('a');
    await expect(workspaceLinks).toHaveCount(5);
    // Tab from the logo: focus must reach the rail links one by one (a badge
    // never adds a second stop because it is not a nested control).
    await page.locator('aside img').first().click();
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            const link = el?.closest?.('aside a');
            return link ? { name: link.getAttribute('aria-label') ?? link.textContent ?? '', color: getComputedStyle(link).outlineColor } : null;
        });
        if (!info) continue;
        if (!seen.includes(info.name)) seen.push(info.name);
        if (seen.length >= 2) break;
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const outlineColor = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineColor);
    // --em-focus-dark == --em-sunlight-500 == #F4C35E (contrast-pinned in themeTokens.test).
    expect(outlineColor).toBe('rgb(244, 195, 94)');
});
