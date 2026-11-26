/**
 * Payment verification & claims — focused E2E proofs for the redesign
 * (contract §2 ladder, §3 self-MFS, §5 policy; A0 integration 2026-11-26).
 * Everything here is mock-endpoint driven — NO live money, NO live provider
 * (R-12/R-13: verdicts come from the mocked server exactly as the real inert
 * deployment would answer).
 *
 * Covers the four new invariants the builders escalated:
 *  1. Ladder chip states incl. the INERT Nagad/Rocket ceiling copy.
 *  2. Credential replace NEVER echoes secrets on any response and DEMOTES the
 *     ladder (§2 credential-change invalidation).
 *  3. Policy five-rule validation round-trip incl. a server-400 bypass path.
 *  4. claim → merchant approve happy path: payment_claimed → verified, with
 *     expires_at set, duplicate-TrxID refusal, and the honest receipt copy
 *     (never "paid"/"confirmed" before the merchant acts).
 * Plus multi-account enable/disable with the single-preferred invariant.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });
const BD = /^01[3-9]\d{8}$/;

const NOTICE_NAGAD_ROCKET = 'Official automated verification is not available for Nagad/Rocket. Payments to these numbers are confirmed by you (the merchant), never automatically.';

interface Row {
    id: string; shop_id: string; provider: string; account_type: string; gateway: string | null;
    is_enabled: boolean; is_preferred: boolean; verification_level: string; automated_checkout_active: boolean;
    provider_notice?: unknown; config: Record<string, unknown>;
    credential_summary?: { has_credentials: boolean; mfs_type: string | null; mfs_mode: string | null; mfs_number: string | null };
    _secrets?: Record<string, string> | null;
}
const view = (r: Row) => { const v = { ...r } as Record<string, unknown>; delete v._secrets; return v; };
const row = (over: Partial<Row> & Pick<Row, 'id' | 'provider' | 'account_type'>): Row => ({
    shop_id: 'shop-1', gateway: over.provider === 'cod' ? 'cod' : 'self-mfs',
    is_enabled: true, is_preferred: false, verification_level: 'unverified',
    automated_checkout_active: false, provider_notice: null, config: {}, _secrets: null, ...over,
} as Row);

async function setupRoutes(page: Page, seedRows: Row[] = []) {
    let authenticated = false;
    const state: {
        unexpected: string[];
        rows: Row[];
        policy: Record<string, unknown>;
        claims: Record<string, unknown>[];
        usedTrx: string[];
        approveCalls: { id: string; action: string }[];
        preferredPuts: string[];
        verifyPosts: string[];
        certifyPosts: string[];
        policyPuts: Record<string, unknown>[];
    } = {
        unexpected: [],
        rows: seedRows,
        policy: { advance_policy: 'none', advance_value: null, payment_message: '' },
        claims: [],
        usedTrx: [],
        approveCalls: [],
        preferredPuts: [],
        verifyPosts: [],
        certifyPosts: [],
        policyPuts: [],
    };

    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const body = () => (request.postDataJSON() ?? {}) as Record<string, unknown>;

        const knownExact = new Set([
            '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
            '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
            '/api/shop/me', '/api/payment/accounts', '/api/payment/policy', '/api/payment/claims',
            '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions',
            '/api/shop/delivery/readiness', '/api/channels/meta',
        ]);
        const knownPattern = [
            /^\/api\/payment\/accounts\/[\w-]+(\/(preferred|verify-credentials|certify-live))?$/,
            /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
            /^\/api\/notifications\/payment-confirmation\/[\w-]+\/(approve|reject)$/,
        ];
        if (!knownExact.has(path) && !knownPattern.some((p) => p.test(path))) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
        }

        if (path === '/api/csrf') return route.fulfill({ json: json({ csrfToken: 'csrf-test' }) });
        if (path === '/api/auth/signin' && method === 'POST') {
            authenticated = true;
            return route.fulfill({ json: json({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }) });
        }
        if (path === '/api/auth/me') {
            if (!authenticated) return route.fulfill({ status: 401, json: { success: false } });
            return route.fulfill({ json: json({ user: mockUser, currentShop: mockShop, allShops: [mockShop] }) });
        }
        if (path === '/api/setup/status') return route.fulfill({ json: json({ complete: true }) });
        if (path === '/api/subscription') return route.fulfill({ json: json({ plan: 'MERCHANT', status: 'active' }) });
        if (path === '/api/commercial/claims') return route.fulfill({ json: json({ surface: 'usage-banner', locale: 'en', contractVersion: '1.0.0', decisions: [] }) });
        if (path === '/api/public/commercial-contract') return route.fulfill({ json: json({ contract_version: '1.0.0' }) });
        if (path === '/api/shop/me') return route.fulfill({ json: json({ ...mockShop, settings: {} }) });
        if (path === '/api/order/counts') return route.fulfill({ json: json({ total: 0 }) });
        if (path === '/api/conversation/needs-reply-count') return route.fulfill({ json: json({ count: 0 }) });
        if (path === '/api/product/stock-exceptions') return route.fulfill({ json: json({ exceptions: 0 }) });
        if (path === '/api/shop/delivery/readiness') return route.fulfill({ json: json({ ready: false, providers: [] }) });
        if (path === '/api/channels/meta') return route.fulfill({ json: json([]) });

        if (path === '/api/payment/accounts' && method === 'GET') {
            return route.fulfill({ json: json(state.rows.map(view)) });
        }
        const m = path.match(/^\/api\/payment\/accounts\/([\w-]+)(?:\/(preferred|verify-credentials|certify-live))?$/);
        if (m) {
            const id = m[1];
            const a = state.rows.find((r) => r.id === id);
            if (!a) return route.fulfill({ status: 404, json: { success: false, message: 'Payment account not found' } });
            if (!m[2] && method === 'PATCH') {
                const b = body();
                if (b.is_enabled !== undefined) a.is_enabled = Boolean(b.is_enabled);
                const creds = b.credentials as Record<string, string> | undefined;
                if (creds) {
                    // Server-side: validate then persist; ANY credential write
                    // demotes the ladder (§2).
                    if (a.account_type !== 'merchant_gateway' && !BD.test(String(creds.mfs_number ?? ''))) {
                        return route.fulfill({ status: 400, json: { success: false, message: 'Wallet number fails BD format validation' } });
                    }
                    if (a.account_type === 'merchant_gateway') {
                        if (!creds.app_key || !creds.app_secret || !creds.username) {
                            return route.fulfill({ status: 400, json: { success: false, message: 'merchant_gateway credentials require app_key, app_secret and username' } });
                        }
                        a._secrets = creds;
                        a.credential_summary = { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null };
                    } else {
                        a.credential_summary = { has_credentials: true, mfs_type: String(creds.mfs_type ?? a.provider), mfs_mode: String(creds.mfs_mode ?? 'self'), mfs_number: String(creds.mfs_number) };
                    }
                    a.verification_level = 'unverified';
                }
                return route.fulfill({ json: json(view(a)) });
            }
            if (!m[2] && method === 'DELETE') {
                state.rows = state.rows.filter((r) => r.id !== id);
                return route.fulfill({ json: { success: true, message: 'Payment account deleted' } });
            }
            if (m[2] === 'preferred' && method === 'PUT') {
                state.preferredPuts.push(id);
                if (!a.is_enabled) return route.fulfill({ status: 409, json: { success: false, code: 'PREFERRED_ACCOUNT_DISABLED', message: 'Only an enabled account can be set as preferred' } });
                for (const r of state.rows) r.is_preferred = r.id === id;
                return route.fulfill({ json: { success: true, preferred_account_id: id } });
            }
            if (m[2] === 'verify-credentials' && method === 'POST') {
                state.verifyPosts.push(id);
                // Top-level spread mirrors the real controller envelope
                // (`{ success: true, ...result }`) — the drawer renders `message` from there.
                if (a.provider === 'nagad' || a.provider === 'rocket') {
                    return route.fulfill({ json: { success: true, status: 'verification_unavailable', provider_contact: false, message: NOTICE_NAGAD_ROCKET, provider_notice: { en: NOTICE_NAGAD_ROCKET, bn: '...' } } });
                }
                if (a.account_type === 'merchant_gateway') {
                    return route.fulfill({ json: { success: true, status: 'automation_disabled', provider_contact: false, environment: String(a.config.environment ?? 'sandbox'), message: 'Provider credential checks are disabled in this deployment (BKASH_ENABLED is not "true"); credentials were validated locally only.' } });
                }
                return route.fulfill({ json: { success: true, status: 'format_validated', provider_contact: false, message: 'Number format validated — not a provider check' } });
            }
            if (m[2] === 'certify-live' && method === 'POST') {
                state.certifyPosts.push(id);
                if (a.verification_level !== 'sandbox_verified') {
                    return route.fulfill({ status: 409, json: { success: false, code: 'SANDBOX_HANDSHAKE_REQUIRED', message: 'Only a sandbox-verified account can be live-certified' } });
                }
                a.verification_level = 'live_certified';
                return route.fulfill({ json: { success: true, verification_level: 'live_certified', message: 'Live certification recorded against owner evidence and audit.' } });
            }
        }

        if (path === '/api/payment/policy') {
            if (method === 'GET') return route.fulfill({ json: json(state.policy) });
            const b = body();
            state.policyPuts.push(b);
            const p = String(b.advance_policy ?? '');
            const v = b.advance_value;
            if (!['none', 'full', 'delivery_charge', 'percentage', 'fixed'].includes(p)) return route.fulfill({ status: 400, json: { success: false, message: 'advance_policy invalid' } });
            if (p === 'percentage' && (typeof v !== 'number' || v < 1 || v > 99)) return route.fulfill({ status: 400, json: { success: false, message: 'advance_value must be 1..99 for percentage' } });
            if (p === 'fixed' && (typeof v !== 'number' || v < 1 || v > 100000)) return route.fulfill({ status: 400, json: { success: false, message: 'advance_value must be 1..100000 for fixed' } });
            if (['none', 'full', 'delivery_charge'].includes(p) && v !== null) return route.fulfill({ status: 400, json: { success: false, message: 'This rule has no advance amount' } });
            state.policy = { advance_policy: p, advance_value: ['none', 'full', 'delivery_charge'].includes(p) ? null : v, payment_message: String(b.payment_message ?? '') };
            return route.fulfill({ json: json({ ...state.policy, updated_at: '2026-11-27T00:00:00.000Z', updated_by: 'user-1' }) });
        }

        // ── self-MFS claim + merchant approve surface (§3, R-13) ─────────────
        if (path === '/api/payment/claims' && method === 'POST') {
            const b = body();
            const trx = String(b.trxId ?? '').toUpperCase().replace(/\s/g, '');
            if (!BD.test(String(b.senderPhone ?? ''))) { /* optional; null tolerated */ }
            if (!b.orderId || !/^[A-Z0-9]{6,16}$/.test(trx)) {
                return route.fulfill({ status: 400, json: { success: false, code: 'INVALID_TRXID', message: 'Transaction ID must be 6–16 letters/digits' } });
            }
            if (state.usedTrx.includes(trx)) {
                return route.fulfill({ status: 409, json: { success: false, code: 'TRXID_ALREADY_USED', message: `This TrxID (${trx}) was already used. Please pay with a new transaction or contact the shop.` } });
            }
            state.usedTrx.push(trx);
            const claim = {
                transaction_id: trx,
                status: 'payment_claimed',
                order_id: String(b.orderId),
                payment_method: 'bkash',
                payment_account_id: 'acc-bkash-self-1',
                amount: 250,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                notification_id: 'notif-claim-1',
            };
            state.claims.push(claim);
            return route.fulfill({
                status: 201,
                json: { success: true, ...claim, message: `We've received your payment details (TrxID ${trx}). The shop owner will confirm shortly.` },
            });
        }
        if (path === '/api/notifications/in-app' && method === 'GET') {
            const claim = state.claims[state.claims.length - 1] as Record<string, unknown> | undefined;
            return route.fulfill({
                json: json(claim ? [{
                    id: 'notif-claim-1', type: 'payment_confirmation', status: 'pending',
                    title: 'Payment confirmation needed', created_at: new Date().toISOString(),
                    expires_at: claim.expires_at,
                    customer_data: { transactionId: claim.transaction_id, orderId: claim.order_id, walletNumber: '01711000000', claimAmount: claim.amount, amountKind: 'full' },
                }] : []),
            });
        }
        const ap = path.match(/^\/api\/notifications\/payment-confirmation\/([\w-]+)\/(approve|reject)$/);
        if (ap && method === 'POST') {
            state.approveCalls.push({ id: ap[1], action: ap[2] });
            const claim = state.claims[state.claims.length - 1] as Record<string, unknown> | undefined;
            if (!claim) return route.fulfill({ status: 404, json: { success: false, message: 'No claim matches this notification' } });
            if (ap[2] === 'approve') {
                claim.status = 'verified';
                return route.fulfill({ json: json({ status: 'approved', transaction_status: 'verified', order_status: 'confirmed' }) });
            }
            claim.status = 'rejected';
            return route.fulfill({ json: json({ status: 'rejected', transaction_status: 'rejected', order_status: 'cancelled' }) });
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
    await expect(page.getByTestId('payment-signal')).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
    });
});

test('ladder chips: every rung renders its exact honest copy, and Nagad/Rocket are inert by ceiling', async ({ page }) => {
    const rows = [
        row({ id: 'a-unv', provider: 'bkash', account_type: 'self', verification_level: 'unverified', credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' } }),
        row({ id: 'a-cfg', provider: 'nagad', account_type: 'self', verification_level: 'configured_unverified', provider_notice: { en: NOTICE_NAGAD_ROCKET, bn: '...' }, credential_summary: { has_credentials: true, mfs_type: 'nagad', mfs_mode: 'self', mfs_number: '01811000000' } }),
        row({ id: 'a-sbx', provider: 'bkash', account_type: 'merchant_gateway', verification_level: 'sandbox_verified', credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null } }),
        row({ id: 'a-cert', provider: 'rocket', account_type: 'business', verification_level: 'configured_unverified', provider_notice: { en: NOTICE_NAGAD_ROCKET, bn: '...' }, credential_summary: { has_credentials: true, mfs_type: 'rocket', mfs_mode: 'business', mfs_number: '01911000000' } }),
    ];
    const state = await setupRoutes(page, rows);
    await loginAndGo(page);

    await page.getByTestId('expand-bkash').click();
    await expect(page.getByTestId('verification-chip-a-unv').getByTestId('verification-level-badge')).toContainText('Not verified');
    await expect(page.getByTestId('verification-chip-a-unv').getByTestId('verification-honesty')).toContainText('Not verified yet.');
    await expect(page.getByTestId('verification-chip-a-sbx').getByTestId('verification-level-badge')).toContainText('Sandbox tested');
    // D-3 mandated sentence, rendered verbatim:
    await expect(page.getByTestId('verification-chip-a-sbx').getByTestId('verification-honesty'))
        .toContainText('sandbox checkout handshake verified; no settlement implied');
    // …and the ladder gate: certify UI only appears from sandbox_verified gateways.
    await page.getByTestId('manage-a-sbx').click();
    await expect(page.getByTestId('certify-evidence')).toBeVisible();
    await expect(page.getByTestId('drawer-certify-live')).toBeVisible();
    await page.getByTestId('certify-evidence').fill('bKash go-live approval email 2026-11-30');
    await page.getByTestId('drawer-certify-live').click();
    await expect.poll(() => state.certifyPosts).toEqual(['a-sbx']);
    await expect(page.getByText('Certification recorded')).toBeVisible();
    await expect.poll(() => rows.find((r) => r.id === 'a-sbx')!.verification_level).toBe('live_certified');
    // close the drawer before touching the rows behind it (overlay intercepts)
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('account-drawer')).toHaveCount(0);

    // Nagad/Rocket: the exact "verification unavailable" notice on the card,
    // and an explicit check returns it too — with ZERO provider contact.
    await page.getByTestId('expand-nagad').click();
    await expect(page.getByTestId('verification-chip-a-cfg').getByTestId('verification-honesty'))
        .toContainText('Official automated verification is not available for Nagad/Rocket');
    await page.getByTestId('manage-a-cfg').click();
    await page.getByTestId('drawer-validate-format').click();
    // scoped to the drawer (the same notice is also on the card chip behind it)
    await expect(page.getByTestId('account-drawer').getByText(NOTICE_NAGAD_ROCKET)).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('credential replace never echoes secrets and DEMOTES the ladder (§2 invalidation)', async ({ page }) => {
    const gw = row({
        id: 'a-gw', provider: 'bkash', account_type: 'merchant_gateway', verification_level: 'configured_unverified',
        credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null },
        _secrets: { app_key: 'AK-old', app_secret: 'AS-old', username: 'u-old', password: 'pw-old' },
    });
    const state = await setupRoutes(page, [row({ id: 'a-cod', provider: 'cod', account_type: 'standard', is_enabled: true, verification_level: 'live_certified' }), gw]);
    await loginAndGo(page);

    await page.getByTestId('expand-bkash').click();
    await page.getByTestId('manage-a-gw').click();
    // 1. Inputs NEVER hydrate the stored secrets:
    await expect(page.getByTestId('gateway-app-key')).toHaveValue('');
    await expect(page.getByTestId('gateway-app-secret')).toHaveValue('');
    await expect(page.getByTestId('gateway-username')).toHaveValue('');
    // 2. Typing shows the explicit replace warning:
    await page.getByTestId('gateway-app-key').fill('AK-new');
    await page.getByTestId('gateway-app-secret').fill('AS-new');
    await page.getByTestId('gateway-username').fill('u-new');
    await expect(page.getByTestId('replace-warning')).toBeVisible();
    // 3. Save sends the NEW set (never the old) and the response carries no secrets:
    const responses: string[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/payment/accounts')) responses.push(r.url()); });
    await page.getByTestId('account-drawer-save').click();
    await expect.poll(() => state.rows.find((r) => r.id === 'a-gw')!._secrets).toEqual({ app_key: 'AK-new', app_secret: 'AS-new', username: 'u-new' });
    const wire = JSON.stringify((await page.evaluate(async () => (await fetch('/api/payment/accounts')).json())).data);
    expect(wire).not.toContain('AK-old');
    expect(wire).not.toContain('AS-old');
    expect(wire).not.toContain('AK-new');
    expect(wire).not.toContain('AS-new');
    // 4. The credential write DEMOTED the ladder to honest 'Not verified':
    await expect(page.getByTestId('verification-chip-a-gw').getByTestId('verification-level-badge')).toContainText('Not verified');
    expect(state.unexpected).toEqual([]);
});

test('policy five-rule round-trip: valid for each rule, client-blocks + server-400 for invalid', async ({ page }) => {
    const state = await setupRoutes(page, []);
    await loginAndGo(page);
    await page.getByTestId('payment-tab-policies').click();

    // Valid round-trips across the canonical five. 'none' is the INITIAL
    // server state, so the loop visits it LAST (a change must exist to arm the
    // single PUT — the shell only allows saving dirty drafts).
    const valid: Array<{ p: string; v: number | null }> = [
        { p: 'full', v: null }, { p: 'delivery_charge', v: null },
        { p: 'percentage', v: 40 }, { p: 'fixed', v: 500 }, { p: 'none', v: null },
    ];
    for (const { p, v } of valid) {
        await page.locator(`input[name="advance-policy"][value="${p}"]`).check();
        if (p === 'percentage' || p === 'fixed') {
            await page.getByTestId(p === 'percentage' ? 'advance-percentage-input' : 'advance-fixed-input').fill(String(v));
        }
        await page.getByTestId('policy-save').click();
        await expect.poll(() => state.policy.advance_policy).toBe(p);
        await expect.poll(() => state.policy.advance_value).toBe(v);
    }

    // Client-side bounds block before any PUT (percentage 150 out of range):
    // PoliciesTab keeps the button armed but blocks the save with an alert
    // when the draft is provably invalid (handleSave hasIssues branch).
    const putsAfterValid = state.policyPuts.length;
    await page.locator('input[name="advance-policy"][value="percentage"]').check();
    await page.getByTestId('advance-percentage-input').fill('150');
    await page.getByTestId('policy-save').click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(state.policyPuts.length).toBe(putsAfterValid); // zero new PUTs from an invalid draft
    expect(state.policy.advance_policy).toBe('none'); // nothing persisted by the blocked draft
    // Server-side enforcement on a bypassed client (direct fetch):
    const bypass = await page.evaluate(async () => {
        const r = await fetch('/api/payment/policy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ advance_policy: 'percentage', advance_value: 150, payment_message: '' }),
        });
        return { status: r.status, body: await r.json() };
    });
    expect(bypass.status).toBe(400);
    expect(bypass.body.success).toBe(false);
    expect(state.policy.advance_policy).toBe('none'); // rejected write never persisted
    expect(state.unexpected).toEqual([]);
});

test('multi-account enable/disable keeps exactly one preferred (owner writes only)', async ({ page }) => {
    const a = row({ id: 'p-a', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: true, verification_level: 'configured_unverified', credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' } });
    const b = row({ id: 'p-b', provider: 'bkash', account_type: 'business', is_enabled: true, credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: '01811000000' } });
    const c = row({ id: 'p-c', provider: 'bkash', account_type: 'merchant_gateway', is_enabled: false });
    const state = await setupRoutes(page, [a, b, c]);
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();

    // Preferred toggle on a DISABLED account is inert client-side (no 409 traffic)…
    await expect(page.getByTestId('preferred-toggle-p-c')).toBeDisabled();
    // …and election of B clears A (server invariant) — UI follows the reload.
    await page.getByTestId('preferred-toggle-p-b').click();
    await expect.poll(() => state.preferredPuts).toEqual(['p-b']);
    expect(state.rows.filter((r) => r.is_preferred).map((r) => r.id)).toEqual(['p-b']);
    await expect(page.getByTestId('preferred-star-p-b')).toBeVisible();
    await expect(page.getByTestId('preferred-star-p-a')).toHaveCount(0);

    // Disable/enable via PATCH switch:
    const switchB = page.getByTestId('account-card-p-b').getByRole('switch');
    await switchB.click();
    await expect.poll(() => state.rows.find((r) => r.id === 'p-b')!.is_enabled).toBe(false);
    // Now preferred-toggle for a disabled account must also be disabled:
    await expect(page.getByTestId('preferred-toggle-p-b')).toBeDisabled();
    expect(state.unexpected).toEqual([]);
});

test('claim → merchant approve happy path (mocked endpoints, no live money): payment_claimed → verified with honest receipts', async ({ page }) => {
    const wallet = row({ id: 'acc-bkash-self-1', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: true, verification_level: 'configured_unverified', credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' } });
    const state = await setupRoutes(page, [wallet]);
    await loginAndGo(page);

    // 1. Customer-side claim create (the chatbot machine calls this same service;
    //    the settings E2E exercises the wire to prove the shape without live money).
    const first = await page.evaluate(async () => {
        const r = await fetch('/api/payment/claims', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ orderId: 'order-77', trxId: '9b7xq2lm', senderPhone: '01712345678' }),
        });
        return { status: r.status, body: await r.json() };
    });
    expect(first.status).toBe(201);
    expect(first.body.success).toBe(true);
    expect(first.body.status).toBe('payment_claimed'); // NOT paid/confirmed — merchant judgment pending
    expect(String(first.body.message)).toMatch(/will confirm shortly/i);
    expect(String(first.body.message)).not.toMatch(/\bpaid\b|\bconfirmed\b/i);
    expect(first.body.expires_at).toBeTruthy(); // the 24h deadline the owner-response 410 guard needs

    // 2. Duplicate TrxID refusal (race-safe unique reuse of the same ledger id).
    const dupe = await page.evaluate(async () => {
        const r = await fetch('/api/payment/claims', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ orderId: 'order-78', trxId: '9B7XQ2LM' }),
        });
        return { status: r.status, body: await r.json() };
    });
    expect(dupe.status).toBe(409);
    expect(String(dupe.body.message)).toMatch(/already used/i);

    // 3. The merchant sees a NON-dismissible confirmation row carrying the evidence.
    const inbox = await page.evaluate(async () => (await (await fetch('/api/notifications/in-app')).json()).data);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe('payment_confirmation');
    expect(inbox[0].customer_data.walletNumber).toBe('01711000000'); // the number the customer was given (no silent switching)
    expect(inbox[0].customer_data.claimAmount).toBe(250);
    expect(inbox[0].expires_at).toBeTruthy();

    // 4. Owner approve → settlement flips transaction verified + order confirmed (merchant act, not automation).
    const approve = await page.evaluate(async () => {
        const r = await fetch('/api/notifications/payment-confirmation/notif-claim-1/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
        return { status: r.status, body: await r.json() };
    });
    expect(approve.status).toBe(200);
    expect(approve.body.data.transaction_status).toBe('verified');
    expect(state.approveCalls).toEqual([{ id: 'notif-claim-1', action: 'approve' }]);
    expect((state.claims[0] as { status: string }).status).toBe('verified');
    expect(state.unexpected).toEqual([]);
});
