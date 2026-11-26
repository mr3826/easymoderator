/**
 * Phase 1 W3 (A6) — dashboard commerce signals, honesty states and the read-only
 * AI/connection surfaces (mission D4/D5/D6/D7/D10, docs 04/05).
 *
 * Proves:
 *  - the four queue signal cards incl. the D5 recorded-charges copy (en + bn,
 *    Intl numerals, UTC-day note, tooltip, /subscription destination);
 *  - capped honesty everywhere the server says "truncated scan": 8+ / 99+,
 *    never a bare exhaustive-looking number; needs_reply null renders
 *    "Unavailable", never 0;
 *  - recentActivity: stored actor or "System" (no AI/Provider inference),
 *    ORDER rows deep-link to /orders?orderId=, other rows unlinked, capped to
 *    six, PII-free (no customer phone/name fields exist in the projection);
 *  - AiStatusChip: the full 8-state matrix from the channels payload only,
 *    including billing fail-closed (all-AUTO + billing_ai_active false → mixed)
 *    and fetch-failure → unavailable; always a link, never a control;
 *  - ConnectionHealth: meta-row worst-state aggregate, real reconnect POST
 *    (server-issued redirect; failure → honest status, never auto-ping),
 *    courier ACTIVE → ready / READY → connected·inactive (distinct server
 *    states — A8) / SETUP_INCOMPLETE+missingCount / notSetUp / unavailable,
 *    and the independent retry control for degraded reads.
 *
 * Mock-only; allowlist+abort discipline identical to shell-guardrails.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Signal Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const isoNow = '2026-11-24T10:00:00.000Z';

const json = (data: unknown) => ({ success: true, data });

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status',
    '/api/dashboard/metrics', '/api/dashboard/queue', '/api/order', '/api/subscription',
    '/api/notifications/in-app', '/api/shop/business-info', '/api/shop/ai-settings',
    '/api/conversation', '/api/inbox/actions', '/api/channels/meta',
    '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/order/counts', '/api/conversation/needs-reply-count',
    '/api/product/stock-exceptions', '/api/shop/delivery/readiness',
]);
const KNOWN_PATTERNS = [
    /^\/api\/conversation\/[\w-]+$/,
    /^\/api\/conversation\/[\w-]+\/messages$/,
    /^\/api\/channels\/meta\/[\w-]+\/reconnect$/,
];

type ChannelsMode =
    | 'fail' | 'none' | 'emergency' | 'reconnect'
    | 'auto' | 'autoBillingOff' | 'draft' | 'manual' | 'mixed'
    | 'verified' | 'unverified';

interface Fixture {
    channels: ChannelsMode;
    /** ACTIVE | READY (configured-not-active) | setup | none | fail. */
    readiness: 'active' | 'ready' | 'setup' | 'none' | 'fail';
    needsReply: 'complete' | 'partial' | 'capped' | 'null';
    /** queue.commerce_signals delivery: normal | null | emptyActivity | singleOrder */
    signals: 'normal' | 'nullSignals' | 'emptyActivity' | 'singleOrder';
    replyCardCount?: number;
    /** GET /api/order/counts needs_action (the Orders badge AND hero authority). */
    needsActionCount?: number;
    /** Queue at_risk sample row count (10 = the server's sample cap). */
    exceptionSampleRows?: number;
}

const channelPayload = (mode: ChannelsMode): unknown[] | null => {
    const base = {
        shopId: 'shop-1', platform: 'facebook', metaAssetId: 'page-1',
        pictureUrl: null, isHealthy: true, lastError: null, tokenExpiresAt: null,
        tokenLastRefreshedAt: null, webhookSubscribedFields: [], connectedAt: isoNow,
        disconnectedAt: null, createdAt: isoNow, updatedAt: isoNow, purposeLabel: null,
        mode_source: 'business_default',
    };
    switch (mode) {
        case 'fail': return null;
        case 'none': return [];
        case 'emergency':
            return [{ ...base, id: 'ch-1', displayName: 'Emergency Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'AUTO', billing_ai_active: true, emergency_stop: { active: true, at: isoNow } }];
        case 'reconnect':
            return [{ ...base, id: 'ch-1', displayName: 'Expired Page', status: 'TOKEN_EXPIRED', needsReconnect: true, webhookLastVerifiedAt: isoNow, effective_mode: 'MANUAL', billing_ai_active: true }];
        case 'auto':
            return [{ ...base, id: 'ch-1', displayName: 'Shop Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'AUTO', billing_ai_active: true }];
        case 'autoBillingOff':
            return [{ ...base, id: 'ch-1', displayName: 'Billing-Held Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'AUTO', billing_ai_active: false, mode_source: 'fail_closed' }];
        case 'draft':
            return [{ ...base, id: 'ch-1', displayName: 'Shop Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'DRAFT', billing_ai_active: true }];
        case 'manual':
            return [{ ...base, id: 'ch-1', displayName: 'Shop Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'MANUAL', billing_ai_active: true }];
        case 'mixed':
            return [
                { ...base, id: 'ch-1', displayName: 'Auto Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'AUTO', billing_ai_active: true },
                { ...base, id: 'ch-2', displayName: 'Manual Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'MANUAL', billing_ai_active: true },
            ];
        case 'verified':
            return [{ ...base, id: 'ch-1', displayName: 'Verified Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: isoNow, effective_mode: 'DRAFT', billing_ai_active: true }];
        case 'unverified':
            return [{ ...base, id: 'ch-1', displayName: 'Unverified Page', status: 'CONNECTED', needsReconnect: false, webhookLastVerifiedAt: null, effective_mode: 'DRAFT', billing_ai_active: true }];
    }
};

const activityRows = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `act-${i + 1}`,
    action: i === 0 ? 'ORDER_CONFIRMED' : i % 2 ? 'PRODUCT_STOCK_UPDATED' : 'ORDER_CREATED',
    resourceType: i === 0 ? 'order' : i % 2 ? 'product' : 'order',
    occurredAt: `2026-11-24T0${(i % 9)}:15:00.000Z`,
    resource_id: i === 0 ? 'order-deep-1' : null,
    user: i % 3 === 0 ? { id: 'user-1', full_name: 'Signal Owner' } : null,
}));

const exceptionRow = (i: number) => ({
    id: i === 0 ? 'order-deep-1' : `order-cap-${i}`,
    orderNumber: `EM-09${String(i).padStart(2, '0')}`,
    status: 'returned', tracking_id: null, updatedAt: isoNow,
});

const queueFor = (fx: Fixture) => {
    const needs_reply = fx.needsReply === 'null' ? null
        : fx.needsReply === 'partial' ? { count: 8, scanned: 200, cap: 200, coverageComplete: false, generated_at: isoNow }
            : fx.needsReply === 'capped' ? { count: 150, scanned: 200, cap: 200, coverageComplete: false, generated_at: isoNow }
                : { count: fx.replyCardCount ?? 2, scanned: 40, cap: 200, coverageComplete: true, generated_at: isoNow };
    const commerce_signals = fx.signals === 'nullSignals' ? { deliveredCharges: null, recentActivity: null }
        : fx.signals === 'emptyActivity' ? { deliveredCharges: { dayUtc: '2026-11-24', count: 4, amountMinor: 123450 }, recentActivity: [] }
            : fx.signals === 'singleOrder' ? { deliveredCharges: { dayUtc: '2026-11-24', count: 1, amountMinor: 3250 }, recentActivity: activityRows(2) }
                : {
                    deliveredCharges: { dayUtc: '2026-11-24', count: 4, amountMinor: 123450 },
                    // Deep-clone per mount: rows mutate nothing, but keep fixtures honest.
                    recentActivity: activityRows(7),
                };
    // Sample rows: default 1 (the deep-link proof); exceptionSampleRows lets
    // the hero-authority test drive the capped 10-row sample explicitly.
    const at_risk_orders = fx.exceptionSampleRows !== undefined
        ? Array.from({ length: fx.exceptionSampleRows }, (_, i) => exceptionRow(i))
        : [exceptionRow(0)];
    return {
        predicate_version: 'worklist-v1',
        pending_payment_count: 1,
        ready_to_dispatch_count: 3,
        needs_reply,
        at_risk_orders,
        commerce_signals,
    };
};

const readinessPayload = (mode: Fixture['readiness']) => {
    if (mode === 'none') return {
        provider: null, ready: false, connected: false, active: false, credentials_configured: false,
        provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false,
        pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0,
        missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'],
        status: 'SETUP_INCOMPLETE', providers: [],
    };
    // ready: the DISTINCT server verdict — credentials/store configured, the
    // integration NOT active (can never dispatch). Renders "Connected ·
    // inactive", never the healthy "Ready" (A8 MAJOR-3 fix-4).
    if (mode === 'ready') return {
        provider: 'redx', ready: true, connected: true, active: false, credentials_configured: true,
        provider_store_id: 'store-4', provider_store_count: 1, pickup_location_configured: false, pickup_enabled: false,
        pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0,
        missing: [], missing_fields: [], status: 'READY',
        providers: [{ provider: 'redx', ready: true, connected: true, active: false, credentials_configured: true, provider_store_id: 'store-4', provider_store_count: 1, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: [], missing_fields: [], status: 'READY' }],
    };
    if (mode === 'active') return {
        provider: 'pathao', ready: true, connected: true, active: true, credentials_configured: true,
        provider_store_id: 'store-9', provider_store_count: 2, pickup_location_configured: true, pickup_enabled: true,
        pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 1,
        missing: [], missing_fields: [], status: 'ACTIVE',
        providers: [{ provider: 'pathao', ready: true, connected: true, active: true, credentials_configured: true, provider_store_id: 'store-9', provider_store_count: 2, pickup_location_configured: true, pickup_enabled: true, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 1, missing: [], missing_fields: [], status: 'ACTIVE' }],
    };
    // setup: integration with two REAL missing steps + provider_not_active
    // (the excluded entry — the controller's settings-row aggregation rule).
    // connected:false keeps this on the SETUP_INCOMPLETE branch, not the
    // connected-but-inactive branch (also asserted below).
    const missing = ['webhook_secret', 'default_store', 'provider_not_active'];
    return {
        provider: 'redx', ready: false, connected: false, active: false, credentials_configured: true,
        provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false,
        pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0,
        missing, missing_fields: missing, status: 'SETUP_INCOMPLETE',
        providers: [{ provider: 'redx', ready: false, connected: false, active: false, credentials_configured: true, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing, missing_fields: missing, status: 'SETUP_INCOMPLETE' }],
    };
};

async function setupRoutes(page: Page, initial: Partial<Fixture> = {}) {
    const cfg: Fixture = { channels: 'none', readiness: 'none', needsReply: 'complete', signals: 'normal', ...initial };
    const state = { signedIn: false, unexpected: [] as string[], reconnectPosts: 0 };
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });

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
        if (path === '/api/setup/status') return route.fulfill({ json: json({ complete: true, isComplete: true, completedCount: 4, totalCount: 4, progressPercent: 100, tasks: [] }) });
        if (path === '/api/subscription') return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' }) });
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/conversation' && method === 'GET') {
            return route.fulfill({ json: json({ conversations: [], ai_reply_mode: 'MANUAL', pagination: { total: 0, page: 1, pageSize: 100, totalPages: 1 } }) });
        }
        if (path === '/api/inbox/actions') return route.fulfill({ json: json({ items: [], generated_at: isoNow, partial: false, counts: { total: 0, views: { attention: 0 } } }) });
        if (path === '/api/dashboard/metrics') {
            return route.fulfill({ json: json({ metrics: { totalMessages: 12, activeProducts: 8, ordersToday: 3, weeklyChange: 10.5, conversionRate: 5.2 }, channels: { active: 2, total: 3 }, chartData: [], cashPosition: { inTransit: { amount: 12500, count: 7 }, atRisk: { amount: 3400, count: 2, windowDays: 30 } } }) });
        }
        if (path === '/api/dashboard/queue') return route.fulfill({ json: json(queueFor(cfg)) });
        if (path === '/api/order/counts') {
            const needsAction = cfg.needsActionCount ?? 1;
            return route.fulfill({ json: json({ to_confirm: 0, to_pack: 3, booked: 0, in_transit: 0, needs_action: needsAction, returned: 0, delivered: 0, total: 8 + needsAction }) });
        }
        if (path === '/api/conversation/needs-reply-count') return route.fulfill({ json: json(queueFor(cfg).needs_reply ?? { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: isoNow }) });
        if (path === '/api/product/stock-exceptions') return route.fulfill({ json: json({ outOfStock: 1, lowStock: 1, exceptions: 2, scanned: 8, cap: 1000, coverageComplete: true, generated_at: isoNow }) });
        if (path === '/api/order' && method === 'GET') {
            return route.fulfill({ json: json([]) });
        }
        if (path === '/api/channels/meta' && method === 'GET') {
            const payload = channelPayload(cfg.channels);
            if (payload === null) return route.fulfill({ status: 503, json: { success: false } });
            return route.fulfill({ json: json(payload) });
        }
        if (/^\/api\/channels\/meta\/[\w-]+\/reconnect$/.test(path) && method === 'POST') {
            state.reconnectPosts += 1;
            // 200 WITHOUT a redirectUrl = the server could not hand out the OAuth
            // round trip. The component must show its honest failure status and
            // make exactly ONE user-initiated attempt (5xx here would trigger the
            // client's designed transient-retry policy, so a 200 isolates the
            // no-auto-ping claim to exactly one POST).
            return route.fulfill({ json: json({}) });
        }
        if (path === '/api/shop/delivery/readiness') {
            if (cfg.readiness === 'fail') return route.fulfill({ status: 503, json: { success: false } });
            return route.fulfill({ json: json(readinessPayload(cfg.readiness)) });
        }
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', registryHash: 'sha256:' + 'a'.repeat(64), decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: 'sha256:' + 'b'.repeat(64) }) });
        if (/^\/api\/conversation\/[\w-]+$/.test(path)) return route.fulfill({ json: json({ id: 'conv-1', unreadCount: 0, needs_merchant_reply: false }) });
        return route.fulfill({ json: json([]) });
    });
    return { state, cfg };
}

async function loginAndDashboard(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/dashboard');
}

const dash = (page: Page) => page.locator('main');

test('D5 charges card: label, gross-UTC note, tooltip, UTC-day chip, /subscription destination', async ({ page }) => {
    const { state } = await setupRoutes(page);
    await loginAndDashboard(page);
    const charges = dash(page).getByRole('link', { name: /Recorded delivery charges today/ });
    await expect(charges).toBeVisible();
    await expect(charges).toHaveAttribute('href', '/subscription');
    await expect(charges).toContainText('1,234.50');
    await expect(charges).toContainText('Gross ledger entries for the UTC day — not invoiced or collected.');
    await expect(charges).toContainText('2026-11-24 UTC · 4 orders');
    await expect(charges).toHaveAttribute('title', 'Returns and cancellations recorded today reduce this total. Credits are applied at invoice time.');
    expect(state.unexpected).toEqual([]);
});

// A8 MINOR (fix-5): i18next plural forms — dayCount_one must win for one.
test('D5 dayCount plural: a single delivered order reads "1 order", never "1 orders"', async ({ page }) => {
    const { state } = await setupRoutes(page, { signals: 'singleOrder' });
    await loginAndDashboard(page);
    const charges = dash(page).getByRole('link', { name: /Recorded delivery charges today/ });
    await expect(charges).toBeVisible();
    await expect(charges).toContainText('2026-11-24 UTC · 1 order');
    await expect(charges).not.toContainText('1 orders');
    expect(state.unexpected).toEqual([]);
});

// A8 MAJOR-2 (fix-7): the exceptions figure and the Orders nav badge read the
// SAME exhaustive bucket count — 12 rows reported over the capped 10-row
// sample must not make the screen show two disagreeing numbers. Header-
// removal C6: the hero badge is gone (absence-pinned); the honesty check
// relocates to the record-level BusinessHealth tile, which shares the same
// worklistNeedsActionCount authority.
test('exceptions figure == Orders badge count (12) over a capped 10-row sample, no header band', async ({ page }) => {
    const { state } = await setupRoutes(page, { needsActionCount: 12, exceptionSampleRows: 10 });
    await loginAndDashboard(page);
    await expect(page.getByTestId('dashboard-signal')).toHaveCount(0);
    const exceptionsTile = page.getByRole('link', { name: /Delivery exceptions/ });
    await expect(exceptionsTile).toContainText('12');
    const rail = page.locator('aside nav').first();
    await expect(rail.getByRole('link', { name: 'Orders 12 orders need action' })).toBeVisible();
    // Exhaustive bucket count → no lower-bound sign even though the sample
    // was capped at 10.
    await expect(exceptionsTile).not.toContainText('12+');
    expect(state.unexpected).toEqual([]);
});

test('D5 bn: charges copy + amount render in Bangla (Intl at runtime, no literal digits)', async ({ page }) => {
    // A8 round-3: 3 exception sample rows → the AttentionQueue group note has
    // hidden work to count, so its bn digits get pinned here too.
    await setupRoutes(page, { exceptionSampleRows: 3 });
    await loginAndDashboard(page);
    await page.locator('header .mw-language-toggle').click();
    await page.reload();
    const charges = dash(page).getByRole('link', { name: /আজকের রেকর্ডকৃত ডেলিভারি চার্জ/ });
    await expect(charges).toBeVisible();
    const text = await charges.textContent();
    // ১,২৩৪.৫০ — Bangla digits from Intl bn-BD.
    expect(text).toContain('১,২৩৪.৫০');
    expect(text).not.toMatch(/1,234/);
    expect(text).toContain('UTC দিনের গ্রস লেজার এন্ট্রি');
    // A8 MAJOR-3: the count on the chip is Bangla too (displayCount), with
    // the plural slot still fed the raw numeric count.
    expect(text).toContain('৪টি অর্ডার');
    expect(text).not.toMatch(/· 4 অর্ডার/);

    // A8 round-3 (MINOR-2): the UTC accounting DAY is Bangla too — no Latin
    // digit survives anywhere in the card in bn, and the explicit UTC label
    // stays (accounting-day semantics unchanged).
    expect(text).toContain('UTC');
    expect(text).not.toMatch(/[0-9]/);

    // C1/C6 flip: the explanatory hero sentence was a header-band render and
    // is gone (absence pin). Its Bangla-numeral duty (A8 MAJOR-3) relocates
    // to the record-level exceptions tile — same locale-bound Intl formatter:
    await expect(dash(page).getByText('যাচাই করা কাজ অপেক্ষায়')).toHaveCount(0);
    const exceptionsTile = dash(page).getByRole('link', { name: /ডেলিভারিতে অস্বাভাবিকতা/ });
    await expect(exceptionsTile).toBeVisible();
    const tileText = await exceptionsTile.textContent();
    expect(tileText).toContain('১');
    expect(tileText).not.toMatch(/[0-9]/);

    // A8 round-2 (MINOR-1): the hidden-count note interpolates displayCount —
    // "1 more in this group" reads ১টি in bn, never a raw Latin digit.
    await expect(dash(page).getByText('এই তালিকায় আরও ১টি')).toBeVisible();

    // A8 round-3 (INFO): exception rows localize the order-status enum through
    // the shared dashboard.pulse.status vocabulary — no raw "returned".
    await expect(dash(page).getByText('ফেরত এসেছে').first()).toBeVisible();
    await expect(dash(page).getByText('returned', { exact: true })).toHaveCount(0);
});

test('needs_reply honesty on the reply card: exact, N+ lower bound, 99+ cap, Unavailable — never 0', async ({ page }) => {
    const { state, cfg } = await setupRoutes(page, { needsReply: 'complete' });
    await loginAndDashboard(page);
    const replyCard = () => dash(page).getByRole('link', { name: /Conversations awaiting reply/ });
    await expect(replyCard()).toContainText('2');
    await expect(replyCard()).toHaveAttribute('href', '/inbox?tab=needs_review');

    cfg.needsReply = 'partial';
    await page.reload();
    await expect(replyCard()).toContainText('8+');

    cfg.needsReply = 'capped';
    await page.reload();
    await expect(replyCard()).toContainText('99+');

    // null source = failed read: the card says Unavailable — never "0", which
    // would be a false exhaustive claim (guardrails §16/§21.1).
    cfg.needsReply = 'null';
    await page.reload();
    await expect(replyCard()).toContainText('Unavailable');
    await expect(replyCard()).not.toContainText('0');
    expect(state.unexpected).toEqual([]);
});

test('commerce signals per-source null ≠ 0: null deliveredCharges/recentActivity render honest unavailable states', async ({ page }) => {
    const { state, cfg } = await setupRoutes(page, { signals: 'nullSignals' });
    await loginAndDashboard(page);
    await expect(dash(page).getByRole('link', { name: /Recorded delivery charges today/ })).toContainText('Not available');
    await expect(dash(page).getByText('Activity is unavailable. Refresh to retry.')).toBeVisible();

    cfg.signals = 'emptyActivity';
    await page.reload();
    // Empty list is a VERIFIED zero-state — distinct copy from "could not read".
    await expect(dash(page).getByText('No matching audited activity yet.')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('D4 activity: capped to six rows, stored actor or System, ORDER rows deep-link, others unlinked, PII-free', async ({ page }) => {
    const { state } = await setupRoutes(page, { signals: 'normal' });
    await loginAndDashboard(page);
    const section = dash(page).locator('section[aria-labelledby="dashboard-activity-heading"]');
    await expect(section.getByRole('link', { name: 'View all activity' })).toHaveAttribute('href', '/audit-logs');
    // 7 seeded rows → exactly 6 rendered (limit 6, Dhaka-time note kept).
    await expect(section.locator('ul > li')).toHaveCount(6);
    await expect(section.getByText(/Dhaka time/)).toBeVisible();
    // Row 1: stored user + ORDER resource → the only verified deep link.
    const orderRow = section.getByRole('link', { name: /Signal Owner/ });
    await expect(orderRow).toHaveAttribute('href', '/orders?orderId=order-deep-1');
    // DE-3 (57fed705): D4 actions render localized labels, never raw
    // vocabulary — ORDER_CONFIRMED → "Order confirmed".
    await expect(orderRow).toContainText('Order confirmed');
    // Product rows (user null or not) never fabricate a destination.
    await expect(section.getByRole('link', { name: /System/ })).toHaveCount(0);
    await expect(section.getByRole('link', { name: /Product stock updated/ })).toHaveCount(0);
    // Body-regex tripwire: no customer-PII vocabulary reaches the DOM. This
    // is the cheap E2E smoke over a MOCKED payload — the real proof that PII
    // never reaches the projection lives in the integration lane
    // (src/test/InboxStoragePrivacy.test.tsx + the D3 server-side field
    // whitelist tests), so a pass here complements, never replaces, it.
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/customer_phone|customer_name|01700\d{5}/);
    expect(state.unexpected).toEqual([]);
});

test('D6 AI chip: full 8-state matrix from the channels payload only (billing fail-closed)', async ({ page }) => {
    const matrix: Array<[ChannelsMode, string, string]> = [
        ['none', 'notConnected', 'Not connected'],
        ['auto', 'auto', 'AI auto-reply on'],
        ['draft', 'draft', 'AI drafts replies'],
        ['manual', 'manual', 'Manual replies'],
        ['mixed', 'mixed', 'AI modes vary by channel'],
        ['autoBillingOff', 'mixed', 'AI modes vary by channel'],
        ['emergency', 'emergencyStop', 'Emergency stop active'],
        ['reconnect', 'reconnectRequired', 'Reconnect required'],
    ];
    const { cfg, state } = await setupRoutes(page);
    await loginAndDashboard(page);
    for (const [mode, expectedState, expectedLabel] of matrix) {
        cfg.channels = mode;
        await page.reload();
        const chip = page.getByTestId('ai-status-chip');
        await expect(chip).toHaveAttribute('data-state', expectedState, `mode=${mode}`);
        await expect(chip).toContainText(expectedLabel);
        await expect(chip).toHaveAttribute('href', '/manage-shop/channels');
        await expect(chip.evaluate((el) => el.tagName)).resolves.toBe('A');
    }
    // Read-only forever: no button inside or labelled by the chip surface.
    await expect(page.locator('header').getByRole('button', { name: /AI|auto|reply/i })).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('D6 fail-closed: channel fetch failure → chip unavailable, never a green guess', async ({ page }) => {
    const { state } = await setupRoutes(page, { channels: 'fail' });
    await loginAndDashboard(page);
    const chip = page.getByTestId('ai-status-chip');
    await expect(chip).toHaveAttribute('data-state', 'unavailable');
    await expect(chip).toContainText('Status unavailable');
    expect(state.unexpected).toEqual([]);
});

test('D7 ConnectionHealth meta row: verified / unverified / reconnect (real POST only, honest failure status)', async ({ page }) => {
    const { cfg, state } = await setupRoutes(page, { channels: 'verified' });
    await loginAndDashboard(page);
    const metaRow = dash(page).getByTestId('connections-meta-row');
    await expect(metaRow).toContainText('Connected · verified');

    cfg.channels = 'unverified';
    await page.reload();
    await expect(metaRow).toContainText('Connected · not verified');
    // No auto-ping / test-webhook call ever fired by merely viewing:
    expect(state.reconnectPosts).toBe(0);

    cfg.channels = 'reconnect';
    await page.reload();
    await expect(metaRow).toContainText('Reconnect required');
    await expect(metaRow.getByTestId('connection-reconnect-ch-1')).toBeVisible();
    await metaRow.getByTestId('connection-reconnect-ch-1').click();
    // 5b9423fd: a 200 without redirectUrl now renders the dedicated
    // reconnectFailed copy (was the generic "Status unavailable" fallback).
    await expect(metaRow.getByRole('status')).toContainText('Could not start reconnecting');
    // Exactly one reconnect attempt (the click) — the server would return the
    // real OAuth redirect URL; we never fabricate one client-side.
    expect(state.reconnectPosts).toBe(1);
    expect(state.unexpected).toEqual([]);
});

test('D7 ConnectionHealth courier row: ACTIVE vs READY are distinct, SETUP_INCOMPLETE + missing count (provider_not_active excluded), notSetUp, failed-read + retry', async ({ page }) => {
    const { cfg, state } = await setupRoutes(page, { readiness: 'active' });
    await loginAndDashboard(page);
    const courierRow = dash(page).getByTestId('connections-courier-row');
    await expect(courierRow).toContainText('Ready');

    // A8 MAJOR (fix-4): READY = configured but NOT active — it can never
    // dispatch, so it must never borrow the healthy "Ready" verdict.
    cfg.readiness = 'ready';
    await page.reload();
    await expect(courierRow).toContainText('Connected · inactive');

    cfg.readiness = 'setup';
    await page.reload();
    await expect(courierRow).toContainText('Setup incomplete');
    // missing = webhook_secret + default_store (+ provider_not_active EXCLUDED)
    await expect(courierRow.getByText('2 steps missing')).toBeVisible();

    cfg.readiness = 'none';
    await page.reload();
    await expect(courierRow).toContainText('Not set up');

    cfg.readiness = 'fail';
    await page.reload();
    await expect(courierRow).toContainText('Status unavailable');
    await expect(dash(page).getByTestId('connections-retry')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('axe (reducedMotion first): dashboard with signal cards + activity + health modules has no critical/serious violations, en and bn', async ({ page }) => {
    const AxeBuilder = (await import('@axe-core/playwright')).default;
    for (const lang of ['en', 'bn'] as const) {
        await setupRoutes(page, { channels: 'verified', readiness: 'setup' });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await loginAndDashboard(page);
        if (lang === 'bn') {
            await page.locator('header .mw-language-toggle').click();
            await page.reload();
        }
        await expect(dash(page).getByTestId('connections-courier-row')).toBeVisible();
        // Colors are only meaningful on a SETTLED page: reducedMotion strips
        // transforms but framer opacity fades still run, and the bn font-load
        // shifts their timing (a mid-fade scan measures blended colors — the
        // exact axe-under-animation trap from the guardrails precedent).
        await page.waitForFunction(
            () => document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle'),
            undefined,
            { timeout: 15000 },
        ).catch(() => undefined);
        await page.waitForTimeout(600);
        const results = await new AxeBuilder({ page }).include('.em-dashboard').analyze();
        const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
        expect(blocking, `axe in ${lang}`).toEqual([]);
    }
});
