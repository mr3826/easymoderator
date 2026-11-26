'use strict';

/**
 * D-10 RATIFIED DEFECT CORRECTION — pinned, not silent (contract §7 row 17,
 * §4.1): billing's `verifyBkashPayment` compared transactionStatus against
 * 'COMPLETED' while the official docs return title-case 'Completed', so a
 * genuinely completed billing payment silently fell through to the failure
 * branch. The fix routes the comparison through payment-taxonomy's canonical,
 * case-insensitive set (isSettledStatus / canonicalStatus).
 *
 * This file PINS the corrected behavior explicitly: the docs spelling settles,
 * the legacy spelling still settles (no regression), non-terminal states stay
 * non-terminal, and the billing path remains a separate, env-credentialed
 * choke point (§4.6) — disabled gateway ⇒ zero HTTP.
 *
 * ⚠ Fixtures are contract-mock (official v1 execute response shape). NOT
 * live-provider evidence (R-12).
 */
process.env.NODE_ENV = 'test';

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: mockAxiosPost }));

const BangladeshPaymentService = require('../bangladesh-payment.service');

const FULL_ENV = {
    BKASH_ENABLED: 'true',
    BKASH_BASE_URL: 'https://checkout.sandbox.bka.sh/v1.2.0-beta',
    BKASH_USERNAME: 'user',
    BKASH_PASSWORD: 'pass',
    BKASH_APP_KEY: 'app-key',
    BKASH_APP_SECRET: 'app-secret',
};
const KEYS = Object.keys(FULL_ENV);
const ORIGINAL = { ...process.env };

function setEnv(vars) {
    KEYS.forEach((k) => delete process.env[k]);
    Object.assign(process.env, vars);
}
beforeEach(() => { jest.clearAllMocks(); setEnv(FULL_ENV); });
afterEach(() => { process.env = { ...ORIGINAL }; });

const executeWith = (transactionStatus) => {
    mockAxiosPost
        .mockResolvedValueOnce({ data: { id_token: 'T' } }) // token grant (assertEnabled-gated)
        .mockResolvedValueOnce({
            data: {
                transactionStatus, // contract-mock field per docs sweep
                trxID: 'TRX-1',
                amount: '120.00',
                currency: 'BDT',
                paymentTime: '2026-11-26T00:00:00Z',
                customerMsisdn: '01711111111',
                merchantInvoiceNumber: 'INV-1',
            },
        });
    return new BangladeshPaymentService().verifyBkashPayment('pay-1');
};

describe('D-10: verifyBkashPayment completion comparison is case-insensitive (§4.1)', () => {
    test.each(['Completed', 'COMPLETED', 'completed'])(
        "transactionStatus '%s' is treated as settled — the documented 'Completed' included (defect fixed, legacy kept)",
        async (status) => {
            const res = await executeWith(status);
            expect(res.success).toBe(true);
            expect(res.status).toBe('completed');
            expect(res.transaction_id).toBe('TRX-1');
        },
    );

    test.each(['Initiated', 'INITIATED', 'initiated'])("'%s' stays pending (non-terminal)", async (status) => {
        const res = await executeWith(status);
        expect(res.success).toBe(false);
        expect(res.status).toBe('pending');
    });

    test('Failed stays failed with the provider message', async () => {
        mockAxiosPost
            .mockResolvedValueOnce({ data: { id_token: 'T' } })
            .mockResolvedValueOnce({ data: { transactionStatus: 'Failed', errorMessage: 'insufficient funds' } });
        const res = await new BangladeshPaymentService().verifyBkashPayment('pay-1');
        expect(res.success).toBe(false);
        expect(res.status).toBe('failed');
        expect(res.message).toBe('insufficient funds');
    });

    test('billing separation preserved (§4.6): disabled ⇒ 503 before any HTTP', async () => {
        setEnv({ ...FULL_ENV, BKASH_ENABLED: 'false' });
        await expect(new BangladeshPaymentService().verifyBkashPayment('pay-1'))
            .rejects.toMatchObject({ status: 503 });
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });
});
