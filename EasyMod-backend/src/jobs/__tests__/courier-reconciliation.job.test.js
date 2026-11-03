'use strict';

/**
 * CourierReconciliationJob — weekly Steadfast payout pull.
 *
 * Before 2026-11-03 this job existed but was reachable only through the manual
 * CLI runner (job-runner.js), never scheduled by queue-manager, and it read
 * every active integration in one unpaginated find. The launch slice pins:
 *   - bounded pages (50 shops per query) so a large merchant set cannot load
 *     every integration row at once;
 *   - per-shop isolation — one failing shop never aborts the run;
 *   - an explicit run summary with the skipped-duplicate count.
 */

jest.mock('../../modules/entities', () => ({
    DeliveryIntegration: { findAll: jest.fn() },
}));
jest.mock('../../modules/reconciliation/reconciliation.service', () => ({
    pullSteadfastPayments: jest.fn(),
}));
jest.mock('src/config/redis', () => ({ cacheRedis: {} }));

const { DeliveryIntegration } = require('../../modules/entities');
const ReconciliationService = require('../../modules/reconciliation/reconciliation.service');
const CourierReconciliationJob = require('../courier-reconciliation.job');

const shops = (count, start = 0) => Array.from({ length: count }, (_, i) => ({
    shop_id: `shop-${String(start + i).padStart(3, '0')}`,
}));

// Honors offset/limit exactly like the real query, so pagination is exercised
// rather than replayed from a fragile once-queue.
const findAllReturns = (rows) => jest.fn(async ({ offset = 0, limit = 50 } = {}) =>
    rows.slice(offset, offset + limit));

beforeEach(() => jest.clearAllMocks());

test('pages through integrations 50 shops at a time', async () => {
    DeliveryIntegration.findAll.mockImplementation(findAllReturns(shops(103, 0)));
    ReconciliationService.pullSteadfastPayments.mockResolvedValue({ collected: 1, disputes: 0, skipped: 0 });

    const result = await new CourierReconciliationJob().run({ dryRun: false });

    expect(DeliveryIntegration.findAll).toHaveBeenCalledTimes(3);
    expect(DeliveryIntegration.findAll).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 50, offset: 0 }));
    expect(DeliveryIntegration.findAll).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 50, offset: 50 }));
    expect(DeliveryIntegration.findAll).toHaveBeenNthCalledWith(3, expect.objectContaining({ limit: 50, offset: 100 }));
    expect(result.shopsProcessed).toBe(103);
    expect(result.collectionsRecorded).toBe(103);
});

test('aggregates collections, disputes and skipped duplicates across shops', async () => {
    DeliveryIntegration.findAll.mockImplementation(findAllReturns([{ shop_id: 'shop-1' }, { shop_id: 'shop-2' }]));
    ReconciliationService.pullSteadfastPayments
        .mockResolvedValueOnce({ collected: 2, disputes: 1, skipped: 3 })
        .mockResolvedValueOnce({ collected: 1, disputes: 0, skipped: 0 });

    const result = await new CourierReconciliationJob().run({ dryRun: false });

    expect(result).toEqual(expect.objectContaining({
        shopsProcessed: 2,
        collectionsRecorded: 3,
        disputesCreated: 1,
        duplicatesSkipped: 3,
    }));
});

test('one failing shop is recorded and the run continues', async () => {
    DeliveryIntegration.findAll.mockImplementation(findAllReturns([{ shop_id: 'shop-1' }, { shop_id: 'shop-2' }]));
    ReconciliationService.pullSteadfastPayments
        .mockRejectedValueOnce(new Error('steadfast 401'))
        .mockResolvedValueOnce({ collected: 1, disputes: 0, skipped: 0 });

    const result = await new CourierReconciliationJob().run({ dryRun: false });

    // shopsProcessed counts successful pulls (pre-existing semantics); the
    // failed shop is still enumerated and reported in errors.
    expect(result.shopsProcessed).toBe(1);
    expect(result.collectionsRecorded).toBe(1);
    expect(result.errors).toEqual([
        expect.objectContaining({ shop_id: 'shop-1', error: 'steadfast 401' }),
    ]);
});

test('dry run enumerates shops without pulling any payout', async () => {
    DeliveryIntegration.findAll.mockImplementation(findAllReturns([{ shop_id: 'shop-1' }]));

    const result = await new CourierReconciliationJob().run({ dryRun: true });

    expect(ReconciliationService.pullSteadfastPayments).not.toHaveBeenCalled();
    expect(result.shopsProcessed).toBe(1);
    expect(result.collectionsRecorded).toBe(0);
});