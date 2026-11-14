'use strict';

/**
 * Printable invoice HTML — ADR-0011 line-item rendering.
 *
 * A delivered-order invoice must show every terminal outcome, including the
 * explicit BDT 0 RETURNED/CANCELLED lines, plus any reversal credit, and must
 * carry the contract version. A historical Partner invoice keeps its recorded
 * derivation but is labelled historical.
 */

jest.mock('../subscription.service', () => ({
    getInvoiceById: jest.fn(),
}));
jest.mock('../../entities', () => ({
    Shop: { findOne: jest.fn() },
}));
jest.mock('../../commercial/commercial-query.service', () => ({
    listBillingLines: jest.fn(),
}));

const subscriptionService = require('../subscription.service');
const { Shop } = require('../../entities');
const commercialQuery = require('../../commercial/commercial-query.service');
const controller = require('../subscription.controller');

const makeRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.setHeader = jest.fn(() => res);
    res.send = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
};

const makeReq = () => ({
    user: { shopId: 'shop-1', userId: 'user-1' },
    params: { invoiceId: 'inv-1' },
    query: {},
});

const baseInvoice = (overrides = {}) => ({
    id: 'b3f6c2b0-1a2b-4c3d-8e9f-0123456789ab',
    invoice_number: 'INV-202611-ABC123',
    invoice_type: 'delivered_order',
    status: 'pending',
    amount: 20,
    base_amount: 0,
    extra_usage_amount: 20,
    addon_amount: 0,
    billing_period: '2026-11',
    created_at: new Date('2026-11-01T00:00:00.000Z'),
    due_date: new Date('2026-11-08T00:00:00.000Z'),
    metadata: {
        contractVersion: '1.0.0',
        unitPriceMinor: 1000,
        grossMinor: 2000,
        creditMinor: 0,
        netMinor: 2000,
    },
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    Shop.findOne.mockResolvedValue({ name: 'Test Shop', email: 'shop@example.test' });
    commercialQuery.listBillingLines.mockResolvedValue([]);
});

describe('getInvoicePdf — delivered-order invoice', () => {
    it('renders billable and explicit BDT 0 lines plus the net total', async () => {
        subscriptionService.getInvoiceById.mockResolvedValue(baseInvoice());
        commercialQuery.listBillingLines.mockResolvedValue([
            { id: 'line-1', orderId: 'order-1', lineKind: 'billable', outcome: 'DELIVERED', amountMinor: 1000 },
            { id: 'line-2', orderId: 'order-2', lineKind: 'zero_rated', outcome: 'RETURNED', amountMinor: 0 },
            { id: 'line-3', orderId: 'order-3', lineKind: 'zero_rated', outcome: 'CANCELLED', amountMinor: 0 },
        ]);

        const req = makeReq();
        const res = makeRes();
        const next = jest.fn();

        await controller.getInvoicePdf(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(commercialQuery.listBillingLines).toHaveBeenCalledWith({
            shopId: 'shop-1',
            invoiceId: 'b3f6c2b0-1a2b-4c3d-8e9f-0123456789ab',
        });
        const html = res.send.mock.calls[0][0];
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
        expect(html).toContain('DELIVERED order');
        expect(html).toContain('RETURNED order');
        expect(html).toContain('CANCELLED order');
        expect(html).toContain('৳10.00');
        expect(html).toContain('৳0.00 (zero-rated)');
        expect(html).toContain('৳20.00');
        expect(html).toContain('Commercial contract v1.0.0');
        expect(html).not.toContain('Usage charges');
    });

    it('renders a reversal credit line when the invoice metadata carries one', async () => {
        subscriptionService.getInvoiceById.mockResolvedValue(baseInvoice({
            amount: 10,
            metadata: {
                contractVersion: '1.0.0',
                grossMinor: 2000,
                creditMinor: 1000,
                netMinor: 1000,
            },
        }));
        commercialQuery.listBillingLines.mockResolvedValue([
            { orderId: 'order-1', lineKind: 'billable', outcome: 'DELIVERED', amountMinor: 1000 },
            { orderId: 'order-2', lineKind: 'billable', outcome: 'DELIVERED', amountMinor: 1000 },
        ]);

        const res = makeRes();
        await controller.getInvoicePdf(makeReq(), res, jest.fn());

        const html = res.send.mock.calls[0][0];
        expect(html).toContain('Reversal credit');
        expect(html).toContain('-৳10.00');
        expect(html).toContain('৳10.00');
    });

    it('falls back to the recorded metadata lines when the ledger read fails', async () => {
        subscriptionService.getInvoiceById.mockResolvedValue(baseInvoice({
            metadata: {
                contractVersion: '1.0.0',
                lines: [
                    { orderId: 'order-1', kind: 'billable', outcome: 'DELIVERED', amountMinor: 1000 },
                    { orderId: 'order-2', kind: 'zero_rated', outcome: 'CANCELLED', amountMinor: 0 },
                ],
                netMinor: 1000,
            },
        }));
        commercialQuery.listBillingLines.mockRejectedValue(new Error('db down'));

        const res = makeRes();
        await controller.getInvoicePdf(makeReq(), res, jest.fn());

        const html = res.send.mock.calls[0][0];
        expect(html).toContain('DELIVERED order');
        expect(html).toContain('CANCELLED order');
    });
});

describe('getInvoicePdf — historical invoices', () => {
    it('labels a legacy Partner derivation as historical and never as current pricing', async () => {
        subscriptionService.getInvoiceById.mockResolvedValue(baseInvoice({
            invoice_type: 'partner_per_order',
            amount: 15,
            base_amount: 15,
            extra_usage_amount: 0,
            metadata: {
                delivered_orders: 1,
                rate_band: 'historical',
                rate_bdt: 15,
                computed_total: 15,
            },
        }));

        const res = makeRes();
        await controller.getInvoicePdf(makeReq(), res, jest.fn());

        const html = res.send.mock.calls[0][0];
        expect(html).toContain('Historical Partner delivery calculation');
        expect(html).toContain('Historical rate tier');
        expect(html).toContain('Recorded Partner fee');
        expect(html).not.toContain('Commercial contract v');
    });

    it('propagates tenant/not-found errors to the error middleware', async () => {
        const notFound = Object.assign(new Error('Invoice not found'), { status: 404 });
        subscriptionService.getInvoiceById.mockRejectedValue(notFound);

        const next = jest.fn();
        await controller.getInvoicePdf(makeReq(), makeRes(), next);

        expect(next).toHaveBeenCalledWith(notFound);
    });
});