/**
 * Payment-settings guardrails proof (mock-only, CI subset) — MIGRATED to the
 * redesigned two-tab workspace (docs/payment-redesign/00_PAYMENT_DATA_CONTRACT.md
 * §8.3; A0 integration 2026-11-26). Every legacy intent survives, re-expressed
 * against the canonical wire shape (payment_accounts API + /api/payment/policy):
 *
 *  - Allowlist+abort discipline (ADR boundary): invented backend calls fail CI.
 *    The legacy `/api/payment/config*`, `/api/shop/update` and the
 *    `platform-priority['bkash','cod']` PUT are DELIBERATELY not allowlisted
 *    any more — their reappearance from this surface is now a test failure
 *    (D-8: preference moved to payment_accounts.is_preferred; §5: policy moved
 *    to PATCH/PUT /api/payment/policy; §1.4: the settings tab is on the
 *    canonical account API, the legacy routes stay only for old consumers).
 *  - Slim header (header-removal C1/C6): compact title ONLY, NO signal band
 *    (generic [data-testid$="-signal"] must be absent in .em-payment), NO CTA.
 *    The contextual facts (enabled-methods count, preferred account) render
 *    INSIDE the methods tab body and stay pinned there.
 *  - Test-before-save intent (spec-audit ruling #5): the CAUSAL property is
 *    asserted — a credential that fails validation is never persisted — both
 *    client-side (drawer blocks + no request fires) and server-side (a mocked
 *    bypass gets 400 and the store stays clean). The old literal
 *    test-then-save call-order assertion is retired on purpose: the redesign
 *    validates-then-persists inside the save endpoint (§7 row 1).
 *  - Honesty (R-12, REQUIRED now): the 'format_validated' verdict and the
 *    'not verified with bKash' chip copy must render; the forbidden
 *    'Automated checkout via official merchant API' string must never appear.
 *  - Switch gating behind saved credentials (§7 row 3) keeps its semantics.
 *  - 390px reflow + axe on `.em-payment` (the scope class now lives ONLY at
 *    the workspace root — the tabs must not re-wrap it).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });
const BD = /^01[3-9]\d{8}$/;

interface Acct {
    id: string;
    shop_id: string;
    provider: string | null;
    account_type: string | null;
    gateway: string | null;
    is_enabled: boolean;
    is_preferred: boolean;
    verification_level: string;
    automated_checkout_active: boolean;
    provider_notice?: { en: string; bn: string } | null;
    config: Record<string, unknown>;
    credential_summary?: { has_credentials: boolean; mfs_type: string | null; mfs_mode: string | null; mfs_number: string | null };
    _secrets?: Record<string, string> | null;
}

const WALLET_ONLY_NOTICE = {
    en: 'Official automated verification is not available for Nagad/Rocket. Payments to these numbers are confirmed by you (the merchant), never automatically.',
    bn: 'নাগদ/রকেটের জন্য অফিসিয়াল স্বয়ংক্রিয় যাচাই নেই।',
};

function accountView(a: Acct) {
    // The wire shape NEVER carries decrypted credentials — only the summary
    // (§8.1 serialization pin). _secrets stays in the mock "database" only.
    const v = { ...a } as Record<string, unknown>;
    delete v._secrets;
    return v;
}

function baseAccount(over: Partial<Acct> & { id: string; provider: string; account_type: string }): Acct {
    return {
        shop_id: 'shop-1',
        gateway: over.provider === 'cod' ? 'cod' : 'self-mfs',
        is_enabled: false,
        is_preferred: false,
        verification_level: 'unverified',
        automated_checkout_active: false,
        provider_notice: over.provider === 'nagad' || over.provider === 'rocket' ? WALLET_ONLY_NOTICE : null,
        config: {},
        credential_summary: { has_credentials: false, mfs_type: null, mfs_mode: null, mfs_number: null },
        _secrets: null,
        ...over,
    } as Acct;
}

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/shop/me',
    // canonical redesign surface (A5 routes):
    '/api/payment/accounts', '/api/payment/policy',
    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
    /^\/api\/payment\/accounts\/[\w-]+$/,
    /^\/api\/payment\/accounts\/[\w-]+\/preferred$/,
    /^\/api\/payment\/accounts\/[\w-]+\/verify-credentials$/,
    /^\/api\/payment\/accounts\/[\w-]+\/certify-live$/,
];

async function setupRoutes(page: Page, options: { accounts?: Acct[]; policy?: Record<string, unknown> } = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        accounts: options.accounts ?? [],
        policy: options.policy ?? { advance_policy: 'none', advance_value: null, payment_message: '' },
        accountPosts: [] as Record<string, unknown>[],
        accountPatches: [] as { id: string; body: Record<string, unknown> }[],
        preferredPuts: [] as string[],
        verifyPosts: [] as string[],
        certifyPosts: [] as { id: string; body: unknown }[],
        policyPuts: [] as Record<string, unknown>[],
        priorityPuts: 0,
        shopUpdates: 0,
    };
    const find = (id: string) => state.accounts.find((a) => a.id === id);

    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            if (path === '/api/shop/platform-priority' && method === 'PUT') state.priorityPuts += 1;
            if (path === '/api/shop/update') state.shopUpdates += 1;
            return route.abort();
        }
        if (path === '/api/shop/platform-priority' && method === 'PUT') state.priorityPuts += 1;
        if (path === '/api/shop/update') state.shopUpdates += 1;

        if (path === '/api/order/counts' && method === 'GET') {
            return route.fulfill({ json: json({ to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 }) });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return route.fulfill({ json: json({ count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' }) });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return route.fulfill({ json: json({ outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' }) });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return route.fulfill({ json: json({ provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] }) });
        }
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
        if (path === '/api/commercial/claims') {
            return route.fulfill({ json: json({ surface: url.searchParams.get('surface') ?? 'usage-banner', locale: 'en', contractVersion: '1.0.0', decisions: [] }) });
        }
        if (path === '/api/public/commercial-contract') {
            return route.fulfill({ json: json({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` }) });
        }
        if (path === '/api/notifications/in-app') return route.fulfill({ json: json([]) });
        if (path === '/api/shop/me') return route.fulfill({ json: json({ ...mockShop, settings: {} }) });

        // ── canonical accounts API ────────────────────────────────────────────
        if (path === '/api/payment/accounts' && method === 'GET') {
            return route.fulfill({ json: json(state.accounts.map(accountView)) });
        }
        if (path === '/api/payment/accounts' && method === 'POST') {
            const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
            state.accountPosts.push(body);
            const provider = String(body.provider ?? '');
            const accountType = String(body.account_type ?? '');
            const creds = body.credentials as Record<string, unknown> | undefined;
            // server-side validate-then-persist (§7 row 1 / ruling #5):
            if (provider !== 'cod' && creds) {
                if (accountType === 'merchant_gateway') {
                    if (!creds.app_key || !creds.app_secret || !creds.username) {
                        return route.fulfill({ status: 400, json: { success: false, message: 'bKash merchant_gateway credentials require app_key, app_secret and username' } });
                    }
                } else {
                    if (creds.mfs_type !== provider || !BD.test(String(creds.mfs_number ?? ''))) {
                        return route.fulfill({ status: 400, json: { success: false, message: 'Wallet number fails BD format validation — nothing was saved.' } });
                    }
                }
            }
            if (body.is_enabled === true && provider !== 'cod' && !creds) {
                return route.fulfill({ status: 400, json: { success: false, message: 'Wallet credentials are required to enable this account' } });
            }
            const existing = state.accounts.find((a) => a.provider === provider && a.account_type === accountType);
            if (existing) {
                Object.assign(existing, {
                    is_enabled: Boolean(body.is_enabled),
                    verification_level: body.is_enabled ? 'configured_unverified' : existing.verification_level,
                });
                if (creds && provider !== 'cod') {
                    if (accountType === 'merchant_gateway') existing._secrets = creds as Record<string, string>;
                    else existing.credential_summary = { has_credentials: true, mfs_type: String(creds.mfs_type ?? provider), mfs_mode: String(creds.mfs_mode ?? 'self'), mfs_number: String(creds.mfs_number ?? null) };
                }
                return route.fulfill({ json: json(accountView(existing)) });
            }
            const created = baseAccount({
                id: `acc-${provider}-${accountType}-${state.accounts.length}`,
                provider,
                account_type: accountType,
                is_enabled: Boolean(body.is_enabled),
                verification_level: body.is_enabled && provider !== 'cod' ? 'configured_unverified' : 'unverified',
                config: (body.config as Record<string, unknown>) ?? {},
                credential_summary: creds && provider !== 'cod' && accountType !== 'merchant_gateway'
                    ? { has_credentials: true, mfs_type: String(creds.mfs_type ?? provider), mfs_mode: String(creds.mfs_mode ?? 'self'), mfs_number: String(creds.mfs_number ?? null) }
                    : creds ? { has_credentials: true, mfs_type: provider, mfs_mode: 'business', mfs_number: null } : undefined,
                _secrets: creds && accountType === 'merchant_gateway' ? (creds as Record<string, string>) : null,
            });
            state.accounts.push(created);
            return route.fulfill({ json: json(accountView(created)) });
        }
        const acctMatch = path.match(/^\/api\/payment\/accounts\/([\w-]+)(\/(preferred|verify-credentials|certify-live))?$/);
        if (acctMatch) {
            const id = acctMatch[1];
            const action = acctMatch[3];
            const acct = find(id);
            if (!acct && action !== undefined) return route.fulfill({ status: 404, json: { success: false, message: 'Payment account not found' } });
            if (!action && method === 'PATCH') {
                const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
                state.accountPatches.push({ id, body });
                const creds = body.credentials as Record<string, unknown> | undefined;
                if (body.is_enabled === true && acct && acct.provider !== 'cod'
                    && !acct.credential_summary?.has_credentials && !creds) {
                    return route.fulfill({ status: 400, json: { success: false, message: 'Cannot enable a wallet account without credentials' } });
                }
                if (body.is_enabled !== undefined && acct) acct.is_enabled = Boolean(body.is_enabled);
                if (body.config !== undefined && acct) acct.config = body.config as Record<string, unknown>;
                if (creds && acct) {
                    const gw = acct.account_type === 'merchant_gateway';
                    const changed = gw ? true : String(creds.mfs_number ?? '') !== String(acct.credential_summary?.mfs_number ?? '');
                    if (gw) acct._secrets = creds as Record<string, string>;
                    else acct.credential_summary = { has_credentials: true, mfs_type: String(creds.mfs_type ?? acct.provider), mfs_mode: String(creds.mfs_mode ?? 'self'), mfs_number: String(creds.mfs_number ?? null) };
                    if (changed) acct.verification_level = 'unverified'; // §2 credential-change demotion
                }
                return route.fulfill({ json: json(acct ? accountView(acct) : null) });
            }
            if (!action && method === 'DELETE') {
                state.accounts = state.accounts.filter((a) => a.id !== id);
                return route.fulfill({ json: { success: true, message: 'Payment account deleted' } });
            }
            if (action === 'preferred' && method === 'PUT') {
                state.preferredPuts.push(id);
                const target = find(id);
                if (!target) return route.fulfill({ status: 404, json: { success: false } });
                if (!target.is_enabled) {
                    return route.fulfill({ status: 409, json: { success: false, code: 'PREFERRED_ACCOUNT_DISABLED', message: 'Only an enabled account can be set as preferred' } });
                }
                // DB truth: clear-all-then-elect, exactly one per shop (D-8).
                for (const a of state.accounts) a.is_preferred = a.id === id;
                return route.fulfill({ json: { success: true, preferred_account_id: id } });
            }
            if (action === 'verify-credentials' && method === 'POST') {
                state.verifyPosts.push(id);
                const a = find(id)!;
                // NOTE the top-level spread: the real controller answers
                // `{ success: true, ...result }` — message sits at the TOP of the
                // envelope, and the drawer renders exactly that.
                if (a.provider === 'nagad' || a.provider === 'rocket') {
                    return route.fulfill({ json: { success: true, status: 'verification_unavailable', provider_contact: false, verification_level: a.verification_level, message: WALLET_ONLY_NOTICE.en, provider_notice: WALLET_ONLY_NOTICE } });
                }
                if (a.account_type === 'merchant_gateway') {
                    return route.fulfill({ json: { success: true, status: 'automation_disabled', provider_contact: false, verification_level: a.verification_level, environment: String(a.config.environment ?? 'sandbox'), message: 'Provider credential checks are disabled in this deployment (BKASH_ENABLED is not "true"); credentials were validated locally only.' } });
                }
                const ok = BD.test(String(a.credential_summary?.mfs_number ?? ''));
                return route.fulfill({ json: { success: true, status: ok ? 'format_validated' : 'format_invalid', provider_contact: false, verification_level: a.verification_level, message: ok ? 'Number format validated — not a provider check' : 'Wallet number does not match the expected BD format — nothing was sent to the provider.' } });
            }
            if (action === 'certify-live' && method === 'POST') {
                state.certifyPosts.push({ id, body: request.postDataJSON() });
                const a = find(id)!;
                // Mirrors the R-17 server contract (payment-verification.service.js): certify
                // requires EXPLICIT production environment + a certifiable rung. The old
                // sandbox_verified-prerequisite rule was removed and must not live in mocks.
                const CERTIFIABLE = ['unverified', 'configured_unverified', 'sandbox_verified'];
                if (a.config?.environment !== 'production') {
                    const msg = a.config?.environment === 'sandbox'
                        ? 'This account is recorded as a SANDBOX environment — live certification describes production posture. Switch the account to production (this demotes the ladder) and certify with production evidence.'
                        : 'The account environment is not explicitly recorded as "production" (legacy rows must be re-saved with config.environment="production" before they can be live-certified). Nothing was recorded.';
                    return route.fulfill({ status: 400, json: { success: false, code: 'PROVIDER_ENVIRONMENT_NOT_PRODUCTION', message: msg } });
                }
                if (!CERTIFIABLE.includes(String(a.verification_level))) {
                    return route.fulfill({ status: 409, json: { success: false, code: 'LADDER_STATE_NOT_CERTIFIABLE', message: `Verification level "${a.verification_level}" is not certifiable` } });
                }
                a.verification_level = 'live_certified';
                return route.fulfill({ json: { success: true, verification_level: 'live_certified', message: 'Live certification recorded against owner evidence and audit. Automated checkout additionally remains gated on BKASH_ENABLED.' } });
            }
        }

        // ── policies API (§5.2 / R-14 one PUT pair) ────────────────────────────
        if (path === '/api/payment/policy') {
            if (method === 'GET') return route.fulfill({ json: json(state.policy) });
            if (method === 'PUT' || method === 'PATCH') {
                const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
                state.policyPuts.push(body);
                const p = String(body.advance_policy ?? '');
                const v = body.advance_value;
                if (!['none', 'full', 'delivery_charge', 'percentage', 'fixed'].includes(p)) {
                    return route.fulfill({ status: 400, json: { success: false, message: 'advance_policy must be one of: none, full, delivery_charge, percentage, fixed' } });
                }
                if (p === 'percentage' && (typeof v !== 'number' || v < 1 || v > 99)) {
                    return route.fulfill({ status: 400, json: { success: false, message: 'advance_value must be a whole number from 1 to 99 for percentage' } });
                }
                if (p === 'fixed' && (typeof v !== 'number' || v < 1 || v > 100000)) {
                    return route.fulfill({ status: 400, json: { success: false, message: 'advance_value must be a whole taka amount from 1 to 100000 for fixed' } });
                }
                if (['none', 'full', 'delivery_charge'].includes(p) && v !== null) {
                    return route.fulfill({ status: 400, json: { success: false, message: 'This rule has no advance amount' } });
                }
                if (typeof body.payment_message === 'string' && body.payment_message.length > 500) {
                    return route.fulfill({ status: 400, json: { success: false, message: 'payment_message exceeds 500 characters' } });
                }
                state.policy = { advance_policy: p, advance_value: ['none', 'full', 'delivery_charge'].includes(p) ? null : v, payment_message: String(body.payment_message ?? '') };
                return route.fulfill({ json: json({ ...state.policy, updated_at: new Date().toISOString(), updated_by: 'user-1' }) });
            }
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
    await page.goto('/manage-shop/payment-settings');
    // Header-removal C6: the signal band is gone, so the mounted methods tab is
    // the readiness anchor — and NO generic *-signal testid may exist in scope.
    await expect(page.getByTestId('payment-tab-methods')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.em-payment [data-testid$="-signal"]')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

const bkashSelfEnabled = baseAccount({
    id: 'acc-bkash-self-1', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: true,
    verification_level: 'configured_unverified',
    credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' },
});
const codEnabled = baseAccount({ id: 'acc-cod-1', provider: 'cod', account_type: 'standard', is_enabled: true, verification_level: 'live_certified' });

test('slim header: compact title, NO signal band, no header CTA; facts relocated into content', async ({ page }) => {
    const state = await setupRoutes(page, { accounts: [codEnabled, bkashSelfEnabled] });
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Payment Settings', exact: true })).toBeVisible();
    // C6 absence pins (the removal itself is what we test):
    await expect(page.locator('.em-payment [data-testid$="-signal"]')).toHaveCount(0);
    await expect(page.getByText('Accepting payments')).toHaveCount(0); // deleted signal.* keys must not resurrect
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    // The contextual facts survive — inside the methods tab body, not a band.
    await expect(page.getByText(/Enabled methods:/)).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('wallet save validates before persisting; an invalid number never reaches the store (causal test-before-save)', async ({ page }) => {
    const state = await setupRoutes(page, { accounts: [codEnabled] });
    await loginAndGo(page);
    // Add a Nagad account — drawer client validation blocks first…
    // (panel expanded up front so the saved card lands in the open list)
    await page.getByTestId('expand-nagad').click();
    await page.getByTestId('add-account-nagad').click();
    await expect(page.getByTestId('account-drawer')).toBeVisible();
    const numberInput = page.locator('#drawer-wallet-number');
    await numberInput.fill('017');
    await page.getByTestId('account-drawer-save').click();
    await expect(page.locator('#drawer-wallet-number-error')).toBeVisible();
    expect(state.accountPosts.length).toBe(0); // client blocked: no request at all
    // …then a valid number saves (the server validates again before persist —
    // see the direct-bypass assertion in payment-verification.spec.ts).
    await numberInput.fill('01711223344');
    await page.getByTestId('account-drawer-save').click();
    await expect.poll(() => state.accountPosts.length).toBe(1);
    const post = state.accountPosts[0];
    expect(post.provider).toBe('nagad');
    expect((post.credentials as { mfs_type: string; mfs_number: string }).mfs_type).toBe('nagad');
    expect((post.credentials as { mfs_number: string }).mfs_number).toBe('01711223344');
    await expect(page.getByTestId('account-card-' + state.accounts[state.accounts.length - 1].id)).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('honesty REQUIRED: the format_validated verdict is surfaced verbatim, the provider is never contacted on load', async ({ page }) => {
    const state = await setupRoutes(page, { accounts: [codEnabled, bkashSelfEnabled] });
    await loginAndGo(page);
    // Zero provider-touching calls happened just by opening the settings tab (§2.1 "nothing implicit").
    expect(state.verifyPosts).toEqual([]);
    expect(state.certifyPosts).toEqual([]);
    // Wallet number: explicit "Validate format" → honest format verdict copy.
    await page.getByTestId('expand-bkash').click();
    await page.getByTestId(`manage-${bkashSelfEnabled.id}`).click();
    await page.getByTestId('drawer-validate-format').click();
    await expect(page.getByText('Number format validated — not a provider check')).toBeVisible();
    // The chip copy (founder-visible max status) must be exactly the R-12 sentence.
    // Scoped to the CARD (the drawer renders the same chip for the account it edits).
    await expect(page.getByTestId(`account-card-${bkashSelfEnabled.id}`).getByTestId('verification-honesty'))
        .toContainText('Credentials validated (format) — not verified with bKash');
    expect(state.unexpected).toEqual([]);
});

test('non-COD activation is gated behind saved credentials (§7 row 3)', async ({ page }) => {
    const credless = baseAccount({ id: 'acc-rocket-self-x', provider: 'rocket', account_type: 'self', is_enabled: false });
    const state = await setupRoutes(page, { accounts: [credless, codEnabled] });
    await loginAndGo(page);
    await page.getByTestId('expand-rocket').click();
    await expect(page.getByTestId(`account-card-${credless.id}`).getByRole('switch')).toBeDisabled();
    await expect(page.locator('[data-testid="method-row-cod"]').getByRole('switch')).toBeEnabled();
    expect(state.unexpected).toEqual([]);
});

test('preference election hits the payment accounts API and keeps exactly one preferred (D-8 replaces the [bkash,cod] PUT)', async ({ page }) => {
    const second = baseAccount({
        id: 'acc-bkash-business-2', provider: 'bkash', account_type: 'business', is_enabled: true,
        verification_level: 'configured_unverified',
        credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: '01899887766' },
    });
    const state = await setupRoutes(page, { accounts: [codEnabled, bkashSelfEnabled, second] });
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();
    await expect(page.getByTestId(`preferred-star-${bkashSelfEnabled.id}`)).toBeVisible();
    await page.getByTestId(`preferred-toggle-${second.id}`).click();
    await expect.poll(() => state.preferredPuts).toEqual([second.id]);
    // DB truth kept server-side: exactly one preferred row per shop…
    expect(state.accounts.filter((a) => a.is_preferred).map((a) => a.id)).toEqual([second.id]);
    // …and the UI re-renders that truth after the reload.
    await expect(page.getByTestId(`preferred-star-${second.id}`)).toBeVisible();
    await expect(page.getByTestId(`preferred-star-${bkashSelfEnabled.id}`)).toHaveCount(0);
    // The legacy display-order PUT is never used to select credentials anymore.
    expect(state.priorityPuts).toBe(0);
    expect(state.unexpected).toEqual([]);
});

test('advance policy persists through PUT /api/payment/policy and round-trips from the server', async ({ page }) => {
    const state = await setupRoutes(page, { accounts: [codEnabled] });
    await loginAndGo(page);
    await page.getByTestId('payment-tab-policies').click();
    await expect(page.getByTestId('policies-tab')).toBeVisible();
    await page.locator('input[name="advance-policy"][value="percentage"]').check();
    await expect(page.getByTestId('advance-percentage-input')).toBeVisible();
    await page.getByTestId('advance-percentage-input').fill('25');
    await page.getByTestId('policy-save').click();
    await expect.poll(() => state.policyPuts.length).toBe(1);
    expect(state.policyPuts[0]).toMatchObject({ advance_policy: 'percentage', advance_value: 25 });
    await page.reload();
    // Post-reload anchor: the mounted workspace (no signal band may exist — C6).
    await expect(page.getByTestId('payment-tab-methods')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.em-payment [data-testid$="-signal"]')).toHaveCount(0);
    await page.getByTestId('payment-tab-policies').click();
    await expect(page.locator('input[name="advance-policy"][value="percentage"]')).toBeChecked();
    await expect(page.getByTestId('advance-percentage-input')).toHaveValue('25');
    expect(state.shopUpdates).toBe(0); // the old /shop/update blob path is gone
    expect(state.unexpected).toEqual([]);
});

test('merchant gateway states capability truth without claiming automated checkout (§7 row 3 / forbidden string)', async ({ page }) => {
    const gw = baseAccount({
        id: 'acc-bkash-gw-3', provider: 'bkash', account_type: 'merchant_gateway', is_enabled: true,
        verification_level: 'configured_unverified',
        credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null },
        _secrets: { app_key: 'AK-live', app_secret: 'AS-live', username: 'u@x', password: 'pw-live' },
    });
    const state = await setupRoutes(page, { accounts: [codEnabled, gw] });
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();
    const chip = page.getByTestId(`verification-chip-${gw.id}`);
    await expect(chip.getByTestId('verification-extra')).toContainText('Automated checkout is not active yet');
    await expect(page.getByText(/Automated checkout via official merchant API/i)).toHaveCount(0);
    // inert-by-default: even the automation predicate renders false, and the
    // wire never echoes the stored secrets.
    const payload = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/payment/accounts')).json()));
    expect(payload).not.toContain('AS-live');
    expect(payload).not.toContain('pw-live');
    expect(payload).not.toContain('AK-live');
    expect(state.unexpected).toEqual([]);
});

test('390px: no horizontal overflow and five mobile destinations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupRoutes(page, { accounts: [codEnabled, bkashSelfEnabled] });
    await loginAndGo(page);
    await expect(page.locator('.em-payment [data-testid$="-signal"]')).toHaveCount(0);
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('axe: no critical or serious violations in the payment surface', async ({ page }) => {
    await setupRoutes(page, { accounts: [codEnabled, bkashSelfEnabled] });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.locator('.em-payment [data-testid$="-signal"]')).toHaveCount(0);
    await page.getByTestId('expand-bkash').click();
    await expect(page.getByTestId(`account-card-${bkashSelfEnabled.id}`)).toBeVisible();
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page }).include('.em-payment').analyze();
    const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(bad).toEqual([]);
});
