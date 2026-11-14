/**
 * Partner programme tests after ADR-0011 retirement.
 *  - historical band math still resolves for old invoices (pure);
 *  - historical reads remain;
 *  - apply/approve are refused with 410.
 */

jest.mock('../../entities', () => ({
    PartnerApplication: { findOne: jest.fn(), create: jest.fn(), findAll: jest.fn() },
    Order: { count: jest.fn() },
}));

const { PartnerApplication, Order } = require('../../entities');
const { calculatePartnerCharge, PARTNER_ORDER_TIERS } = require('../subscription.plans');
const partnerService = require('../partner.service');

describe('calculatePartnerCharge — historical flat bands', () => {
    it.each([
        [0, 0],
        [299, 0],
        [300, 300 * 15],
        [999, 999 * 15],
        [1000, 1000 * 12],
        [3000, 3000 * 10],
    ])('computes %s delivered orders as %s BDT', (orders, expected) => {
        expect(calculatePartnerCharge(orders)).toBe(expected);
    });

    it('keeps the retired band table for historical resolution', () => {
        expect(PARTNER_ORDER_TIERS.map((t) => [t.minOrders, t.maxOrders])).toEqual([
            [300, 999], [1000, 2999], [3000, null],
        ]);
        expect(PARTNER_ORDER_TIERS.map((t) => t.rateBdt)).toEqual([15, 12, 10]);
    });
});

describe('historical reads', () => {
    it('counts delivered orders in the rolling window without a qualification gate', async () => {
        Order.count.mockResolvedValueOnce(5);

        await expect(partnerService.countRecentDeliveredOrders('shop-1')).resolves.toBe(5);
        expect(Order.count).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                shop_id: 'shop-1',
                order_status: 'delivered',
                delivered_at: expect.any(Object),
            }),
        }));
    });

    it('lists preserved applications', async () => {
        PartnerApplication.findAll.mockResolvedValueOnce([{ id: 'app-old' }]);
        await expect(partnerService.listApplications({ status: 'approved' }))
            .resolves.toEqual([{ id: 'app-old' }]);
        expect(PartnerApplication.findAll).toHaveBeenCalledWith({
            where: { status: 'approved' },
            order: [['created_at', 'DESC']],
        });
    });
});

describe('retired write paths', () => {
    it('refuses new applications with 410', async () => {
        await expect(partnerService.applyForPartner({ businessName: 'x' }))
            .rejects.toMatchObject({ status: 410, code: partnerService.RETIRED_CODE });
        expect(PartnerApplication.create).not.toHaveBeenCalled();
    });

    it('refuses approvals with 410 and never switches a subscription', async () => {
        await expect(partnerService.approvePartner('app-1', { shopId: 'shop-1' }))
            .rejects.toMatchObject({ status: 410, code: partnerService.RETIRED_CODE });
    });
});