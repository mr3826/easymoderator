'use strict';

jest.mock('../../entities', () => ({
    Customer: { findAndCountAll: jest.fn() },
    CustomerOpportunity: { findAll: jest.fn() },
    Conversation: { findAll: jest.fn() },
}));
jest.mock('../../customer/customer.entity', () => ({
    rawAttributes: { channel_type: { values: ['messenger', 'instagram', 'webchat', 'manual', 'facebook', 'telegram'] } },
}));
jest.mock('../customer-orders', () => ({ loadOrdersForCustomersWithCoverage: jest.fn() }));
jest.mock('../opportunity.service', () => ({
    LIVE_STATUSES: ['OPEN', 'ACTIONED'],
    DISMISS_REASONS: ['NOT_INTERESTED', 'ALREADY_HANDLED', 'NOT_A_REAL_REQUEST', 'OTHER'],
    serializeOpportunity: jest.fn(),
}));

const { Op } = require('sequelize');
const { Customer } = require('../../entities');
const { loadOrdersForCustomersWithCoverage } = require('../customer-orders');
const customer360 = require('../customer-360.service');
const schemas = require('../customer-intelligence.validator');

describe('Customer 360 list filters', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Customer.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
        loadOrdersForCustomersWithCoverage.mockResolvedValue(new Map());
    });

    it('validates channel_type against the Customer model enum and accepts a phone filter', () => {
        expect(schemas.listCustomers.query.validate({ channel_type: 'telegram', phone: '01720000001' }).error)
            .toBeUndefined();
        expect(schemas.listCustomers.query.validate({ channel_type: 'unknown' }).error).toBeDefined();
    });

    it('combines phone and channel filters with search while retaining name OR phone search', async () => {
        const query = {
            search: '+8801720000001',
            phone: '01720000001',
            channel_type: 'messenger',
        };
        await customer360.listCustomers('shop-a', query);

        const { where } = Customer.findAndCountAll.mock.calls[0][0];
        expect(where.shop_id).toBe('shop-a');
        expect(where.channel_type).toBe('messenger');
        expect(where[Op.and]).toHaveLength(2);

        const [searchClause, phoneClause] = where[Op.and];
        const searchAlternatives = searchClause[Op.or];
        expect(searchAlternatives).toContainEqual({ name: { [Op.iLike]: '%+8801720000001%' } });
        expect(searchAlternatives.some((clause) => clause.phone?.[Op.iLike])).toBe(true);

        const phonePatterns = phoneClause[Op.or].map((clause) => clause.phone[Op.iLike]);
        expect(phonePatterns).toEqual(expect.arrayContaining([
            '%01720000001%',
            '%+8801720000001%',
            '%8801720000001%',
            '%1720000001%',
        ]));
    });

    it('escapes LIKE wildcards in the phone-only filter and keeps it tenant-scoped', async () => {
        await customer360.listCustomers('shop-b', { phone: '017%_2' });

        const { where } = Customer.findAndCountAll.mock.calls[0][0];
        expect(where.shop_id).toBe('shop-b');
        expect(where[Op.and]).toEqual([{
            [Op.or]: [{ phone: { [Op.iLike]: '%017\\%\\_2%' } }],
        }]);
        expect(loadOrdersForCustomersWithCoverage).toHaveBeenCalledTimes(1);
    });
});
