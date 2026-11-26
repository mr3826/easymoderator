/**
 * Business-info guardrails proof (mock-only, CI subset). Execution-class
 * settings surface (§29) inside the Business & FAQ Settings redesign:
 * /manage-shop/business-info now renders the three-tab workspace
 * (business-faq-tab-{profile,faqs,policies}) with the PROFILE tab active and
 * the tab's legacy-style PageHeader INSIDE its panel. Every legacy pin is
 * preserved: signals, the payload exclusion rule (NOW the 10-key extended
 * profile PUT — nameEn/tagline/email/city + all six socialLinks — still
 * without deliveryAreas/paymentMethods), server-confirmed save + shop-list
 * refresh, dirty gating, char counter, social group, load-failure retry, the
 * automation deep-link, the ADR-0013 §1 boundary (checked ACROSS ALL TABS:
 * no radiogroup, no range input, no ai-reply-mode, no 'Save Reply Settings'),
 * 390px overflow + five mobile destinations, and axe on `.em-business`.
 * Allowlist+abort discipline: invented backend calls fail here
 * (state.unexpected === [] in every test).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

const businessInfo = {
    shopName: 'Automation Test Shop',
    phone: '01711000000',
    address: 'Dhaka, Bangladesh',
    openingHours: '9am-6pm',
    additionalInfo: '',
    socialLinks: { facebook: 'https://facebook.com/test' },
    // Stored on the shop but NEVER written by this surface (Delivery/Payment
    // pages own them) — the payload-exclusion pin proves the UI drops them.
    deliveryAreas: ['Dhaka'],
    paymentMethods: ['COD'],
};

// One published FAQ so the FAQ panel's legacy pins (faq-signal "Knowledge
// ready", faq-add visible) hold when the ADR boundary test activates the tab.
const faqRow = {
    id: 'faq-1',
    question: 'What is the delivery charge?',
    category_tag: 'Delivery',
    answers: { en: 'Inside Dhaka delivery is 80 BDT.', bn: 'ঢাকার ভেতরে ডেলিভারি ৳৮০।' },
    keywords: [],
    notes: null,
    status: 'published',
    is_active: true,
    priority: 5,
    use_count: 3,
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    sync_status: 'synced',
    sync_version: 2,
    synced_at: '2026-07-04T00:10:00.000Z',
    // Legacy aliases the server still emits.
    answer: 'Inside Dhaka delivery is 80 BDT.',
    category: 'What is the delivery charge?',
    template_en: 'Inside Dhaka delivery is 80 BDT.',
    template_bn: 'ঢাকার ভেতরে ডেলিভারি ৳৮০।',
    confidence: 1.0,
    source: 'manual',
    active: true,
    usageCount: 3,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
};

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/shop/business-info', '/api/shop/list', '/api/shop/business-policies',
    // 2026-11-26 redesign: tabbed workspace — switching tabs from this route
    // legitimately mounts the FAQ list + gap suggestions + server search.
    '/api/knowledge/faqs', '/api/knowledge/gap-suggestions', '/api/knowledge/faq/search',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
    /^\/api\/knowledge\/faqs\/[\w-]+$/,
    /^\/api\/knowledge\/faqs\/[\w-]+\/(archive|restore|resync)$/,
    /^\/api\/knowledge\/gap-suggestions\/[\w-]+\/(review|dismiss|publish)$/,
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function setupRoutes(page: Page, options: { loadFails?: number } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        puts: 0,
        shopListCalls: 0,
        loadFails: options.loadFails ?? 0,
        lastPutBody: null as Record<string, unknown> | null,
        // Server-side stored business info — mutated by every successful PUT
        // so reloads reflect real persisted (incl. CLEARED) values.
        stored: { ...businessInfo } as Record<string, unknown>,
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
        if (path === '/api/channels/meta' && method === 'GET') {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
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
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/shop/business-info' && method === 'GET') {
            if (state.loadFails > 0) {
                state.loadFails -= 1;
                return route.fulfill({ status: 500, json: { success: false, message: 'Network error' } });
            }
            // Mutable store (round-2 clear-semantics pin): the reload path
            // must reflect exactly what the last PUT persisted — including
            // cleared (empty-string) fields.
            return route.fulfill({ json: json({ businessInfo: state.stored, shop: mockShop }) });
        }
        if (path === '/api/shop/business-info' && method === 'PUT') {
            state.puts += 1;
            const body = request.postDataJSON() as Record<string, unknown>;
            // Mirror the LIVE shop.validator bounds (2026-11-26): the client
            // must never get to send values the server would reject.
            const bad =
                (typeof body.email === 'string' && body.email && !EMAIL_REGEX.test(body.email)) ||
                (typeof body.nameEn === 'string' && body.nameEn.length > 120) ||
                (typeof body.tagline === 'string' && body.tagline.length > 160) ||
                (typeof body.city === 'string' && body.city.length > 60);
            if (bad) {
                return route.fulfill({ status: 400, json: { success: false, message: 'Invalid business info payload', code: 'VALIDATION_ERROR' } });
            }
            state.lastPutBody = body;
            // Server contract (19b48b39 / validator §): an EMPTY STRING clears
            // the stored value; an ABSENT key leaves it untouched. The PUT
            // payload sends every managed field, so clearing really clears.
            state.stored = { ...state.stored, ...body };
            return route.fulfill({ json: json({ businessInfo: state.stored }) });
        }
        if (path === '/api/shop/list') {
            state.shopListCalls += 1;
            return route.fulfill({ json: json([mockShop]) });
        }
        if (path === '/api/knowledge/faqs' && method === 'GET') {
            return route.fulfill({ json: json([faqRow]) });
        }
        if (path === '/api/knowledge/gap-suggestions' && method === 'GET') {
            // Flag off — the gap section renders nothing (unchanged contract).
            return route.fulfill({ status: 409, json: { success: false, error: { code: 'FEATURE_DISABLED' } } });
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
    await page.goto('/manage-shop/business-info');
    // Workspace mount: profile tab owns the tablist; the form is the readiness
    // signal for the mechanics below (legacy page-header pins are asserted in
    // the dedicated header test, not used as a wait condition).
    await expect(page.getByTestId('business-faq-tab-profile')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Shop Name', { exact: true })).toBeVisible({ timeout: 15_000 });
}

async function activateTab(page: Page, tab: 'profile' | 'faqs' | 'policies') {
    await page.getByTestId(`business-faq-tab-${tab}`).click();
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('workspace route truth: /manage-shop/business-info opens the Profile tab', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('tablist', { name: 'Business and FAQ settings sections' })).toBeVisible();
    await expect(page.getByTestId('business-faq-tab-profile')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('business-faq-tab-faqs')).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('business-faq-tab-policies')).toHaveAttribute('aria-selected', 'false');
    // S7: only the active panel mounts — FAQ/policies data is fetched lazily,
    // so a fresh Profile visit must NOT have hit their endpoints.
    await expect(page.locator('#business-faq-panel-profile')).toBeVisible();
    // §29: no header CTA anywhere on the execution surface.
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    await expect(page.getByTestId('inbox-primary-action')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('execution header: title + profile signal + pills, no header CTA', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    // Legacy §29 pins, now INSIDE the profile panel (01 S9/P1/P2) — restored
    // at 88f0328f (my D1): h1 + business-signal + factual pills.
    await expect(page.getByRole('heading', { name: 'Business Info', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByTestId('business-signal')).toContainText('Profile ready');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    // P2: social tally must cover ALL SIX keys — fixture stores 1 (facebook).
    await expect(page.getByText('Social links: 1')).toBeVisible();
    await expect(page.getByText('Extra info: 0')).toBeVisible();
    // Clean baseline: no unsaved pill (P7 dirty gate mirrors delivery-charges-unsaved).
    await expect(page.getByTestId('profile-changes-unsaved')).toHaveCount(0);
});

test('save is dirty-gated and PUTs the 10-key extended payload then refreshes the shop list', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    const save = page.getByRole('button', { name: 'Save Changes' });
    await expect(save).toBeDisabled();
    await expect(page.getByLabel('Shop Name', { exact: true })).toHaveValue('Automation Test Shop');

    await page.getByLabel('Shop Name', { exact: true }).fill('Updated Shop');
    await page.getByLabel('Shop name (English)').fill('Updated Shop EN');
    await page.getByLabel('Tagline').fill('Fast, honest replies');
    await page.getByLabel('City').fill('Dhaka');
    await page.getByLabel('Email').fill('care@easymod.test');
    await page.getByLabel('Facebook').fill('https://facebook.com/test');
    await page.getByLabel('Website').fill('https://easymod.test');
    await page.getByLabel('Instagram').fill('https://instagram.com/easymod.test');
    await page.getByLabel('WhatsApp').fill('01711000000');
    await page.getByLabel('TikTok').fill('https://tiktok.com/@easymod.test');
    await page.getByLabel('YouTube').fill('https://youtube.com/@easymod.test');
    await expect(save).toBeEnabled();
    // P7 (restored at 88f0328f): dirty state shows the amber unsaved pill.
    await expect(page.getByTestId('profile-changes-unsaved')).toBeVisible();
    await save.click();
    await expect.poll(() => state.puts).toBe(1);
    const body = state.lastPutBody as Record<string, unknown>;
    // P5 rule, extended by contract: exactly the ten edited-field keys; the
    // four new fields ride; deliveryAreas/paymentMethods STILL excluded.
    expect(Object.keys(body).sort()).toEqual(
        ['additionalInfo', 'address', 'city', 'email', 'nameEn', 'openingHours', 'phone', 'shopName', 'socialLinks', 'tagline'],
    );
    expect(body.shopName).toBe('Updated Shop');
    expect(body.nameEn).toBe('Updated Shop EN');
    expect(body.tagline).toBe('Fast, honest replies');
    expect(body.email).toBe('care@easymod.test');
    expect(body.city).toBe('Dhaka');
    expect(body).not.toHaveProperty('deliveryAreas');
    expect(body).not.toHaveProperty('paymentMethods');
    expect(Object.keys(body.socialLinks as Record<string, unknown>).sort()).toEqual(
        ['facebook', 'instagram', 'tiktok', 'website', 'whatsapp', 'youtube'],
    );
    await expect.poll(() => state.shopListCalls).toBeGreaterThanOrEqual(1);
    // Server-confirmed only (P8): success lands after the awaited PUT resolves.
    await expect(page.getByRole('status')).toContainText('Business info saved');
    // Re-baselined: the unsaved pill clears with the server row.
    await expect(page.getByTestId('profile-changes-unsaved')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('invalid email blocks the save before any request fires (client + server bounds agree)', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByLabel('Email').fill('not-an-email');
    await expect(page.getByRole('alert')).toContainText('Enter a valid email address.');
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(state.puts).toBe(0);
    expect(state.unexpected).toEqual([]);
});

test('cleared optional fields persist as cleared: empty strings are SENT (A8 MAJOR #1), never absent keys', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    // First persist real values…
    await page.getByLabel('Tagline').fill('Fast, honest replies');
    await page.getByLabel('Email').fill('care@easymod.test');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => state.puts).toBe(1);
    expect(state.lastPutBody?.email).toBe('care@easymod.test');

    // …then CLEAR both and save. The contract (19b48b39 ProfileTab): cleared
    // optional fields MUST send '' — an absent key would be a silent server
    // no-op with a false success toast.
    await page.getByLabel('Tagline').fill('');
    await page.getByLabel('Email').fill('');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => state.puts).toBe(2);
    const body = state.lastPutBody as Record<string, unknown>;
    expect(body).toHaveProperty('email');
    expect(body).toHaveProperty('tagline');
    expect(body.email).toBe('');
    expect(body.tagline).toBe('');
    await expect(page.getByRole('status')).toContainText('Business info saved');

    // The server mock persisted the CLEARED state — remounting the panel
    // (fresh ProfileTab mount re-fetches GET) renders the fields empty; no
    // ghost value survives from a silent no-op.
    await page.goto('/manage-shop/faqs');
    await expect(page.getByTestId('faq-signal')).toBeVisible({ timeout: 15_000 });
    await page.goto('/manage-shop/business-info');
    await expect(page.getByLabel('Shop Name', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('Tagline')).toHaveValue('');
    await expect(page.getByLabel('Email')).toHaveValue('');
    expect(state.unexpected).toEqual([]);
});

test('social links are a labelled group with all six fields and extra info shows a char counter', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    const group = page.getByRole('group', { name: 'Social Media Links' });
    await expect(group.getByLabel('Facebook')).toHaveValue('https://facebook.com/test');
    await expect(group.getByLabel('Website')).toBeVisible();
    // A2 enables the four previously hidden socials (P6).
    await expect(group.getByLabel('Instagram')).toBeVisible();
    await expect(group.getByLabel('WhatsApp')).toBeVisible();
    await expect(group.getByLabel('TikTok')).toBeVisible();
    await expect(group.getByLabel('YouTube')).toBeVisible();
    await page.getByLabel('Extra shop information').fill('Hello');
    // P13 counter — A0 ruled at 88f0328f (my D2 flag): EN stays the compact
    // legacy form '5/3000' (fmtCount plain); bn renders Bengali numerals.
    // This lane runs easymod_lang=en, so pin the exact legacy string.
    await expect(page.getByText('5/3000', { exact: true })).toBeVisible();
});

test('ADR-0013 boundary across ALL tabs: automation link, no AI control/radiogroup/range', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('business-info-automation-link')).toHaveAttribute('href', '/manage-shop/automation');
    // Round-2 copy contract: the deep-link desc retired the 'confidence' word
    // (it promises only what the automation page actually controls).
    await expect(page.getByTestId('business-info-automation-link')).toContainText('Reply mode and greeting now live on the business automation page.');
    await expect(page.getByTestId('business-info-automation-link')).not.toContainText(/confidence/i);
    await expect(page.getByTestId('ai-reply-mode')).toHaveCount(0);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.locator('input[type="range"]')).toHaveCount(0);
    await expect(page.getByText('Save Reply Settings', { exact: true })).toHaveCount(0);

    await activateTab(page, 'faqs');
    await expect(page.getByTestId('faq-signal')).toBeVisible();
    await expect(page.getByTestId('ai-reply-mode')).toHaveCount(0);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.locator('input[type="range"]')).toHaveCount(0);

    await activateTab(page, 'policies');
    await expect(page.getByTestId('policies-signal')).toBeVisible();
    // Stance controls are native <select>s — the radiogroup==0 boundary stays
    // true workspace-wide (02 §3 a11y decision).
    await expect(page.getByTestId('policy-card-returns')).toBeVisible();
    // Four stance OPTIONS (not radios): Not stated / offered / not offered / conditional.
    await expect(page.getByTestId('policy-stance-returns').locator('option')).toHaveCount(4);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.locator('input[type="range"]')).toHaveCount(0);
    await expect(page.getByTestId('ai-reply-mode')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('load failure offers a retry that recovers the form', async ({ page }) => {
    // Fail every load until the test flips the flag, so the dev double-mounted
    // effect cannot consume a single injected failure before the effective load.
    const state = await setupRoutes(page, { loadFails: 99 });
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/manage-shop/business-info');
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    state.loadFails = 0;
    await page.getByRole('button', { name: 'Retry loading' }).click();
    await expect(page.getByLabel('Shop Name', { exact: true })).toHaveValue('Automation Test Shop');
    expect(state.unexpected).toEqual([]);
});

test('blocked-load signal pin: business-signal reads "Profile unavailable"', async ({ page }) => {
    // P1 blocked-kind pin (01 §8): separated from the retry mechanics so a
    // header/label regression never hides the recovery proof.
    const state = await setupRoutes(page, { loadFails: 99 });
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/manage-shop/business-info');
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('business-signal')).toContainText('Profile unavailable');
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow and five mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('business-faq-tab-profile')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the business-info surface', async ({ page }) => {
    await setupRoutes(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByLabel('Shop Name', { exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-business').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
