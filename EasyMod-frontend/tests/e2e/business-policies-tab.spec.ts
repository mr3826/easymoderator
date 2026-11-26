/**
 * Business Policies tab proofs (Business & FAQ redesign, A6 battery). Mock
 * server mirrors the LIVE /api/shop/business-policies contract:
 * GET → { success, data: settings.policies or {} } (honest absence),
 * PUT (owner) → per-policy partial merge, NO defaults ever written, and —
 * per the A5b DELTA — unknown kinds/fields are REJECTED with 400
 * VALIDATION_ERROR. The mock enforces exactly that so invented client fields
 * fail here instead of being blessed.
 *
 * Pinned flows: four cards with stance semantics ("Not stated yet" distinct
 * from "We do not offer this"), populated stance/field rendering, empty GET
 * fabricates nothing, PUT carries ONLY edited kinds (no `{}` placeholders,
 * no untouched kinds), conditional requires details, server 400 surfaces as
 * role=alert without claiming success, informational-only disclosure,
 * non-owner read-only view (Y6), 360px reflow, axe on `.em-business`,
 * stance controls keep radiogroup==0 (ADR-0013 boundary), and — critically —
 * a policy save must NEVER touch order/refund enforcement surfaces (Y4: zero
 * automation; the mock allowlists only the contract endpoints so any invented
 * enforcement call aborts and lands in state.unexpected).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const ownerShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const staffShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'staff' };
const json = (data: unknown) => ({ success: true, data });

// Founder-shaped fixture: returns OFFERED with a window, refunds NOT OFFERED,
// exchange CONDITIONAL with conditions, warranty ABSENT (never stated).
const populated = {
    returns: { stance: 'offered', period_days: 7, details: 'Unworn items with tags.', exclusions: 'Innerwear and earrings.', process: null, duration: null, coverage: null, coverage_exclusions: null },
    refunds: { stance: 'not_offered', period_days: null, details: null, exclusions: null, process: null, duration: null, coverage: null, coverage_exclusions: null },
    exchange: { stance: 'conditional', period_days: null, details: 'Exchange only for size issues within 3 days.', exclusions: null, process: null, duration: null, coverage: null, coverage_exclusions: null },
    // warranty deliberately absent — the server never wrote it.
};

const POLICY_CONTRACT_KEYS = ['returns', 'exchange', 'refunds', 'warranty'];
const ENTRY_KEYS = ['stance', 'period_days', 'details', 'exclusions', 'process', 'duration', 'coverage', 'coverage_exclusions'];

async function setupRoutes(page: Page, options: { policies?: Record<string, unknown> | null; putFails?: boolean; role?: 'owner' | 'staff' } = {}) {
    const shop = options.role === 'staff' ? staffShop : ownerShop;
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        getCalls: 0,
        puts: 0,
        lastPutBody: null as Record<string, unknown> | null,
        // Deep copy so PUT merges mutate the fixture like settings.policies.
        policies: JSON.parse(JSON.stringify(options.policies ?? {})) as Record<string, unknown>,
    };
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known =
            ['/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
                '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
                '/api/shop/business-info', '/api/shop/business-policies', '/api/shop/list', '/api/shop/update',
                '/api/knowledge/faqs', '/api/knowledge/gap-suggestions', '/api/knowledge/faq/search',
                '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta']
                .includes(path) ||
            /^\/api\/knowledge\/faqs\/[\w-]+(\/(archive|restore|resync))?$/.test(path) ||
            /^\/api\/knowledge\/gap-suggestions\/[\w-]+\/(review|dismiss|publish)$/.test(path);
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
        }
        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 } } });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } } });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' } } });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return route.fulfill({ json: { success: true, data: { provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] } } });
        }
        if (path === '/api/channels/meta' && method === 'GET') return route.fulfill({ json: { success: true, data: [] } });
        if (path === '/api/csrf') return route.fulfill({ json: json({ csrfToken: 'csrf-test' }) });
        if (path === '/api/auth/me') {
            if (!state.signedIn) return route.fulfill({ status: 401, json: { success: false } });
            return route.fulfill({ json: json({ user: mockUser, currentShop: shop, allShops: [shop] }) });
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            state.signedIn = true;
            return route.fulfill({ json: json({ user: mockUser, currentShop: shop, allShops: [shop] }) });
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
            return route.fulfill({ json: json({ businessInfo: { shopName: shop.shop_name }, shop }) });
        }
        if (path === '/api/shop/list') return route.fulfill({ json: json([shop]) });
        if (path === '/api/knowledge/faqs' && method === 'GET') return route.fulfill({ json: json([]) });
        if (path === '/api/knowledge/gap-suggestions' && method === 'GET') {
            return route.fulfill({ status: 409, json: { success: false, error: { code: 'FEATURE_DISABLED' } } });
        }

        if (path === '/api/shop/business-policies' && method === 'GET') {
            state.getCalls += 1;
            return route.fulfill({ json: json(state.policies) }); // honest absence = {}
        }
        if (path === '/api/shop/business-policies' && method === 'PUT') {
            state.puts += 1;
            const body = request.postDataJSON() as Record<string, unknown>;
            state.lastPutBody = body;
            if (options.putFails) {
                return route.fulfill({ status: 400, json: { success: false, message: 'Policy body contains an unknown field.', code: 'VALIDATION_ERROR', requestId: 'req-e2e-1', timestamp: new Date().toISOString() } });
            }
            // LIVE validator mirror: unknown kinds / fields → 400 (A5b delta);
            // stance enum enforced; period_days only for returns/exchange.
            for (const [kind, entry] of Object.entries(body)) {
                if (!POLICY_CONTRACT_KEYS.includes(kind)) {
                    return route.fulfill({ status: 400, json: { success: false, message: `Unknown policy kind: ${kind}`, code: 'VALIDATION_ERROR' } });
                }
                if (entry === null) continue; // explicit null clears the kind
                for (const field of Object.keys(entry as Record<string, unknown>)) {
                    if (!ENTRY_KEYS.includes(field)) {
                        return route.fulfill({ status: 400, json: { success: false, message: `Unknown policy field: ${field}`, code: 'VALIDATION_ERROR' } });
                    }
                }
                const stance = (entry as Record<string, unknown>).stance;
                if (!['unspecified', 'offered', 'not_offered', 'conditional'].includes(String(stance))) {
                    return route.fulfill({ status: 400, json: { success: false, message: `Invalid policy stance: ${stance}`, code: 'VALIDATION_ERROR' } });
                }
            }
            // Per-policy partial merge (absent kinds untouched); no defaults.
            state.policies = { ...state.policies, ...body };
            return route.fulfill({ json: json({ policies: state.policies }) });
        }
        return route.fulfill({ json: json([]) });
    });
    return state;
}

async function loginAndOpenPolicies(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/manage-shop/business-info');
    await expect(page.getByTestId('business-faq-tab-profile')).toBeVisible();
    await page.getByTestId('business-faq-tab-policies').click();
    // Header-removal C6: the tab's signal band is gone — panel mount is the
    // gate; body assertions below auto-wait for the GET to settle.
    await expect(page.locator('#business-faq-panel-policies')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('four cards render stance semantics — absence is never "not offered"', async ({ page }) => {
    const state = await setupRoutes(page, { policies: populated });
    await loginAndOpenPolicies(page);
    await expect(page.getByRole('heading', { name: 'Business Policies', level: 1 })).toBeVisible();
    for (const kind of POLICY_CONTRACT_KEYS) {
        await expect(page.getByTestId(`policy-card-${kind}`)).toBeVisible();
    }
    await expect(page.getByTestId('policy-stance-returns')).toHaveValue('offered');
    await expect(page.getByTestId('policy-stance-refunds')).toHaveValue('not_offered');
    await expect(page.getByTestId('policy-stance-exchange')).toHaveValue('conditional');
    // WARRANTY ABSENT shows 'Not stated yet' as its selected stance — distinct
    // from refunds' selected 'We do not offer this'. Native <select> options
    // are not visible text nodes, so the semantic check is on the SELECTED
    // option's label per card (never value-only color coding).
    await expect(page.getByTestId('policy-stance-warranty')).toHaveValue('unspecified');
    const selectedLabel = async (kind: string) => page
        .getByTestId(`policy-stance-${kind}`)
        .evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '');
    expect(await selectedLabel('warranty')).toBe('Not stated yet');
    expect(await selectedLabel('refunds')).toBe('We do not offer this');
    expect(await selectedLabel('returns')).toBe('We offer this');
    expect(await selectedLabel('exchange')).toBe('Offered with conditions');
    // The two honesty labels exist as distinct options on every card, so the
    // merchant can always tell "absent" from "refused".
    const warrantyOptions = await page.getByTestId('policy-stance-warranty').locator('option').allTextContents();
    expect(warrantyOptions).toContain('Not stated yet');
    expect(warrantyOptions).toContain('We do not offer this');
    // Contextual fields per stance: returns shows the window, exchange shows
    // its conditions, not_offered/unspecified show no detail grid.
    await expect(page.getByTestId('policy-card-returns').getByLabel('Window (days)')).toHaveValue('7');
    await expect(page.getByTestId('policy-card-exchange').getByLabel('Details')).toHaveValue('Exchange only for size issues within 3 days.');
    // Honest server truth, relocated to the save footer: 3 of 4 stated (never
    // the draft form state). The signal band itself must NOT exist.
    await expect(page.getByTestId('policies-signal')).toHaveCount(0);
    await expect(page.getByTestId('policies-stated-count')).toContainText('Stated: 3/4');
    // Stance controls are native selects — the workspace-wide radiogroup==0
    // boundary stays honest (02 §3).
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.locator('input[type="range"]')).toHaveCount(0);
    // Informational-only disclosure (Y4) present in copy.
    await expect(page.getByText('They do not automatically approve or reject cancellations, refunds, exchanges or warranty claims.')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('empty GET fabricates nothing: all four Not stated, no defaults written, no PUT fired', async ({ page }) => {
    const state = await setupRoutes(page, { policies: {} });
    await loginAndOpenPolicies(page);
    for (const kind of POLICY_CONTRACT_KEYS) {
        await expect(page.getByTestId(`policy-stance-${kind}`)).toHaveValue('unspecified');
    }
    await expect(page.getByTestId('policies-stated-count')).toContainText('Stated: 0/4');
    await expect(page.getByText('Until you state them, replies will not guess these terms.')).toBeVisible();
    await expect(page.getByTestId('policies-save')).toBeDisabled();
    expect(state.puts).toBe(0);
    expect(state.unexpected).toEqual([]);
});

test('PUT carries ONLY edited kinds (no placeholders), merges server-side, and success is server-confirmed', async ({ page }) => {
    const state = await setupRoutes(page, { policies: populated });
    await loginAndOpenPolicies(page);
    // Edit refunds ONLY.
    await page.getByTestId('policy-stance-refunds').selectOption('offered');
    await expect(page.getByTestId('policies-unsaved')).toBeVisible();
    await page.getByTestId('policies-save').click();
    await expect.poll(() => state.puts).toBe(1);
    const body = state.lastPutBody as Record<string, unknown>;
    // Y3: untouched kinds are never sent — not even as `{}` or defaults.
    expect(Object.keys(body)).toEqual(['refunds']);
    const refundsEntry = body.refunds as Record<string, unknown>;
    expect(refundsEntry.stance).toBe('offered');
    expect(Object.keys(refundsEntry).sort()).toEqual(['details', 'exclusions', 'process', 'stance']); // refunds kind-scoped fields only
    expect(refundsEntry).not.toHaveProperty('period_days'); // rejected on refunds by the LIVE validator
    // Server merge preserved the other kinds (partial merge authority).
    expect(state.policies.returns).toBeTruthy();
    await expect(page.getByRole('status')).toContainText('Policies saved');
    expect(state.unexpected).toEqual([]);
});

test('conditional stance requires details before save is possible', async ({ page }) => {
    const state = await setupRoutes(page, { policies: populated });
    await loginAndOpenPolicies(page);
    await page.getByTestId('policy-stance-warranty').selectOption('conditional');
    await page.getByTestId('policies-save').click();
    await expect(page.getByText('Conditions are required when the position is conditional.')).toBeVisible();
    expect(state.puts).toBe(0);
    await page.getByTestId('policy-card-warranty').getByLabel('Details').fill('Manufacturer defects only.');
    await page.getByTestId('policies-save').click();
    await expect.poll(() => state.puts).toBe(1);
    const warranty = (state.lastPutBody as Record<string, unknown>).warranty as Record<string, unknown>;
    expect(warranty.details).toBe('Manufacturer defects only.');
    expect(state.unexpected).toEqual([]);
});

test('server validation 400 surfaces as an alert — no success claim, edits preserved', async ({ page }) => {
    const state = await setupRoutes(page, { policies: populated, putFails: true });
    await loginAndOpenPolicies(page);
    await page.getByTestId('policy-stance-exchange').selectOption('offered');
    await page.getByTestId('policies-save').click();
    await expect(page.getByRole('alert')).toContainText('Policy body contains an unknown field.');
    await expect(page.getByRole('status')).toHaveCount(0);
    // §12 preserve on failure: the edit stays in the form.
    await expect(page.getByTestId('policy-stance-exchange')).toHaveValue('offered');
    expect(state.unexpected).toEqual([]);
});

test('non-owner sees read-only values + owner note; no PUT affordance exists', async ({ page }) => {
    const state = await setupRoutes(page, { policies: populated, role: 'staff' });
    await loginAndOpenPolicies(page);
    await expect(page.getByRole('note')).toContainText('Only the shop owner can change these policies.');
    await expect(page.getByTestId('policies-save')).toHaveCount(0);
    await expect(page.getByTestId('policy-stance-returns')).toBeDisabled();
    // Values are still GET-able for members.
    await expect(page.getByTestId('policy-stance-returns')).toHaveValue('offered');
    expect(state.getCalls).toBeGreaterThanOrEqual(1);
    expect(state.puts).toBe(0);
    expect(state.unexpected).toEqual([]);
});

test('policies are INFORMATIONAL ONLY — saving never touches any enforcement endpoint', async ({ page }) => {
    const state = await setupRoutes(page, { policies: {} });
    await loginAndOpenPolicies(page);
    await page.getByTestId('policy-stance-returns').selectOption('not_offered');
    await page.getByTestId('policies-save').click();
    await expect.poll(() => state.puts).toBe(1);
    // The only writes observed are the contract's own route. Any call to an
    // order/refund/cancel surface would land in state.unexpected (aborted).
    expect(state.unexpected).toEqual([]);
});

test('360px policies tab: cards, selects and the long disclosure line reflow without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const state = await setupRoutes(page, {
        policies: {
            returns: { stance: 'conditional', period_days: 365, details: 'Only unworn, original packaging with the invoice, and the exchange must be requested within the stated window after delivery confirmation.', exclusions: 'Perishables, innerwear, customized stitched items, and anything discounted more than fifty percent.' },
        },
    });
    await loginAndOpenPolicies(page);
    await expect(page.getByTestId('policy-card-returns')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByTestId('policies-save').scrollIntoViewIfNeeded();
    const overflowSave = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowSave).toBeLessThanOrEqual(0);
    expect(state.unexpected).toEqual([]);
});

test('390px: policies tab fits with five mobile destinations and no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await setupRoutes(page, { policies: populated });
    await loginAndOpenPolicies(page);
    await expect(page.getByTestId('policies-stated-count')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(state.unexpected).toEqual([]);
});

test('axe: no critical or serious violations across the policies surface', async ({ page }) => {
    const state = await setupRoutes(page, { policies: populated });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndOpenPolicies(page);
    await expect(page.getByTestId('policies-stated-count')).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-business').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
    expect(state.unexpected).toEqual([]);
});
