'use strict';

/**
 * Self-MFS PAYMENT CLAIM tests (contract §8.2 + §3.2, A4) — pure mocks, zero
 * provider traffic (R-12). Covers the mandated pin set:
 *  - claim create → TrxIDLog FIRST (nothing verified) + PaymentTransaction
 *    `payment_claimed` with the stamped payment_account_id and provider
 *  - TrxID unique race → "already used" reply (both tables)
 *  - server-side amount authority + tolerance: mismatch RECORDED + surfaced,
 *    never auto-rejected, never auto-accepted
 *  - merchant_gateway rows never resolve as wallet numbers (§6); preferred
 *    wins; legacy rows classified from credentials, never assumed bkash
 *  - no OTP concept anywhere; screenshot optional + labelled supporting only;
 *    the order row is NEVER touched by the claim path
 *  - notification carries the fixed paymentInfo (§3.3) incl. the claim amount
 */
process.env.NODE_ENV = 'test';

const mockPaymentConfig = { findAll: jest.fn(), findByPk: jest.fn() };
// `destroy` exists for the F-9 (A9-R2) compensating-delete pins; the real
// TrxIDLog model always has it (sequelize instance + static surface).
const mockTrxIDLog = { create: jest.fn(), findOne: jest.fn(), destroy: jest.fn() };
const mockPaymentTransaction = { create: jest.fn(), findOne: jest.fn() };
const mockOrder = { findOne: jest.fn() };
const mockOwnerNotification = { sendPaymentConfirmationRequest: jest.fn() };
const mockPolicyService = { getPaymentPolicy: jest.fn(), computeAdvance: jest.fn() };
const mockAccountsService = { _private: { verifyShopAccess: jest.fn() } };

jest.mock('../payment-config.entity', () => mockPaymentConfig);
jest.mock('../trx-id-log.entity', () => mockTrxIDLog);
jest.mock('../../billing/payment-transaction.entity', () => mockPaymentTransaction);
jest.mock('../../order/order.entity', () => mockOrder);
jest.mock('../../notification/owner-notification.service', () => mockOwnerNotification);
jest.mock('../payment-policy.service', () => mockPolicyService);
jest.mock('../payment-accounts.service', () => mockAccountsService);

const claim = require('../payment-claim.service');

const WALLET = {
    account_id: 'acct-bkash-1',
    provider: 'bkash',
    number: '01711111111',
    account_type: 'self',
};
const ORDER = {
    id: 'order-1',
    order_number: '100001',
    customer_name: 'Rina',
    customer_phone: '01822222222',
    total: 1650,
    delivery_fee: 60,
    payment_status: 'pending',
    update: jest.fn(),
};

function baseMocks(overrides = {}) {
    mockOrder.findOne.mockResolvedValue(overrides.order === null ? null : (overrides.order || ORDER));
    mockTrxIDLog.findOne.mockResolvedValue(overrides.trxLogHit || null);
    mockPaymentTransaction.findOne.mockResolvedValue(overrides.txnHit || null);
    mockTrxIDLog.create.mockResolvedValue(overrides.trxLogCreateFail || { id: 'log-1' });
    mockPaymentTransaction.create.mockResolvedValue(overrides.txnCreateFail || { id: 'txn-1' });
    mockPaymentConfig.findAll.mockResolvedValue(overrides.accounts || [
        { id: 'acct-bkash-1', provider: 'bkash', account_type: 'self', gateway: 'self-mfs', is_preferred: true, is_enabled: true, credentials: { mfs_type: 'bkash', mfs_number: '01711111111' } },
    ]);
    mockPaymentConfig.findByPk.mockResolvedValue(overrides.freshAccount === undefined
        ? { id: 'acct-bkash-1', is_enabled: true, credentials: { mfs_number: '01711111111' } }
        : overrides.freshAccount);
    mockPolicyService.getPaymentPolicy.mockResolvedValue(overrides.policy || { advance_policy: 'none', advance_value: null });
    mockPolicyService.computeAdvance.mockImplementation(({ policy, orderTotal }) => {
        if (policy === 'none') return { policy, advance_amount: 0, remainder: orderTotal };
        if (policy === 'percentage') return { policy, advance_amount: Math.round((orderTotal * 50) / 100), remainder: orderTotal - Math.round((orderTotal * 50) / 100) };
        return { policy, advance_amount: orderTotal, remainder: 0 };
    });
    mockOwnerNotification.sendPaymentConfirmationRequest.mockResolvedValue({ success: true, notificationId: 'notif-1' });
    mockAccountsService._private.verifyShopAccess.mockResolvedValue({});
}

beforeEach(() => {
    jest.clearAllMocks();
    baseMocks();
});

describe('claim create (§3.2-3)', () => {
    test('creates TrxIDLog FIRST, then payment_claimed PaymentTransaction with stamped account + provider', async () => {
        const res = await claim.performClaim({
            shopId: 'shop-1',
            orderId: 'order-1',
            trxIdRaw: '8a3f2b9xk1',
            senderPhoneRaw: '+8801933333333',
            account: WALLET,
            displayedAmount: 1650,
            sessionId: 'sess-1',
        });

        expect(res.created).toBe(true);
        expect(res.status).toBe('payment_claimed');
        // order-first call sequence:
        expect(mockTrxIDLog.create.mock.calls.length).toBe(1);
        expect(mockPaymentTransaction.create.mock.calls[0][0].status).toBe('payment_claimed');
        const log = mockTrxIDLog.create.mock.calls[0][0];
        expect(log).toMatchObject({
            shop_id: 'shop-1',
            order_id: 'order-1',
            trx_id: '8A3F2B9XK1', // uppercase, stripped
            mfs_type: 'bkash',
            amount: 1650,
            sender_phone: '01933333333', // +88 normalized
            receiver_phone: '01711111111',
            ocr_raw: null,
            verified_at: null, // nothing is "verified" here (§3.2-3)
        });
        const txn = mockPaymentTransaction.create.mock.calls[0][0];
        expect(txn).toMatchObject({
            order_id: 'order-1',
            shop_id: 'shop-1',
            payment_method: 'bkash',
            payment_gateway: null,
            transaction_id: '8A3F2B9XK1',
            amount: 1650,
            status: 'payment_claimed',
            payment_account_id: 'acct-bkash-1', // §3.5/§6 stamp
        });
        expect(txn.gateway_response).toMatchObject({ source: 'self_mfs_claim', wallet_number: '01711111111', order_session_id: 'sess-1' });
        // the ORDER is never mutated by the claim path:
        expect(ORDER.update).not.toHaveBeenCalled();
        // reply says details-received, NOT paid/confirmed:
        expect(res.reply.en).toMatch(/received your payment details/i);
        expect(res.reply.en).not.toMatch(/Payment confirmed/i);
        expect(res.reply.bn).not.toMatch(/পেমেন্ট নিশ্চিত/);
    });

    test('merchant notified through the fixed sendPaymentConfirmationRequest with taxonomy-safe label + claim amount', async () => {
        await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET, displayedAmount: 1650,
        });
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).toHaveBeenCalledTimes(1);
        const [shopId, orderData, paymentInfo] = mockOwnerNotification.sendPaymentConfirmationRequest.mock.calls[0];
        expect(shopId).toBe('shop-1');
        expect(orderData.total).toBe(1650);
        expect(paymentInfo.paymentMethod).toBe('bKash');
        expect(paymentInfo.transactionId).toBe('ABC123');
        expect(paymentInfo.claim_amount).toBe(1650);
        expect(paymentInfo.wallet_number).toBe('01711111111');
    });

    test('rocket claim works end-to-end (the previously-absent provider) without any provider call', async () => {
        mockPaymentConfig.findAll.mockResolvedValue([
            { id: 'acct-rkt', provider: 'rocket', account_type: 'business', gateway: 'self-mfs', is_preferred: true, is_enabled: true, credentials: { mfs_type: 'rocket', mfs_number: '01899999999', mfs_mode: 'business' } },
        ]);
        mockPaymentConfig.findByPk.mockResolvedValue({ id: 'acct-rkt', is_enabled: true, credentials: { mfs_number: '01899999999' } });
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'RK123456', account: { account_id: 'acct-rkt', provider: 'rocket', number: '01899999999' }, displayedAmount: 1650,
        });
        expect(res.created).toBe(true);
        expect(mockPaymentTransaction.create.mock.calls[0][0].payment_method).toBe('rocket');
        expect(mockOwnerNotification.sendPaymentConfirmationRequest.mock.calls[0][2].paymentMethod).toBe('Rocket');
    });
});

describe('validation + tolerance (§3.2, D-7 R rule)', () => {
    test('rejects malformed TrxID (no provider call, no rows)', async () => {
        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'a!b', account: WALLET,
        })).rejects.toMatchObject({ status: 400, code: 'TRXID_FORMAT_INVALID' });
        // prose must never mint a claim ("i forgot it" → IFORGOTIT-shaped):
        expect(claim.validateTrxIdInput('i forgot it').valid).toBe(false);
        expect(claim.validateTrxIdInput('TrxID: 8A3F2B9XK1')).toEqual({ valid: true, normalized: '8A3F2B9XK1' });
        expect(claim.validateTrxIdInput(' 8a3f 2b9xk1 ')).toEqual({ valid: true, normalized: '8A3F2B9XK1' });
        expect(claim.validateTrxIdInput('ID8F3K2A1').valid).toBe(true); // bare "ID…" stays intact
        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'i forgot it', account: WALLET,
        })).rejects.toMatchObject({ status: 400, code: 'TRXID_FORMAT_INVALID' });
        expect(mockTrxIDLog.create).not.toHaveBeenCalled();
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).not.toHaveBeenCalled();
    });

    test('amount mismatch beyond tolerance is RECORDED + surfaced, never auto-rejected', async () => {
        // displayed (advance) 500 vs server full-total 1650 at claim time:
        mockPolicyService.getPaymentPolicy.mockResolvedValue({ advance_policy: 'none', advance_value: null });
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET, displayedAmount: 500,
        });
        expect(res.created).toBe(true); // never auto-rejected
        expect(res.amountMismatch).toMatchObject({ displayed_amount: 500, server_amount: 1650 });
        const txn = mockPaymentTransaction.create.mock.calls[0][0];
        expect(txn.amount).toBe(1650); // server-recomputed, never customer/displayed value
        expect(txn.gateway_response.amount_mismatch).toMatchObject({ displayed_amount: 500, server_amount: 1650 });
        const paymentInfo = mockOwnerNotification.sendPaymentConfirmationRequest.mock.calls[0][2];
        expect(paymentInfo.amount_mismatch).toMatchObject({ displayed_amount: 500, server_amount: 1650 });
    });

    test('within tolerance (5% service-charge reality) records nothing and claims full server amount', async () => {
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET, displayedAmount: 1660,
        });
        expect(res.amountMismatch).toBeNull();
        expect(mockPaymentTransaction.create.mock.calls[0][0].gateway_response.amount_mismatch).toBeUndefined();
    });

    test('F1/BLOCK ruling: an advance-policy shop claims the FULL total, never the partial advance', async () => {
        mockPolicyService.getPaymentPolicy.mockResolvedValue({ advance_policy: 'percentage', advance_value: 50 });
        mockPolicyService.computeAdvance.mockImplementation(({ policy, orderTotal }) => (
            policy === 'percentage'
                ? { policy, advance_amount: Math.round(orderTotal * 0.5), remainder: orderTotal - Math.round(orderTotal * 0.5) }
                : { policy, advance_amount: orderTotal, remainder: 0 }
        ));
        // A legacy in-flight session still PROMPTED with the advance figure 825:
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET, displayedAmount: 825,
        });
        // the claim is the FULL order total — approve can never settle a
        // fabricated "paid" over an unenforced remainder:
        expect(res.amount).toBe(1650);
        expect(res.amountKind).toBe('full');
        expect(res.amountBasis).toBe('full');
        expect(res.policyAdvance).toBe(true);
        const txn = mockPaymentTransaction.create.mock.calls[0][0];
        expect(txn.amount).toBe(1650);
        expect(txn.gateway_response.amount_kind).toBe('full');
        // the policy truth still rides in the snapshot with the machine field:
        expect(txn.gateway_response.payment_policy).toMatchObject({
            policy: 'percentage', advance_amount: 825, amount_basis: 'full',
        });
        // displayed-vs-server stays RECORDED + SURFACED (never auto-rejected):
        expect(res.created).toBe(true);
        expect(res.amountMismatch).toMatchObject({ displayed_amount: 825, server_amount: 1650 });
        const paymentInfo = mockOwnerNotification.sendPaymentConfirmationRequest.mock.calls[0][2];
        expect(paymentInfo.claim_amount).toBe(1650);
        expect(paymentInfo.amount_kind).toBe('full');
        expect(paymentInfo.amount_basis).toBe('full');
        expect(paymentInfo.policy_advance).toBe(true);
    });

    test('computeClaimAmount: partial policies never yield a partial claim amount (F1 unit pin)', async () => {
        mockPolicyService.getPaymentPolicy.mockResolvedValue({ advance_policy: 'fixed', advance_value: 300 });
        // computeAdvance is SYNC in the real service — mockReturnValue, not Resolved.
        mockPolicyService.computeAdvance.mockReturnValue({ policy: 'fixed', advance_amount: 300, remainder: 1350 });
        const due = await claim.computeClaimAmount('shop-1', { orderTotal: 1650, deliveryCharge: 60 });
        expect(due).toMatchObject({
            amount: 1650,
            partial: false,
            amount_basis: 'full',
            policy_advance: true,
        });
        expect(due.snapshot).toMatchObject({
            policy: 'fixed',
            advance_amount: 300,
            remainder: 1350,
            amount_basis: 'full',
        });
    });

    test('computeClaimAmount: policy none is trivially full', async () => {
        const due = await claim.computeClaimAmount('shop-1', { orderTotal: 1650, deliveryCharge: 60 });
        expect(due).toMatchObject({ amount: 1650, partial: false, amount_basis: 'full', policy_advance: false });
    });

    test('settled order refuses the claim (payment_status guard)', async () => {
        mockOrder.findOne.mockResolvedValue({ ...ORDER, payment_status: 'paid' });
        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        })).rejects.toMatchObject({ status: 409, code: 'PAYMENT_ALREADY_SETTLED' });
    });

    test('cross-shop order is not found (tenant scope)', async () => {
        mockOrder.findOne.mockResolvedValue(null);
        await expect(claim.performClaim({
            shopId: 'other-shop', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        })).rejects.toMatchObject({ status: 404 });
    });
});

describe('duplicate handling (§3.2-3 race-safe)', () => {
    test('existing TrxIDLog row → already-used reply, no txn created, no notification', async () => {
        mockTrxIDLog.findOne.mockResolvedValue({ id: 'old-log' });
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        });
        expect(res).toMatchObject({ created: false, duplicate: true, reason: 'trx_id_log' });
        expect(res.duplicateReply.en).toMatch(/already used/i);
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).not.toHaveBeenCalled();
    });

    // ── B1 (A9-R3 money-integrity, 2026-11-26): ORDER-level dedupe ───────────
    // Two claims with DIFFERENT TrxIDs for one pending order used to coexist
    // (002's comment claimed the claim service policed this; it did not), and
    // a later approve of the stale second row re-settled + double-messaged the
    // customer. Now the second submission answers the honest already-
    // awaiting-review duplicate BEFORE any insert — no second ledger row, no
    // second txn, no second notification. (The settlement half is guarded in
    // handleOwnerResponse — pinned in payment-confirmation.claim-flow.test.js.)

    test('B1: different TrxID on an order that already has a payment_claimed row → honest duplicate, nothing written', async () => {
        mockTrxIDLog.findOne.mockResolvedValue(null); // the NEW TrxID is unused…
        mockPaymentTransaction.findOne
            .mockResolvedValueOnce(null) // …so the trx-id checks miss…
            .mockResolvedValueOnce({ id: 'txn-open', status: 'payment_claimed', order_id: 'order-1' }); // …but an open claim exists

        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: '9b7xq2lm', account: WALLET,
        });

        expect(res).toMatchObject({
            created: false, duplicate: true, pendingClaim: true,
            reason: 'claim_already_awaiting_review', trxId: '9B7XQ2LM',
        });
        // honest copy — NOT the "TrxID already used" line (this TrxID is new):
        expect(res.duplicateReply.en).toMatch(/already awaiting the shop owner/i);
        expect(res.duplicateReply.en).not.toMatch(/already used/i);
        expect(mockTrxIDLog.create).not.toHaveBeenCalled();
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).not.toHaveBeenCalled();
    });

    test('B1: a settled (verified) transaction for the same order blocks a new claim before any insert too', async () => {
        // Defense-in-depth: order row lagging (payment_status still pending)
        // must not let a second claim through while a verified row exists.
        mockTrxIDLog.findOne.mockResolvedValue(null);
        mockPaymentTransaction.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'txn-verified', status: 'verified', order_id: 'order-1' });

        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ZZ112233', account: WALLET,
        });
        expect(res).toMatchObject({ created: false, duplicate: true, reason: 'claim_already_awaiting_review' });
        expect(mockTrxIDLog.create).not.toHaveBeenCalled();
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
    });

    test('B1: the order check reads the tenant-scoped open-claim set (shop + order + claim/verified statuses)', async () => {
        await claim.performClaim({ shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET });
        const orderCheckCall = mockPaymentTransaction.findOne.mock.calls
            .find((c) => c[0]?.where?.order_id === 'order-1');
        expect(orderCheckCall).toBeDefined();
        expect(orderCheckCall[0].where).toMatchObject({
            shop_id: 'shop-1',
            order_id: 'order-1',
            status: ['payment_claimed', 'verified'],
        });
    });

    test('B1: a REJECTED prior claim does not block an honest re-claim (order still pending)', async () => {
        mockTrxIDLog.findOne.mockResolvedValue(null);
        mockPaymentTransaction.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null); // where-filters rejected rows; mock shows no OPEN claim
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'RECLAIM77', account: WALLET,
        });
        expect(res.created).toBe(true);
    });

    // B3 (A9-R3): mixed-case resend of the SAME TrxID keeps its honest
    // duplicate answer — case is normalized BEFORE the ledger lookup, so the
    // service and the (now uppercase-normalizing) edge agree on identity.
    test('B3: mixed-case resend of an already-used TrxID → same trx_id_log duplicate answer (normalization order pinned)', async () => {
        mockTrxIDLog.findOne.mockImplementation(async ({ where }) => (where.trx_id === '9B7XQ2LM' ? { id: 'old-log' } : null));
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: '9b7xq2lm', account: WALLET,
        });
        expect(res).toMatchObject({ created: false, duplicate: true, reason: 'trx_id_log' });
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
    });

    test('TrxIDLog unique violation race → duplicate reply', async () => {
        const err = new Error('d key already exists');
        err.name = 'SequelizeUniqueConstraintError';
        mockTrxIDLog.create.mockRejectedValue(err);
        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        });
        expect(res).toMatchObject({ created: false, duplicate: true });
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
    });

    test('audit-ledger write failure FAILS CLOSED — no claim, no notification', async () => {
        mockTrxIDLog.create.mockRejectedValue(new Error('connection reset'));
        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        })).rejects.toMatchObject({ status: 500, code: 'PAYMENT_CLAIM_AUDIT_WRITE_FAILED' });
        expect(mockPaymentTransaction.create).not.toHaveBeenCalled();
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).not.toHaveBeenCalled();
    });

    // ── F-9 (A9-R2, 2026-11-26): ledger + txn writes are ATOMIC ──────────────
    // Before: two independent inserts. A PaymentTransaction failure left the
    // TrxIDLog row behind, permanently BURNING a legitimate TrxID (every retry
    // answered "already used" while no claim row ever existed). Now: a single
    // sequelize transaction when the driver supports it; compensating delete
    // otherwise.

    test('F-9: txn-create failure (non-duplicate) compensates the ledger row — TrxID stays usable, no notification', async () => {
        mockTrxIDLog.create.mockResolvedValue({ id: 'log-1' }); // no instance destroy → static destroy path
        mockPaymentTransaction.create.mockRejectedValue(new Error('connection reset'));

        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        })).rejects.toMatchObject({ status: 500, code: 'PAYMENT_CLAIM_WRITE_FAILED' });

        expect(mockTrxIDLog.destroy).toHaveBeenCalledWith({
            where: { shop_id: 'shop-1', trx_id: 'ABC123' },
        });
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).not.toHaveBeenCalled();
    });

    test('F-9: txn unique violation → honest duplicate reply AND the just-inserted ledger row is compensated', async () => {
        mockTrxIDLog.create.mockResolvedValue({ id: 'log-1' });
        const dup = new Error('duplicate key value violates unique constraint "payment_transactions_shop_transaction"');
        dup.name = 'SequelizeUniqueConstraintError';
        mockPaymentTransaction.create.mockRejectedValue(dup);

        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        });
        expect(res).toMatchObject({ created: false, duplicate: true, reason: 'payment_transaction' });
        expect(res.duplicateReply.en).toMatch(/already used/i);
        // the ledger row must not linger orphaned over a claim that does not exist
        expect(mockTrxIDLog.destroy).toHaveBeenCalled();
    });

    test('F-9: an instance destroy on the returned ledger row is preferred over the static delete', async () => {
        const destroyInstance = jest.fn().mockResolvedValue(true);
        mockTrxIDLog.create.mockResolvedValue({ id: 'log-1', destroy: destroyInstance });
        mockPaymentTransaction.create.mockRejectedValue(new Error('disk full'));

        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        })).rejects.toMatchObject({ status: 500, code: 'PAYMENT_CLAIM_WRITE_FAILED' });
        expect(destroyInstance).toHaveBeenCalled();
        expect(mockTrxIDLog.destroy).not.toHaveBeenCalled();
    });

    test('F-9: a failed compensation is LOUD (never silent) — logged, original error still propagates', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockTrxIDLog.create.mockResolvedValue({ id: 'log-1' });
        mockTrxIDLog.destroy.mockRejectedValueOnce(new Error('db gone'));
        mockPaymentTransaction.create.mockRejectedValue(new Error('connection reset'));

        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        })).rejects.toMatchObject({ status: 500, code: 'PAYMENT_CLAIM_WRITE_FAILED' });
        expect(errSpy).toHaveBeenCalledWith(
            expect.stringContaining('compensating ledger delete FAILED'), expect.anything(),
        );
        errSpy.mockRestore();
    });

    test('F-9: when the driver supports transactions, BOTH writes run inside ONE transaction (no compensating delete needed)', async () => {
        const fakeT = { id: 'trx-driver' };
        mockTrxIDLog.sequelize = { transaction: jest.fn((cb) => cb(fakeT)) };
        mockTrxIDLog.create.mockResolvedValue({ id: 'log-1' });
        mockPaymentTransaction.create.mockResolvedValue({ id: 'txn-1' });

        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        });
        expect(res.created).toBe(true);
        expect(mockTrxIDLog.sequelize.transaction).toHaveBeenCalledTimes(1);
        expect(mockTrxIDLog.create.mock.calls[0][1]).toEqual({ transaction: fakeT });
        expect(mockPaymentTransaction.create.mock.calls[0][1]).toEqual({ transaction: fakeT });
        expect(mockTrxIDLog.destroy).not.toHaveBeenCalled(); // rollback owns cleanup
    });

    test('F-9: transaction path — txn failure rolls both back (no burned TrxID, no destroy call), duplicate reply stays honest', async () => {
        const fakeT = { id: 'trx-driver-2' };
        mockTrxIDLog.sequelize = { transaction: jest.fn((cb) => cb(fakeT)) };
        // pre-check sees nothing; the RACING winner exists by the time the
        // failed transaction re-checks:
        mockPaymentTransaction.findOne.mockResolvedValueOnce(null).mockResolvedValue({ id: 'racer-txn' });
        const dup = new Error('duplicate key value violates unique constraint');
        dup.name = 'SequelizeUniqueConstraintError';
        mockPaymentTransaction.create.mockRejectedValue(dup);

        const res = await claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET,
        });
        // pre-check finds the racing row → honest 'payment_transaction' reason:
        expect(res).toMatchObject({ created: false, duplicate: true, reason: 'payment_transaction' });
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).not.toHaveBeenCalled();
        expect(mockTrxIDLog.destroy).not.toHaveBeenCalled();
    });

    test('F-9: a ledger row is NEVER destroyed when the claim succeeds', async () => {
        await claim.performClaim({ shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: WALLET });
        expect(mockTrxIDLog.destroy).not.toHaveBeenCalled();
    });

    afterEach(() => { delete mockTrxIDLog.sequelize; });
});

describe('wallet resolution (§6 preferred + no silent switching)', () => {
    test('merchant_gateway rows never resolve as wallet numbers; preferred wallet wins', async () => {
        mockPaymentConfig.findAll.mockResolvedValue([
            { id: 'acct-gw', provider: 'bkash', account_type: 'merchant_gateway', gateway: 'self-mfs', is_preferred: true, is_enabled: true, credentials: { mfs_type: 'bkash', app_key: 'k', app_secret: 's', username: 'u' } },
            { id: 'acct-self', provider: 'bkash', account_type: 'self', gateway: 'self-mfs', is_preferred: false, is_enabled: true, credentials: { mfs_type: 'bkash', mfs_number: '01711111111' } },
            { id: 'acct-nagad', provider: 'nagad', account_type: 'self', gateway: 'self-mfs', is_preferred: false, is_enabled: true, credentials: { mfs_type: 'nagad', mfs_number: '01844444444' } },
        ]);
        const w = await claim.resolvePaymentWallet('shop-1', {});
        expect(w.account_id).toBe('acct-self'); // gateway excluded despite preferred; bkash before nagad deterministically
        const n = await claim.resolvePaymentWallet('shop-1', { provider: 'নগদ' });
        expect(n).toMatchObject({ provider: 'nagad', number: '01844444444' });
    });

    // B5 (A9-R3) agreement half: the gateway exclusion is the SINGLE rule the
    // legacy mirror (payment-accounts.syncBdFromAccounts) now shares — a
    // merchant_gateway row whose stored credentials carry a phone must give
    // the chatbot NOTHING, never that number (§6 "no silent number switching").
    test('B5: a merchant_gateway row carrying credentials.phone is NOT a wallet source — chatbot stays null', async () => {
        mockPaymentConfig.findAll.mockResolvedValue([
            { id: 'acct-gw', provider: 'bkash', account_type: 'merchant_gateway', gateway: 'self-mfs', is_preferred: true, is_enabled: true, credentials: { app_key: 'AK', app_secret: 'AS', username: 'u@x', phone: '01712345678' } },
        ]);
        expect(await claim.resolvePaymentWallet('shop-1', {})).toBeNull();
        await expect(claim.performClaim({
            shopId: 'shop-1', orderId: 'order-1', trxIdRaw: 'ABC123', account: null,
        })).rejects.toMatchObject({ status: 400, code: 'PAYMENT_ACCOUNT_NOT_CONFIGURED' });
    });

    test('legacy drift row classified from credentials, never assumed bkash', async () => {
        mockPaymentConfig.findAll.mockResolvedValue([
            { id: 'acct-legacy', provider: null, account_type: null, gateway: 'self-mfs', is_preferred: true, is_enabled: true, credentials: { mfs_type: 'rocket', mfs_number: '01966666666' } },
        ]);
        const w = await claim.resolvePaymentWallet('shop-1', {});
        expect(w).toMatchObject({ provider: 'rocket', number: '01966666666' });
    });

    test('un-decryptable credentials (null) → honest no-wallet, never a wrong number', async () => {
        mockPaymentConfig.findAll.mockResolvedValue([
            { id: 'x', provider: 'bkash', account_type: 'self', gateway: 'self-mfs', is_preferred: true, is_enabled: true, credentials: null },
        ]);
        expect(await claim.resolvePaymentWallet('shop-1', {})).toBeNull();
    });
});

describe('API entry createSelfMfsClaim (POST /api/payment/claims)', () => {
    test('membership enforced before any write', async () => {
        mockAccountsService._private.verifyShopAccess.mockRejectedValue(new Error('forbidden'));
        mockAccountsService._private.verifyShopAccess.mockImplementation(async () => {
            const { AppError } = require('../../../utils/AppError');
            throw new AppError('You do not have access to this shop', 403);
        });
        await expect(claim.createSelfMfsClaim('shop-1', 'user-1', { orderId: 'order-1', trxId: 'ABC123' }))
            .rejects.toMatchObject({ status: 403 });
        expect(mockOrder.findOne).not.toHaveBeenCalled();
    });

    test('valid claim creates pending row + merchant notify', async () => {
        const res = await claim.createSelfMfsClaim('shop-1', 'user-1', {
            orderId: 'order-1', trxId: 'trx777777', senderPhone: '01933333333', customerMessage: 'paid today',
        });
        expect(res.created).toBe(true);
        expect(res.status).toBe('payment_claimed');
        expect(mockOwnerNotification.sendPaymentConfirmationRequest).toHaveBeenCalled();
    });
});

describe('OTP/screenshot/provider-inert invariants (§0, R-12)', () => {
    test('no OTP field is ever collected, no screenshot auto-verification, no provider HTTP', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require.resolve('../payment-claim.service'), 'utf8');
        // the only OTP mentions are the "never ask for OTP" guard comments:
        const otpLines = src.split('\n').filter(l => /otp/i.test(l));
        for (const line of otpLines) {
            expect(line.toLowerCase()).toMatch(/never|কখনো|不/);
        }
        expect(src).toMatch(/screenshot_evidence: 'supporting_only'/);
        expect(src).not.toMatch(/verifyPaymentScreenshot/);
        expect(src).not.toMatch(/require\(['"]axios['"]\)/);
        expect(src).not.toMatch(/status:\s*'paid'/);
        expect(src).not.toMatch(/status:\s*'verified'/);
    });
});
