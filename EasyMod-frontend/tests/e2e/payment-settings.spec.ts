/**
 * Payment Settings — Playwright system tests (mock-only), MIGRATED to the
 * redesigned workspace wire shape (contract §8.3; A0 integration 2026-11-26).
 *
 * Intent carried from the legacy suite, re-expressed:
 *  - The page loads with COD + bKash — and NOW Nagad + Rocket render with
 *    proper labels (the §1.1 Rocket-label gap is fixed by the canonical
 *    taxonomy; asserting all four providers is the strengthened form).
 *  - "reload hydrates from credential_summary" (secrets never returned):
 *    same contract on the new accounts endpoint; the drawer proves it.
 *  - "save bKash self-MFS calls test then save": replaced per the spec-audit
 *    ruling — validation is SERVER-side (validate-then-persist inside
 *    POST /api/payment/accounts); the causal property is pinned in
 *    payment-guardrails.spec.ts (client-block + server-400 bypass).
 *  - The advance-radio state machine survives, now against
 *    PUT /api/payment/policy instead of the dropped /shop/update blob.
 *
 * Merchant API mode stays presentation-only: no provider endpoint is ever
 * contacted by the settings surface itself (§2.1 "nothing implicit").
 */

import { expect, test, type Page, type Route } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const BD = /^01[3-9]\d{8}$/;

function jsonResponse(data: unknown, status = 200) {
    return {
        status,
        contentType: 'application/json',
        body: JSON.stringify({ success: status < 400, data }),
    };
}

interface Row {
    id: string; shop_id: string; provider: string; account_type: string; gateway: string | null;
    is_enabled: boolean; is_preferred: boolean; verification_level: string; automated_checkout_active: boolean;
    provider_notice?: unknown; config: Record<string, unknown>;
    credential_summary?: { has_credentials: boolean; mfs_type: string | null; mfs_mode: string | null; mfs_number: string | null };
}

const selfRow: Row = {
    id: 'acc-self-1', shop_id: 'shop-1', provider: 'bkash', account_type: 'self', gateway: 'self-mfs',
    is_enabled: true, is_preferred: true, verification_level: 'configured_unverified', automated_checkout_active: false,
    provider_notice: null, config: {},
    credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' },
};

async function setupRoutes(page: Page, options: { rows?: Row[] } = {}) {
    let authenticated = false;
    let nonce = 0;
    const state = {
        rows: options.rows ?? [],
        policy: { advance_policy: 'none', advance_value: null, payment_message: '' } as Record<string, unknown>,
        posts: [] as Record<string, unknown>[],
        patches: [] as { id: string; body: Record<string, unknown> }[],
        deletes: [] as string[],
        policyPuts: [] as Record<string, unknown>[],
        providerTouches: 0,
    };

    await page.route((url) => new URL(url).pathname.startsWith('/api/'), async (route: Route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        const method = route.request().method();
        const req = route.request();

        if (path === '/api/csrf') return route.fulfill(jsonResponse({ csrfToken: 'csrf-test' }));
        if (path === '/api/auth/signin' && method === 'POST') {
            authenticated = true;
            return route.fulfill(jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }));
        }
        if (path === '/api/auth/me') {
            return route.fulfill(authenticated
                ? jsonResponse({ user: mockUser, currentShop: mockShop, allShops: [mockShop] })
                : jsonResponse({}, 401));
        }
        if (path === '/api/setup/status') return route.fulfill(jsonResponse({ complete: true }));
        if (path.startsWith('/api/subscription')) return route.fulfill(jsonResponse({ plan_code: 'SHURU', plan_name: 'Shuru', features: {} }));
        if (path === '/api/notifications/in-app') return route.fulfill(jsonResponse([]));
        if (path === '/api/shop/me') return route.fulfill(jsonResponse({ ...mockShop, settings: {} }));
        if (path === '/api/order/counts') return route.fulfill(jsonResponse({ to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 }));
        if (path === '/api/conversation/needs-reply-count') return route.fulfill(jsonResponse({ count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' }));
        if (path === '/api/product/stock-exceptions') return route.fulfill(jsonResponse({ outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' }));
        if (path === '/api/shop/delivery/readiness') return route.fulfill(jsonResponse({ provider: null, ready: false, status: 'SETUP_INCOMPLETE', providers: [], missing: ['provider_not_connected'] }));
        if (path === '/api/channels/meta') return route.fulfill(jsonResponse([]));

        if (path === '/api/payment/accounts' && method === 'GET') {
            return route.fulfill(jsonResponse(state.rows.map((r) => { const v = { ...r } as Record<string, unknown>; delete v._secrets; return v; })));
        }
        if (path === '/api/payment/accounts' && method === 'POST') {
            const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
            state.posts.push(body);
            const provider = String(body.provider ?? '');
            const accountType = String(body.account_type ?? '');
            const creds = body.credentials as Record<string, unknown> | undefined;
            if (provider !== 'cod' && creds && accountType !== 'merchant_gateway'
                && (creds.mfs_type !== provider || !BD.test(String(creds.mfs_number ?? '')))) {
                return route.fulfill(jsonResponse({ message: 'validation failed' }, 400));
            }
            const row: Row & { _secrets?: unknown } = {
                id: `acc-${provider}-${accountType}-${++nonce}`, shop_id: 'shop-1', provider, account_type: accountType,
                gateway: provider === 'cod' ? 'cod' : 'self-mfs',
                is_enabled: Boolean(body.is_enabled), is_preferred: false,
                verification_level: body.is_enabled && provider !== 'cod' ? 'configured_unverified' : 'unverified',
                automated_checkout_active: false,
                provider_notice: provider === 'nagad' || provider === 'rocket' ? { en: 'x', bn: 'x' } : null,
                config: (body.config as Record<string, unknown>) ?? {},
                credential_summary: creds && accountType !== 'merchant_gateway'
                    ? { has_credentials: true, mfs_type: String(creds.mfs_type), mfs_mode: String(creds.mfs_mode ?? 'self'), mfs_number: String(creds.mfs_number ?? '') }
                    : { has_credentials: Boolean(creds), mfs_type: creds ? provider : null, mfs_mode: creds ? 'business' : null, mfs_number: null },
                _secrets: creds && accountType === 'merchant_gateway' ? creds : undefined,
            };
            state.rows.push(row);
            const view = { ...row } as Record<string, unknown>;
            delete view._secrets; // secrets never cross the wire, even in mocks
            return route.fulfill(jsonResponse(view));
        }
        const one = path.match(/^\/api\/payment\/accounts\/([\w-]+)(\/verify-credentials|\/certify-live)?$/);
        if (one) {
            const id = one[1];
            if (one[2]) state.providerTouches += 1; // settings tab NEVER triggers this during load — asserted elsewhere
            if (method === 'DELETE') {
                state.deletes.push(id);
                state.rows = state.rows.filter((r) => r.id !== id);
                return route.fulfill(jsonResponse({ message: 'deleted' }));
            }
            if (method === 'PATCH') {
                const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
                state.patches.push({ id, body });
                const row = state.rows.find((r) => r.id === id);
                if (!row) return route.fulfill(jsonResponse({}, 404));
                if (body.is_enabled !== undefined) row.is_enabled = Boolean(body.is_enabled);
                return route.fulfill(jsonResponse(row));
            }
        }
        if (path === '/api/payment/policy') {
            if (method === 'GET') return route.fulfill(jsonResponse(state.policy));
            const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
            state.policyPuts.push(body);
            state.policy = { ...body };
            return route.fulfill(jsonResponse({ ...body, updated_at: new Date().toISOString(), updated_by: 'user-1' }));
        }
        return route.fulfill(jsonResponse({}));
    });
    return state;
}

async function loginAndGo(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill(mockUser.email);
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/(dashboard|inbox)$/);
    await page.goto('/manage-shop/payment-settings');
    // Wait for the Suspense-loaded workspace component to mount
    await expect(page.getByRole('heading', { name: 'Payment Settings' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('method-row-cod')).toBeVisible({ timeout: 15_000 });
}

test('payment settings page loads all four providers (Rocket label gap fixed by the canonical taxonomy)', async ({ page }) => {
    await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByTestId('method-row-cod')).toBeVisible();
    for (const p of ['bkash', 'nagad', 'rocket']) {
        await expect(page.getByTestId(`method-row-${p}`)).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Cash on Delivery' })).toBeVisible();
});

test('reload hydrates the saved receiver number from credential_summary — and the list response carries NO credentials', async ({ page }) => {
    await setupRoutes(page, { rows: [selfRow] });
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();
    await page.getByTestId(`manage-${selfRow.id}`).click();
    // BDPhoneInput DISPLAYS a grouped format; the underlying stored digits are
    // what matters — compare digit-only (the hydration intent).
    const shown = await page.locator('#drawer-wallet-number').inputValue();
    expect(shown.replace(/\D/g, '')).toBe('01711000000');
    // Secrets-never-returned contract (§8.1 serialization pin, now on /accounts):
    const raw = await page.evaluate(async () => await (await fetch('/api/payment/accounts')).text());
    const parsed = JSON.parse(raw);
    const row = parsed.data.find((r: { id: string }) => r.id === selfRow.id);
    expect(row.credential_summary.mfs_number).toBe('01711000000');
    expect(row).not.toHaveProperty('credentials');
    expect(raw).not.toContain('"credentials":');
});

test('gateway secret inputs start BLANK in edit mode and never round-trip through the list', async ({ page }) => {
    const gw: Row = {
        id: 'acc-gw-9', shop_id: 'shop-1', provider: 'bkash', account_type: 'merchant_gateway', gateway: 'self-mfs',
        is_enabled: true, is_preferred: false, verification_level: 'configured_unverified', automated_checkout_active: false,
        provider_notice: null, config: { environment: 'sandbox' },
        credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null },
    };
    await setupRoutes(page, { rows: [gw] });
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();
    await page.getByTestId('manage-acc-gw-9').click();
    await expect(page.getByTestId('gateway-app-key')).toHaveValue('');
    await expect(page.getByTestId('gateway-app-secret')).toHaveValue('');
    await expect(page.getByTestId('gateway-username')).toHaveValue('');
    // Environment persists from config (A0 ruling: sandbox selection is real)
    await expect(page.getByTestId('account-drawer').getByRole('checkbox', { name: /sandbox/i })).toBeChecked();
});

test('save self-MFS wallet persists via POST /api/payment/accounts with canonical provider vocabulary', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();
    await page.getByTestId('add-account-bkash').click();
    await page.locator('#drawer-wallet-number').fill('01711000000');
    await page.getByTestId('drawer-enable-checkbox').check();
    await page.getByTestId('account-drawer-save').click();
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0]).toMatchObject({
        provider: 'bkash',
        account_type: 'self',
        is_enabled: true,
        credentials: { mfs_type: 'bkash', mfs_number: '01711000000' },
    });
    // legacy config POST must NOT have been used (allowlisted nowhere → would abort)
    await expect(page.getByTestId('account-card-acc-bkash-self-1')).toBeVisible();
});

test('advance radio state machine drives the policies endpoint (no /shop/update blob)', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await page.getByTestId('payment-tab-policies').click();
    await expect(page.locator('input[name="advance-policy"][value="none"]')).toBeChecked();
    await page.locator('input[name="advance-policy"][value="full"]').check();
    await expect(page.getByTestId('advance-percentage-input')).toHaveCount(0);
    await page.locator('input[name="advance-policy"][value="percentage"]').check();
    await expect(page.getByTestId('advance-percentage-input')).toBeVisible();
    await page.getByTestId('advance-percentage-input').fill('30');
    await page.getByTestId('policy-save').click();
    await expect.poll(() => state.policyPuts.length).toBe(1);
    expect(state.policyPuts[0]).toEqual({ advance_policy: 'percentage', advance_value: 30, payment_message: '' });
});

test('per-account delete sits behind a danger confirm and hits DELETE /api/payment/accounts/:id', async ({ page }) => {
    const state = await setupRoutes(page, { rows: [selfRow] });
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();
    await page.getByTestId(`delete-${selfRow.id}`).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(state.deletes).toEqual([]);
    await page.getByTestId('confirm-delete-account').click();
    await expect.poll(() => state.deletes).toEqual([selfRow.id]);
    await expect(page.getByTestId(`account-card-${selfRow.id}`)).toHaveCount(0);
});
