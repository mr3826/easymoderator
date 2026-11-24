const { Op } = require('sequelize');
const { getCommerceSignals } = require('../dashboard-commerce-signals.service');

describe('Dashboard commerce signals', () => {
    const now = new Date('2026-11-24T00:30:00Z');
    const shopId = 'shop-a';
    const models = () => ({
        BillingLine: { findAll: jest.fn().mockResolvedValue([{ count: '2', amountMinor: '2000' }]) },
        AuditLog: { findAll: jest.fn().mockResolvedValue([{ id: 'audit-1', action: 'ORDER_CONFIRM', resource_type: 'ORDER', created_at: now, metadata: { phone: 'private' }, user_id: 'private' }]) }
    });
    it('scopes reads to the shop, uses the ledger UTC day and projects only safe activity fields', async () => {
        const m = models();
        const result = await getCommerceSignals({ shopId, now, ...m });
        expect(result).toEqual({ deliveredCharges: { dayUtc: '2026-11-24', count: 2, amountMinor: 2000 }, recentActivity: [{ id: 'audit-1', action: 'ORDER_CONFIRM', resourceType: 'ORDER', occurredAt: now.toISOString() }] });
        expect(m.BillingLine.findAll.mock.calls[0][0].where).toEqual({ shop_id: shopId, occurred_at: '2026-11-24', line_kind: 'billable', outcome: 'DELIVERED', currency: 'BDT', amount_minor: { [Op.gt]: 0 } });
        expect(m.AuditLog.findAll.mock.calls[0][0]).toEqual(expect.objectContaining({ where: expect.objectContaining({ shop_id: shopId }), attributes: ['id', 'action', 'resource_type', 'created_at'], limit: 6 }));
    });
    it('distinguishes verified zero from failed source', async () => {
        const m = models();
        m.BillingLine.findAll.mockResolvedValue([{ count: '0', amountMinor: '0' }]);
        m.AuditLog.findAll.mockRejectedValue(new Error('unavailable'));
        expect(await getCommerceSignals({ shopId, now, ...m })).toEqual({ deliveredCharges: { dayUtc: '2026-11-24', count: 0, amountMinor: 0 }, recentActivity: null });
        m.BillingLine.findAll.mockRejectedValue(new Error('unavailable'));
        expect((await getCommerceSignals({ shopId, now, ...m })).deliveredCharges).toBeNull();
    });
    it('never queries unscoped data', async () => {
        const m = models();
        expect(await getCommerceSignals({ now, ...m })).toEqual({ deliveredCharges: null, recentActivity: null });
        expect(m.BillingLine.findAll).not.toHaveBeenCalled();
        expect(m.AuditLog.findAll).not.toHaveBeenCalled();
    });
});
