/**
 * Business-automation guardrails proof (mock-only, CI subset). Execution-class
 * settings page (§29): signal header + factual pills with no CTA, real switch
 * semantics that the owner/stop fieldset can disable, honest helper copy for
 * settings the runtime never reads, load-error recovery, 390px no-overflow and
 * axe `.em-automation` (accordion expanded so the keyword controls are scanned).
 * Allowlist+abort discipline: invented backend calls fail here. The reply-mode
 * radiogroup and canonical save contracts stay covered by ai-reply-mode.spec.ts
 * and channel-automation.spec.ts.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const json = (data: unknown) => ({ success: true, data });

const baseSettings = () => ({
    automation_mode: 'DRAFT',
    confidence_threshold: 75,
    auto_reply_enabled: false,
    max_auto_order_value: 5000,
    ask_email: false,
    primary_language: 'mixed',
    required_fields: {
        customer_name: true, mobile_number: true, delivery_address: true,
        payment_method: true, email_address: false, special_instructions: false,
    },
    handoff_settings: { trigger_keywords: ['complain'], notification_channel: 'in_app', cooldown_minutes: 30 },
    greeting: { enabled: true, custom_text: 'Welcome' },
    closing: { enabled: true, custom_text: 'Thanks' },
    emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
});

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/notifications/telegram', '/api/commercial/claims',
    '/api/public/commercial-contract', '/api/shop/business-info', '/api/shop/ai-settings',
    '/api/shop/ai/emergency-stop', '/api/shop/ai/emergency-resume', '/api/channels/meta',
    '/api/conversation/events', '/api/dashboard/metrics', '/api/dashboard/queue', '/api/order',
    '/api/templates', '/api/inbox/actions', '/api/audit',
]);
const KNOWN_PATTERNS = [
    /^\/api\/channels\/meta\/[^/]+\/settings$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

async function setupRoutes(page: Page, opts: { role?: string; stopped?: boolean } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        role: opts.role ?? 'owner',
        settings: baseSettings(),
        failLoads: false,
        puts: [] as Record<string, unknown>[],
        stopPosts: 0,
        resumePosts: 0,
    };
    if (opts.stopped) {
        state.settings.automation_mode = 'MANUAL';
        state.settings.emergency_stop = { active: true, at: new Date().toISOString(), by: 'user-1', source: 'merchant', prior_mode: 'DRAFT' };
    }
    const shop = () => ({ id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: state.role });

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
            return route.fulfill({ json: json({ user: mockUser, currentShop: shop(), allShops: [shop()] }) });
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            state.signedIn = true;
            return route.fulfill({ json: json({ user: mockUser, currentShop: shop(), allShops: [shop()] }) });
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
        if (path === '/api/shop/business-info') return route.fulfill({ json: json({ businessInfo: { shopName: 'My BD Shop' }, shop: shop() }) });
        if (path === '/api/shop/ai-settings' && method === 'GET') {
            if (state.failLoads) return route.fulfill({ status: 500, json: { success: false, error: { message: 'Automation defaults could not load.' } } });
            return route.fulfill({ json: json(state.settings) });
        }
        if (path === '/api/shop/ai-settings' && method === 'PUT') {
            const body = request.postDataJSON() as Record<string, unknown>;
            state.puts.push(body);
            state.settings = { ...state.settings, ...body } as typeof state.settings;
            return route.fulfill({ json: json(state.settings) });
        }
        if (path === '/api/shop/ai/emergency-stop' && method === 'POST') {
            state.stopPosts += 1;
            state.settings.automation_mode = 'MANUAL';
            state.settings.emergency_stop = { active: true, at: new Date().toISOString(), by: 'user-1', source: 'merchant', prior_mode: 'DRAFT' };
            return route.fulfill({ json: json({ ...state.settings.emergency_stop, already_active: false }) });
        }
        if (path === '/api/shop/ai/emergency-resume' && method === 'POST') {
            state.resumePosts += 1;
            state.settings.emergency_stop = { active: false, at: null, by: null, source: null, prior_mode: null };
            return route.fulfill({ json: json({ active: false, automation_mode: 'MANUAL', prior_mode: 'DRAFT', already_inactive: false }) });
        }
        if (path === '/api/channels/meta' && method === 'GET') return route.fulfill({ json: json([]) });
        if (path === '/api/conversation/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
        if (path === '/api/dashboard/metrics') return route.fulfill({ json: json({}) });
        if (path === '/api/dashboard/queue') return route.fulfill({ json: json({}) });
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
    await page.goto('/manage-shop/automation');
    await expect(page.getByTestId('automation-signal')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + signal + factual pills, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Automation defaults', exact: true })).toBeVisible();
    await expect(page.getByTestId('automation-signal')).toContainText('Drafts need review');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByText(/Mode: Drafts for review/)).toBeVisible();
    await expect(page.getByText(/Confidence: 75%/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Channels & Automation' })).toHaveAttribute('href', '/manage-shop/channels');
    expect(state.unexpected).toEqual([]);
});

test('toggles are real switches: keyboard operable, dirty-gated, and saved canonically', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const askEmail = page.getByRole('switch', { name: 'Ask customer for email' });
    await expect(askEmail).toHaveAttribute('aria-checked', 'false');
    const save = page.getByRole('button', { name: 'Save Reply Settings', exact: true });
    await expect(save).toBeDisabled();
    await askEmail.focus();
    await page.keyboard.press('Space');
    await expect(askEmail).toHaveAttribute('aria-checked', 'true');
    await expect(save).toBeEnabled();
    const put = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/shop/ai-settings' && r.method() === 'PUT');
    await save.click();
    const request = await put;
    expect(request.postDataJSON()).toMatchObject({ ask_email: true, automation_mode: 'DRAFT', auto_reply_enabled: false });
    await expect(page.getByText('Reply settings saved.', { exact: true })).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('non-owner: the fieldset disables the switches and the header says read-only', async ({ page }) => {
    const state = await setupRoutes(page, { role: 'manager' });
    await loginAndGo(page);
    // Playwright treats a disabled <fieldset> as enabled itself and only reports
    // its DESCENDANTS as disabled — so assert the real controls, then the attr.
    await expect(page.getByRole('switch', { name: 'Ask customer for email' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Closing message' })).toBeDisabled();
    await expect(page.getByTestId('automation-settings-fieldset')).toHaveAttribute('disabled', '');
    await expect(page.getByRole('button', { name: 'Save Reply Settings', exact: true })).toBeDisabled();
    await expect(page.getByText(/Only the shop owner can change automation defaults/i)).toBeVisible();
    await expect(page.getByTestId('automation-signal')).toContainText('Read-only');
    expect(state.puts).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
});

test('emergency stop locks the editor; resume unlocks it after a reload', async ({ page }) => {
    const state = await setupRoutes(page, { stopped: true });
    await loginAndGo(page);
    await expect(page.getByTestId('automation-emergency-stop-notice')).toContainText(/locked to Manual until the emergency stop is resumed/i);
    await expect(page.getByRole('switch', { name: 'Ask customer for email' })).toBeDisabled();
    await expect(page.getByTestId('automation-settings-fieldset')).toHaveAttribute('disabled', '');
    await expect(page.getByTestId('automation-signal')).toContainText('AI replies stopped');

    await page.getByTestId('emergency-resume-button').click();
    await expect(page.getByTestId('emergency-stop-button')).toBeVisible();
    expect(state.resumePosts).toBe(1);
    // The page's own settings snapshot is not wired to the card's query cache
    // (documented gap), so re-navigate before asserting the unlocked editor.
    await page.goto('/manage-shop/automation');
    await expect(page.getByRole('switch', { name: 'Ask customer for email' })).toBeEnabled();
    await expect(page.getByTestId('automation-emergency-stop-notice')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('stop confirm is labelled, traps focus, and cancels without a write', async ({ page }) => {
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

test('honesty: recorded-only settings say so, and the fixed confidence is disclosed', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByText(/Order value does not limit automatic replies today/i)).toBeVisible();
    await expect(page.getByText(/Checkout does not ask for or enforce these fields today/i)).toBeVisible();
    await expect(page.getByText(/Replies do not ask for an email address today/i)).toBeVisible();
    await expect(page.getByText(/any threshold at or below 90% passes every reply/i)).toBeVisible();
    await page.getByRole('button', { name: /When We Should Alert You/i }).click();
    await expect(page.getByText(/Alerts use EasyModerator's built-in sentiment checks, not this list/i)).toBeVisible();
    await expect(page.getByText(/Merchant alerts are delivered by your Notifications settings/i)).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('load failure is an alert and retry recovers the editor', async ({ page }) => {
    const state = await setupRoutes(page);
    state.failLoads = true;
    await loginAndGo(page);
    await expect(page.getByRole('alert').first()).toContainText(/could not load/i);
    await expect(page.getByTestId('automation-signal')).toContainText('Defaults unavailable');
    state.failLoads = false;
    await page.getByRole('button', { name: /Retry loading defaults/i }).click();
    await expect(page.getByTestId('ai-reply-mode')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow on the automation editor', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByRole('button', { name: /When We Should Alert You/i }).click();
    await expect(page.getByRole('button', { name: 'Add keyword' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(state.unexpected).toEqual([]);
});

test('axe: no critical or serious violations in the automation surface', async ({ page }) => {
    const state = await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    // Expand the handoff panel first: collapsed, the keyword controls (the ones
    // that used to have empty accessible names) are never scanned.
    await page.getByRole('button', { name: /When We Should Alert You/i }).click();
    await expect(page.getByRole('button', { name: 'Add keyword' })).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-automation').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
    expect(state.unexpected).toEqual([]);
});
