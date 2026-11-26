/**
 * Payment verification & claims — focused E2E proofs for the redesign
 * (contract §2 ladder, §3 self-MFS, §5 policy; A0 integration 2026-11-26).
 * Everything here is mock-endpoint driven — NO live money, NO live provider
 * (R-12/R-13: verdicts come from the mocked server exactly as the real inert
 * deployment would answer).
 *
 * Covers the four new invariants the builders escalated:
 *  1. Ladder chip states incl. the INERT Nagad/Rocket ceiling copy, plus the
 *     A9-R2 certify seam the FE must mirror: certify UI appears only for
 *     recorded-production + a CERTIFIABLE_RUNGS level (sandbox_verified
 *     prerequisite REMOVED), non-production rows get the honest switch-CTA,
 *     a bypassed sandbox attempt 400s verbatim, and the recorded-environment
 *     PATCH demotes the ladder like the real writer does.
 *  2. Credential replace NEVER echoes secrets on any response and DEMOTES the
 *     ladder (§2 credential-change invalidation).
 *  3. Policy five-rule validation round-trip incl. a server-400 bypass path.
 *  4. claim → merchant approve/reject through the REAL notification-row UI
 *     (F2 migration: no page.evaluate fetch for owner actions): payment_claimed
 *     → verified/rejected, with expires_at set, duplicate-TrxID refusal, honest
 *     receipt copy, verbatim server verdicts, and the D-4 posture that expired
 *     rows surface honestly (Expired chip) yet stay actionable — no 410 wall.
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

// Mirrors the real OwnerNotification row columns returned by GET /in-app
// (owner-notification.entity.js). Verdicts below come from the mocked server
// EXACTLY as the real (inert, post-D-4) endpoints answer — flat AppError/success
// envelopes, never a fabricated shape.
interface NotifRow {
    id: string; shop_id: string; type: string;
    customer_message: string | null;
    customer_data: Record<string, unknown>;
    status: string; owner_response: string | null;
    expires_at: string; created_at: string;
}

async function setupRoutes(page: Page, seedRows: Row[] = []) {
    let authenticated = false;
    const state: {
        unexpected: string[];
        rows: Row[];
        policy: Record<string, unknown>;
        claims: Record<string, unknown>[];
        notifs: NotifRow[];
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
        notifs: [],
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
                // A9-R2 (payment-accounts.service.js applyEnvironmentChangeDemotion,
                // :174-187): a changed RECORDED environment demotes every rung
                // above configured_unverified (an unverified row stays put).
                const cfg = b.config as Record<string, unknown> | undefined;
                if (cfg && cfg.environment !== undefined) {
                    const from = String(a.config.environment ?? '').trim().toLowerCase();
                    const to = String(cfg.environment ?? '').trim().toLowerCase();
                    a.config = { ...a.config, ...cfg };
                    if (from !== to && a.verification_level !== 'unverified') {
                        a.verification_level = 'configured_unverified';
                    }
                }
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
                // Mirrors certifyLiveAccount EXACTLY as rewritten by A9-R2
                // (payment-verification.service.js:296-375): the old
                // sandbox_verified prerequisite is REMOVED; certification
                // requires the STORED config.environment to be explicitly
                // 'production', any CERTIFIABLE_RUNGS level, and 3–500-char
                // owner evidence. Refusal messages are the server's verbatim.
                const explicitEnvironment = String(a.config?.environment ?? '').trim().toLowerCase();
                if (explicitEnvironment !== 'production') {
                    return route.fulfill({ status: 400, json: { success: false, code: 'PROVIDER_ENVIRONMENT_NOT_PRODUCTION', message: explicitEnvironment === 'sandbox'
                        ? 'This account is recorded as a SANDBOX environment — live certification describes production posture. Switch the account to production (this demotes the ladder) and certify with production evidence.'
                        : 'The account environment is not explicitly recorded as "production" (legacy rows must be re-saved with config.environment="production" before they can be live-certified). Nothing was recorded.' } });
                }
                const levelBefore = a.verification_level || 'unverified';
                if (levelBefore === 'live_certified') {
                    return route.fulfill({ status: 409, json: { success: false, code: 'ALREADY_LIVE_CERTIFIED', message: 'This account is already live-certified — submit a new certification only after a credential/environment change demotes it.' } });
                }
                if (!['unverified', 'configured_unverified', 'sandbox_verified'].includes(levelBefore)) {
                    return route.fulfill({ status: 409, json: { success: false, code: 'LADDER_STATE_NOT_CERTIFIABLE', message: `Verification level "${levelBefore}" is not certifiable` } });
                }
                const evidenceText = String(body().evidence ?? '').trim();
                if (evidenceText.length < 3 || evidenceText.length > 500) {
                    return route.fulfill({ status: 400, json: { success: false, code: 'INVALID_EVIDENCE', message: 'A non-empty live-certification evidence reference (3–500 chars) is required' } });
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

        // ── self-MFS claim + merchant owner-action surface (§3, R-13) ─────────
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
            const notifId = `notif-${state.claims.length + 1}`;
            const claim = {
                transaction_id: trx,
                status: 'payment_claimed',
                order_id: String(b.orderId),
                payment_method: 'bkash',
                payment_account_id: 'acc-bkash-self-1',
                amount: 250,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                notification_id: notifId,
            };
            state.claims.push(claim);
            // sendPaymentConfirmationRequest (owner-notification.service.js:131+):
            // the row carries expires_at (24 h), status pending, and the
            // merchant-evidence customer_data (stamped wallet number, claim
            // amount/kind — §3.3 fixes). Real rows have NO customer_data.title.
            state.notifs.push({
                id: notifId,
                shop_id: 'shop-1',
                type: 'payment_confirmation',
                customer_message: `Paid ৳250 via bKash, TrxID ${trx}`,
                customer_data: {
                    orderId: claim.order_id,
                    orderNumber: `ORD-${String(b.orderId)}`,
                    transactionId: trx,
                    paymentMethod: 'bkash',
                    amount: claim.amount,
                    claimAmount: claim.amount,
                    amountKind: 'full',
                    walletNumber: '01711000000',
                },
                status: 'pending',
                owner_response: null,
                expires_at: claim.expires_at,
                created_at: new Date().toISOString(),
            });
            return route.fulfill({
                status: 201,
                json: { success: true, ...claim, message: `We've received your payment details (TrxID ${trx}). The shop owner will confirm shortly.` },
            });
        }
        if (path === '/api/notifications/in-app' && method === 'GET') {
            // Real GET /in-app now goes through listShopNotifications →
            // markExpiredOnRead (owner-notification.service.js:681+): a pending
            // row past its deadline is honestly re-reported as 'expired' on the
            // list read — and stays actionable. Verbatim here.
            const now = Date.now();
            for (const n of state.notifs) {
                if (n.status === 'pending' && n.expires_at && new Date(n.expires_at).getTime() <= now) {
                    n.status = 'expired';
                }
            }
            return route.fulfill({ json: json([...state.notifs].reverse()) });
        }
        const ap = path.match(/^\/api\/notifications\/payment-confirmation\/([\w-]+)\/(approve|reject)$/);
        if (ap && method === 'POST') {
            state.approveCalls.push({ id: ap[1], action: ap[2] });
            const appEnvelope = (status: number, payload: Record<string, unknown>) => route.fulfill({ status, json: payload });
            const notif = state.notifs.find((n) => n.id === ap[1]);
            // Route-level guard (notification.routes.js): unknown id → 404 AppError.
            if (!notif) {
                return appEnvelope(404, { success: false, message: 'Notification not found', code: 'INTERNAL_ERROR', timestamp: new Date().toISOString() });
            }
            // handleOwnerResponse status guard (owner-notification.service.js
            // :250-252, landed 2026-11-26) — 'pending' AND 'expired' stay
            // actionable; only settled rows are 409-rejected. Verbatim message,
            // flat AppError envelope. The old blanket 410 expiry wall is GONE
            // (D-4 ratified: merchant judgment outranks the SLA).
            if (!['pending', 'expired'].includes(notif.status)) {
                return appEnvelope(409, { success: false, message: 'Payment confirmation has already been completed', code: 'INTERNAL_ERROR', timestamp: new Date().toISOString() });
            }
            const claim = state.claims.find((c) => String(c.notification_id) === notif.id);
            if (!claim) {
                return appEnvelope(404, { success: false, message: 'Payment transaction not found', code: 'INTERNAL_ERROR', timestamp: new Date().toISOString() });
            }
            const action = ap[2] as 'approve' | 'reject';
            claim.status = action === 'approve' ? 'verified' : 'rejected';
            notif.status = 'completed';
            notif.owner_response = action;
            // Real success envelope (handleOwnerResponse return, :412-416): FLAT
            // { success, message: "Payment approved|rejected successfully", orderId }.
            return route.fulfill({
                json: { success: true, message: `Payment ${action}d successfully`, orderId: claim.order_id },
            });
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
    // Header-removal C6: no signal band exists any more — the mounted methods
    // tab is the readiness anchor, and no generic *-signal may appear.
    await expect(page.getByTestId('payment-tab-methods')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.em-payment [data-testid$="-signal"]')).toHaveCount(0);
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
        row({ id: 'a-prod', provider: 'bkash', account_type: 'merchant_gateway', verification_level: 'configured_unverified', config: { environment: 'production' }, credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null } }),
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
    // F1 certify seam (A9-R2 mirror): sandbox_verified WITHOUT a recorded
    // production environment is a state the server 400s — no dead-end button
    // may exist there; the honest switch-CTA renders instead.
    await page.getByTestId('manage-a-sbx').click();
    await expect(page.getByTestId('certify-evidence')).toHaveCount(0);
    await expect(page.getByTestId('drawer-certify-live')).toHaveCount(0);
    expect(state.certifyPosts).toEqual([]);
    await expect(page.getByTestId('certify-needs-production')).toContainText(
        'Switch to Production to certify live credentials — this resets the verification ladder.',
    );
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('account-drawer')).toHaveCount(0);

    // …and the NEW server rule: configured_unverified + recorded production IS
    // certifiable through the real UI (the old sandbox_verified prerequisite is
    // gone — this pins certify-from-configured_unverified+production).
    await page.getByTestId('manage-a-prod').click();
    await expect(page.getByTestId('certify-needs-production')).toHaveCount(0);
    await expect(page.getByTestId('certify-evidence')).toBeVisible();
    await expect(page.getByTestId('drawer-certify-live')).toBeVisible();
    await page.getByTestId('certify-evidence').fill('bKash go-live approval email 2026-11-30');
    await page.getByTestId('drawer-certify-live').click();
    await expect.poll(() => state.certifyPosts).toEqual(['a-prod']);
    await expect(page.getByText('Certification recorded')).toBeVisible();
    await expect.poll(() => rows.find((r) => r.id === 'a-prod')!.verification_level).toBe('live_certified');
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

// F1 (A8 round-2): the full one-flow path the server's own 400 message
// instructs — no dead end anywhere: the UI hides certify on the sandbox row,
// a bypassed attempt returns the server message VERBATIM, then toggling the
// environment (existing PATCH), saving, and reopening lands the merchant on
// the certify field, which succeeds after the honest ladder demotion.
test('certify seam: sandbox attempt 400s verbatim, then switch→save→reopen certifies (demotion honest)', async ({ page }) => {
    const gw = row({
        id: 'a-sbx2', provider: 'bkash', account_type: 'merchant_gateway', verification_level: 'sandbox_verified',
        config: { environment: 'sandbox' },
        credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null },
    });
    const state = await setupRoutes(page, [gw]);
    await loginAndGo(page);
    await page.getByTestId('expand-bkash').click();

    // 1. Drawer state on the recorded-sandbox row: CTA, no button, zero traffic.
    await page.getByTestId('manage-a-sbx2').click();
    await expect(page.getByTestId('certify-evidence')).toHaveCount(0);
    await expect(page.getByTestId('drawer-certify-live')).toHaveCount(0);
    expect(state.certifyPosts).toEqual([]);
    await expect(page.getByTestId('certify-needs-production')).toContainText('Switch to Production to certify live credentials');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('account-drawer')).toHaveCount(0);

    // 2. Bypassed certify attempt (client-side gate defeated) — the server's
    //    verbatim 400 PROVIDER_ENVIRONMENT_NOT_PRODUCTION message.
    const bypass = await page.evaluate(async () => {
        const r = await fetch('/api/payment/accounts/a-sbx2/certify-live', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ evidence: 'self-declared go-live' }),
        });
        return { status: r.status, body: await r.json() };
    });
    expect(bypass.status).toBe(400);
    expect(bypass.body.code).toBe('PROVIDER_ENVIRONMENT_NOT_PRODUCTION');
    expect(bypass.body.message).toBe('This account is recorded as a SANDBOX environment — live certification describes production posture. Switch the account to production (this demotes the ladder) and certify with production evidence.');

    // 3. Follow the instruction IN the UI: toggle environment (warning states
    //    the demotion up front) → save persists config.environment (PATCH).
    await page.getByTestId('manage-a-sbx2').click();
    await page.getByTestId('drawer-environment').click();
    await expect(page.getByTestId('environment-change-warning')).toContainText(/verification ladder/);
    await expect(page.getByTestId('certify-needs-production')).toContainText(/once you save/i);
    await page.getByTestId('account-drawer-save').click();
    // The handler mutates the seeded row object in place — read it directly.
    await expect.poll(() => gw.config.environment).toBe('production');
    // The switch DEMOTED the ladder honestly (sandbox_verified → configured_unverified).
    await expect.poll(() => gw.verification_level).toBe('configured_unverified');
    await expect(page.getByTestId('account-drawer')).toHaveCount(0);
    await expect(page.getByTestId('verification-chip-a-sbx2').getByTestId('verification-level-badge')).toContainText('Format validated');

    // 4. Reopen → certify field NOW appears (no dead end) → certify succeeds.
    await page.getByTestId('manage-a-sbx2').click();
    await expect(page.getByTestId('certify-needs-production')).toHaveCount(0);
    await expect(page.getByTestId('certify-evidence')).toBeVisible();
    await page.getByTestId('certify-evidence').fill('bKash production go-live approval 2026-11-27');
    await page.getByTestId('drawer-certify-live').click();
    await expect.poll(() => state.certifyPosts).toEqual(['a-sbx2', 'a-sbx2']); // bypass + real UI
    await expect(page.getByText('Certification recorded')).toBeVisible();
    await expect.poll(() => gw.verification_level).toBe('live_certified');
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

// Customer-side claim create — the chatbot machine calls the same service;
// this settings E2E exercises the wire to prove the shape without live money.
// (Merchant-side review actions are driven through the real UI below.)
async function createClaim(page: Page, orderId: string, trxId: string, senderPhone?: string) {
    return page.evaluate(async (args) => {
        const r = await fetch('/api/payment/claims', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args),
        });
        return { status: r.status, body: await r.json() };
    }, senderPhone ? { orderId, trxId, senderPhone } : { orderId, trxId });
}

test('claim → merchant review through the REAL notification UI (F2 migration): approve settles with the verbatim server verdict and an honest lifecycle', async ({ page }) => {
    const wallet = row({ id: 'acc-bkash-self-1', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: true, verification_level: 'configured_unverified', credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' } });
    const state = await setupRoutes(page, [wallet]);
    await loginAndGo(page);

    // 1. Customer-side claim create (the chatbot machine calls this same
    //    service; the settings E2E exercises the wire to prove the shape
    //    without live money). The merchant-side actions below are UI-driven —
    //    this fetch leg has NO merchant UI (customer is in the chatbot).
    const first = await createClaim(page, 'order-77', '9b7xq2lm', '01712345678');
    expect(first.status).toBe(201);
    expect(first.body.success).toBe(true);
    expect(first.body.status).toBe('payment_claimed'); // NOT paid/confirmed — merchant judgment pending
    expect(String(first.body.message)).toMatch(/will confirm shortly/i);
    expect(String(first.body.message)).not.toMatch(/\bpaid\b|\bconfirmed\b/i);
    expect(first.body.expires_at).toBeTruthy(); // the 24h deadline D-4 surfaces (never walls)

    // 2. Duplicate TrxID refusal (race-safe unique reuse of the same ledger id).
    const dupe = await createClaim(page, 'order-78', '9B7XQ2LM');
    expect(dupe.status).toBe(409);
    expect(String(dupe.body.message)).toMatch(/already used/i);

    // 3. F2 MIGRATION (was page.evaluate fetches): the merchant drives the
    //    notification-row buttons. Evidence line shows the stamped wallet
    //    number + TrxID + claim amount (no silent number switching, §6).
    await page.getByTestId('notification-bell').click();
    const approve = page.getByTestId('approve-notif-1');
    await expect(approve).toBeVisible();
    await expect(page.getByTestId('reject-notif-1')).toBeVisible();
    const evidence = page.getByTestId('confirmation-evidence-notif-1');
    await expect(evidence).toContainText('9B7XQ2LM');
    await expect(evidence).toContainText('01711000000');
    // Payment confirmations are NON-dismissible: no generic mark-read here.
    await expect(page.getByLabel('Mark notification read')).toHaveCount(0);

    // 4. Owner approve through the row button → the server's own words render
    //    verbatim (settlement is the merchant act, not automation).
    await approve.click();
    await expect(page.getByTestId('confirmation-result-notif-1')).toContainText('Payment approved successfully');
    await expect.poll(() => state.approveCalls).toEqual([{ id: 'notif-1', action: 'approve' }]);
    await expect.poll(() => (state.claims[0] as { status: string }).status).toBe('verified');
    // Honest lifecycle: the resynced row flips to Completed and never offers
    // the settled action again (so a repeat 409 cannot even be clicked).
    await expect(page.getByTestId('completed-chip-notif-1')).toBeVisible();
    await expect(page.getByTestId('approve-notif-1')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('reject through the notification row: order-side rejection verdict is the server\'s, rendered verbatim', async ({ page }) => {
    const wallet = row({ id: 'acc-bkash-self-1', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: true, verification_level: 'configured_unverified', credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' } });
    const state = await setupRoutes(page, [wallet]);
    await loginAndGo(page);

    const claim = await createClaim(page, 'order-79', '7QZ4M2XT');
    expect(claim.status).toBe(201);

    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('reject-notif-1')).toBeVisible();
    await page.getByTestId('reject-notif-1').click();
    // VERBATIM server copy: handleOwnerResponse builds `Payment ${response}d
    // successfully`, so a reject renders the server's own (misspelled)
    // "rejectd" string — the client must NOT rewrite server verdicts; the
    // correctly-worded i18n title ("Payment rejected") sits above it. Flagged
    // as a backend copy defect for the owner to fix server-side.
    await expect(page.getByTestId('confirmation-result-notif-1')).toContainText('Payment rejectd successfully');
    await expect(page.getByTestId('confirmation-result-notif-1')).toContainText('Payment rejected');
    await expect.poll(() => (state.claims[0] as { status: string }).status).toBe('rejected');
    await expect.poll(() => state.approveCalls).toEqual([{ id: 'notif-1', action: 'reject' }]);
    // Never "approved"/"paid" language on a reject.
    await expect(page.getByTestId('confirmation-result-notif-1')).not.toContainText(/approved|paid/i);
    await expect(page.getByTestId('completed-chip-notif-1')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('F3/D-4: an expired claim surfaces an Expired chip + honest copy, and its buttons STILL work (no 410 wall)', async ({ page }) => {
    const wallet = row({ id: 'acc-bkash-self-1', provider: 'bkash', account_type: 'self', is_enabled: true, is_preferred: true, verification_level: 'configured_unverified', credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' } });
    const state = await setupRoutes(page, [wallet]);
    await loginAndGo(page);

    const claim = await createClaim(page, 'order-80', '6TRX9AAA');
    expect(claim.status).toBe(201);

    // Time passes: the 24 h window elapses while the row sits untouched —
    // D-4 ratified, nothing auto-fails; the server row is simply past deadline.
    state.notifs[0].expires_at = new Date(Date.now() - 60_000).toISOString();

    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('expired-chip-notif-1')).toContainText('Expired');
    await expect(page.getByTestId('expired-copy-notif-1')).toBeVisible();
    const approve = page.getByTestId('approve-notif-1');
    await expect(approve).toBeEnabled(); // buttons stay functional per D-4

    // And the action genuinely completes with the ordinary success verdict —
    // the post-D-4 endpoint has no expiry wall to hit.
    await approve.click();
    await expect(page.getByTestId('confirmation-result-notif-1')).toContainText('Payment approved successfully');
    await expect.poll(() => (state.claims[0] as { status: string }).status).toBe('verified');
    await expect.poll(() => state.approveCalls).toEqual([{ id: 'notif-1', action: 'approve' }]);
    expect(state.unexpected).toEqual([]);
});
