'use strict';

/**
 * UNIT lane — no DB. Proves the billing-lines read is tenant-scoped and that a
 * foreign invoice is a 403, never an empty 200.
 */

const mockBillingLine = { findAll: jest.fn() };
const mockInvoice = { findByPk: jest.fn() };

jest.mock('../../entities', () => ({
    BillingLine: mockBillingLine,
    Invoice: mockInvoice,
}));

const { listBillingLines, toBillingLine } = require('../commercial-query.service');

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOP_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
    jest.clearAllMocks();
    mockBillingLine.findAll.mockResolvedValue([]);
    mockInvoice.findByPk.mockResolvedValue(null);
});

describe('listBillingLines', () => {
    it('requires a shop context', async () => {
        await expect(listBillingLines({ invoiceId: INVOICE_ID }))
            .rejects.toMatchObject({ status: 400, code: 'SHOP_CONTEXT_REQUIRED' });
    });

    it('rejects a malformed invoice id', async () => {
        await expect(listBillingLines({ shopId: SHOP_ID, invoiceId: 'not-a-uuid' }))
            .rejects.toMatchObject({ status: 400, code: 'INVALID_INVOICE_ID' });
    });

    it('returns the shop own lines as camelCase integer-poisha rows', async () => {
        mockBillingLine.findAll.mockResolvedValue([{
            id: 'line-1',
            shop_id: SHOP_ID,
            invoice_id: INVOICE_ID,
            order_id: 'order-1',
            line_kind: 'billable',
            outcome: 'DELIVERED',
            unit_price_minor: 1000,
            amount_minor: 1000,
            currency: 'BDT',
            contract_version: '1.0.0',
            created_at: '2026-11-14T00:00:00.000Z',
        }]);

        const lines = await listBillingLines({ shopId: SHOP_ID, invoiceId: INVOICE_ID });

        expect(lines).toEqual([{
            id: 'line-1',
            invoiceId: INVOICE_ID,
            orderId: 'order-1',
            lineKind: 'billable',
            outcome: 'DELIVERED',
            unitPriceMinor: 1000,
            amountMinor: 1000,
            currency: 'BDT',
            contractVersion: '1.0.0',
            createdAt: '2026-11-14T00:00:00.000Z',
        }]);
    });

    it('returns 403 when a line belongs to another shop', async () => {
        mockBillingLine.findAll.mockResolvedValue([{
            id: 'line-1',
            shop_id: OTHER_SHOP_ID,
            invoice_id: INVOICE_ID,
        }]);

        await expect(listBillingLines({ shopId: SHOP_ID, invoiceId: INVOICE_ID }))
            .rejects.toMatchObject({ status: 403, code: 'INVOICE_FORBIDDEN' });
    });

    it('returns 403 when an empty invoice belongs to another shop', async () => {
        mockInvoice.findByPk.mockResolvedValue({ id: INVOICE_ID, shop_id: OTHER_SHOP_ID });

        await expect(listBillingLines({ shopId: SHOP_ID, invoiceId: INVOICE_ID }))
            .rejects.toMatchObject({ status: 403, code: 'INVOICE_FORBIDDEN' });
    });

    it('returns an empty list for the shop own empty invoice', async () => {
        mockInvoice.findByPk.mockResolvedValue({ id: INVOICE_ID, shop_id: SHOP_ID });
        await expect(listBillingLines({ shopId: SHOP_ID, invoiceId: INVOICE_ID }))
            .resolves.toEqual([]);
    });

    it('does not crash when the ownership lookup fails', async () => {
        mockInvoice.findByPk.mockRejectedValue(new Error('relation does not exist'));
        await expect(listBillingLines({ shopId: SHOP_ID, invoiceId: INVOICE_ID }))
            .resolves.toEqual([]);
    });
});

describe('toBillingLine', () => {
    it('truncates non-integer minor amounts rather than emitting floats', () => {
        const line = toBillingLine({ id: 'x', amount_minor: 1000.9 });
        expect(line.amountMinor).toBe(1000);
    });
});