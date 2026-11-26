/**
 * Channels-workspace guardrails proof (mock-only, CI subset). Execution-class
 * workspace (§29): signal header + factual pills, emergency-stop confirm dialog
 * focus trap + Escape + labelled semantics, per-channel tabpanel semantics,
 * 390px no-overflow, axe `.em-channels`. Allowlist+abort discipline: invented
 * backend calls fail here. The detailed narrow-only override / OAuth contracts
 * remain covered by channel-automation.spec.ts and meta-oauth-contract.spec.ts.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const channelRow = {
    id: 'c1',
    platform: 'facebook',
    status: 'CONNECTED',
    isHealthy: true,
    needsReconnect: false,
    displayName: 'Inherited Page',
    metaAssetId: 'p1',
    pictureUrl: null,
    purposeLabel: null,
    tokenExpiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
    webhookSubscribedFields: ['messages'],
    webhookLastVerifiedAt: new Date().toISOString(),
    effective_mode: 'DRAFT',
    mode_source: 'business_default',
    override_count: 0,
    warnings: [],
    emergency_stop: { active: false },
    billing_ai_active: true,
};

const settingsFor = {
    channelId: 'c1',
    overrides: {},
    mode_source: 'business_default',
    warnings: [],
    emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
    billing_ai_active: true,
    allowOrderCreation: true,
    purposeLabel: null,
    businessHours: null,
    deprecated_fields: ['confidenceThresholdSend', 'confidenceThresholdSuggest'],
    effective: {
        automation_mode: 'DRAFT',
        confidence_threshold: 75,
        greeting: { enabled: true, custom_text: 'Welcome' },
        business_hours: null,
        allow_order_creation: true,
        purpose_label: null,
    },
};

const aiSettings = {
    automation_mode: 'DRAFT',
    auto_reply_enabled: false,
    primary_language: 'en',
    closing: { enabled: false, custom_text: '' },
    max_auto_order_value: 5000,
    emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/notifications/telegram', '/api/commercial/claims',
    '/api/public/commercial-contract', '/api/shop/business-info', '/api/shop/ai-settings',
    '/api/shop/ai/emergency-stop', '/api/shop/ai/emergency-resume', '/api/channels/meta',
    '/api/conversation/events', '/api/dashboard/metrics', '/api/dashboard/queue', '/api/order',
    '/api/templates', '/api/inbox/actions', '/api/audit',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness',
]);
const KNOWN_PATTERNS = [
    /^\/api\/channels\/meta\/[^/]+\/settings$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page) {
    const state = { signedIn: false, unexpected: [] as string[], stopPosts: 0 };
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
        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 } }) });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } }) });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] } }) });
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
            return route.fulfill({ json: json({ surface, locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/notifications/telegram') return route.fulfill({ json: json({ connected: false }) });
        if (path === '/api/shop/business-info') return route.fulfill({ json: json({ businessInfo: { shopName: 'My BD Shop' }, shop: mockShop }) });
        if (path === '/api/shop/ai-settings') return route.fulfill({ json: json(aiSettings) });
        if (path === '/api/shop/ai/emergency-stop' && method === 'POST') {
            state.stopPosts += 1;
            return route.fulfill({ json: json({ active: true, source: 'merchant', prior_mode: 'DRAFT', already_active: false }) });
        }
        if (path === '/api/shop/ai/emergency-resume' && method === 'POST') {
            return route.fulfill({ json: json({ active: false, automation_mode: 'MANUAL', prior_mode: 'DRAFT', already_inactive: false }) });
        }
        if (path === '/api/channels/meta' && method === 'GET') return route.fulfill({ json: json([channelRow]) });
        if (/^\/api\/channels\/meta\/[^/]+\/settings$/.test(path) && method === 'GET') return route.fulfill({ json: json(settingsFor) });
        if (path === '/api/conversation/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
        if (path === '/api/dashboard/metrics') return route.fulfill({ json: json({}) });
        if (path === '/api/dashboard/queue') return route.fulfill({ json: json({}) });
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndGo(page: Page, target = '/manage-shop/channels') {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto(target);
    // Page-mounted gate: overview owns its compact title; the detail record
    // page exposes the resolver-backed effective mode (record-level, survives).
    await expect(
        page.getByRole('heading', { name: 'Channels & Automation', exact: true })
            .or(page.getByTestId('channel-effective-mode'))
            .first(),
    ).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('page header: compact title, no signal band, no header CTA; status lives per card', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Channels & Automation', exact: true })).toBeVisible();
    // Removal pinned: no page-level signal badge and no shop-level count band.
    await expect(page.getByTestId('channels-signal')).toHaveCount(0);
    await expect(page.getByText(/Connected:/)).toHaveCount(0);
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    // The connected fact survives at record level inside the channel card.
    await expect(page.getByTestId('channel-card-c1')).toContainText('Connected');
    expect(state.unexpected).toEqual([]);
});

test('emergency-stop confirm is labelled, traps focus, and closes on Escape', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByTestId('emergency-stop-button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'emergency-stop-confirm-title');
    await expect(dialog.getByText('Stop all AI replies?')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.contains(document.activeElement) : false;
    })).toBe(true);
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(state.stopPosts).toBe(0);
    expect(state.unexpected).toEqual([]);
});

test('channel detail exposes tabpanel semantics and the effective mode', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page, '/manage-shop/channels/c1');
    await expect(page.getByTestId('channel-effective-mode')).toContainText('Drafts for review');
    await expect(page.getByRole('tablist')).toBeVisible();
    await page.getByRole('tab', { name: 'AI behavior' }).click();
    await expect(page.getByRole('tabpanel', { name: 'AI behavior' })).toBeVisible();
    await expect(page.getByText('Confidence threshold')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow on the workspace', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Channels & Automation', exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the channels surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Channels & Automation', exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-channels').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
