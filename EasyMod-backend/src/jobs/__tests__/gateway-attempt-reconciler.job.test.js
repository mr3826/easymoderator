'use strict';

/**
 * Gateway-attempt reconciler job (A0 §4.3 wiring) — the schedule side of the
 * bounded ladder. Contract-mock only (R-12): no provider is ever contacted.
 */
process.env.NODE_ENV = 'test';

jest.mock('../../utils/structured-logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
const mockReconcile = jest.fn();
const mockIsEnabledGate = jest.fn(() => false);
jest.mock('../../modules/payment/bkash-tokenized.service', () => ({
    client: { isEnabledGate: () => mockIsEnabledGate() },
    reconcileStaleGatewayAttempts: mockReconcile,
}));

const GatewayAttemptReconcilerJob = require('../gateway-attempt-reconciler.job');

describe('GatewayAttemptReconcilerJob', () => {
    beforeEach(() => { jest.clearAllMocks(); mockIsEnabledGate.mockReturnValue(false); });

    test('inert deployment (BKASH_ENABLED off): skipped with ZERO sweep calls', async () => {
        const job = new GatewayAttemptReconcilerJob();
        const res = await job.execute();
        expect(res.skipped).toBe(true);
        expect(res.reason).toMatch(/BKASH_ENABLED is not "true"/);
        expect(mockReconcile).not.toHaveBeenCalled();
    });

    test('dry run never touches the provider either', async () => {
        const job = new GatewayAttemptReconcilerJob();
        const res = await job.execute({ dryRun: true });
        expect(res.skipped).toBe(true);
        expect(res.reason).toMatch(/dry-run/);
        expect(mockReconcile).not.toHaveBeenCalled();
    });

    test('enabled: sweeps at the 1-minute clock with the service-owned bounded ladder', async () => {
        mockIsEnabledGate.mockReturnValue(true);
        mockReconcile.mockResolvedValue({
            scanned: 3,
            results: [
                { paymentId: 'a', confirmed: true, status: 'paid' },
                { paymentId: 'b', confirmed: false, status: 'failed' },
                { paymentId: 'c', confirmed: false, status: 'initiated', deferred: true },
            ],
        });
        const job = new GatewayAttemptReconcilerJob();
        const now = new Date('2026-11-27T10:00:00.000Z');
        const res = await job.execute({ runDate: now });
        expect(res.skipped).toBe(false);
        expect(mockReconcile).toHaveBeenCalledTimes(1);
        const arg = mockReconcile.mock.calls[0][0];
        expect(arg.olderThanMinutes).toBe(1);   // clock granularity only
        expect(arg.limit).toBe(50);             // service caps to 200
        expect(arg.now).toEqual(now);
        expect(res.scanned).toBe(3);
        expect(res.confirmed).toBe(1);
        expect(res.failed).toBe(1);
        expect(res.deferred).toBe(1);
    });

    test('a throwing sweep propagates (BullMQ retries are capped; the per-row ladder bounds provider traffic)', async () => {
        mockIsEnabledGate.mockReturnValue(true);
        mockReconcile.mockRejectedValue(new Error('db unavailable'));
        const job = new GatewayAttemptReconcilerJob();
        await expect(job.execute()).rejects.toThrow('db unavailable');
    });
});
