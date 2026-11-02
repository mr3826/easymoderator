'use strict';

/**
 * Unit tests for the activation/retention growth-metrics service.
 * Shop, Order and the Redis cache are mocked — no DB.
 */

const mockShop = {
    findByPk: jest.fn(),
    findAll: jest.fn(),
    update: jest.fn(),
    sequelize: {
        getDialect: jest.fn(),
        escape: jest.fn(),
        literal: jest.fn(),
    },
};
const mockOrder = { count: jest.fn() };
const mockCache = { set: jest.fn(), persist: jest.fn(), del: jest.fn() };
const mockProspectService = { markLinkedShopsActivated: jest.fn() };
const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };
const { Op } = require('sequelize');

jest.mock('src/modules/shop/shop.entity', () => mockShop);
jest.mock('src/modules/order/order.entity', () => mockOrder);
jest.mock('src/config/redis', () => ({ cacheRedis: mockCache }));
jest.mock('src/modules/growth-os/growth-os.prospect.service', () => mockProspectService);

const { recordActivation, getGrowthMetrics } = require('src/modules/analytics/growth-metrics.service');

describe('growth-metrics.service', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        delete mockShop.sequelize.transaction;
        mockShop.sequelize.getDialect.mockReturnValue('sqlite');
        mockProspectService.markLinkedShopsActivated.mockResolvedValue({ activated: 0 });
    });

    describe('recordActivation', () => {
        it('records first AI reply as an operational milestone and preserves existing settings', async () => {
            mockCache.set.mockResolvedValue('OK');
            mockCache.persist.mockResolvedValue(1);
            const update = jest.fn().mockResolvedValue();
            mockShop.findByPk.mockResolvedValue({ settings: { businessInfo: { x: 1 } }, update });

            await recordActivation('shop-1', 'conv-9');

            expect(mockCache.set).toHaveBeenCalledWith('shop:first-ai-reply:shop-1', '1', 'EX', 300, 'NX');
            expect(update).toHaveBeenCalledTimes(1);
            expect(mockProspectService.markLinkedShopsActivated).toHaveBeenCalledWith({
                shopId: 'shop-1',
                actorUserId: null,
                transaction: null,
            });
            const arg = update.mock.calls[0][0];
            expect(arg.settings.first_ai_reply.occurred_at).toBeTruthy();
            expect(arg.settings.first_ai_reply.first_conversation_id).toBe('conv-9');
            expect(arg.settings.businessInfo).toEqual({ x: 1 }); // not clobbered
            expect(mockCache.persist).toHaveBeenCalledWith('shop:first-ai-reply:shop-1');
            expect(mockCache.del).not.toHaveBeenCalled();
        });

        it('re-reads settings under the row lock before the non-Postgres merge', async () => {
            mockCache.set.mockResolvedValue('OK');
            mockCache.persist.mockResolvedValue(1);
            const staleShop = {
                settings: {
                    rto_network: { contribute: true, enforce: false },
                    merchant_preferences: { locale: 'en' },
                },
                update: jest.fn(),
            };
            const freshShop = {
                settings: {
                    rto_network: { contribute: false, enforce: true, version: 3 },
                    merchant_preferences: { locale: 'bn', currency: 'BDT' },
                    ai: { automation_mode: 'AUTO', llm_model: 'latest-model' },
                },
                update: jest.fn().mockResolvedValue(undefined),
            };
            mockShop.sequelize.transaction = jest.fn(async (callback) => callback(mockTransaction));
            mockShop.findByPk
                .mockResolvedValueOnce(staleShop)
                .mockResolvedValueOnce(freshShop);

            await recordActivation('shop-1', 'conv-merge', 'actor-1');

            expect(mockShop.findByPk).toHaveBeenCalledTimes(2);
            expect(mockShop.findByPk.mock.calls[1][1]).toEqual({
                transaction: mockTransaction,
                lock: 'UPDATE',
            });
            expect(staleShop.update).not.toHaveBeenCalled();
            const saved = freshShop.update.mock.calls[0][0].settings;
            expect(saved).toEqual(expect.objectContaining({
                rto_network: freshShop.settings.rto_network,
                merchant_preferences: freshShop.settings.merchant_preferences,
                ai: freshShop.settings.ai,
                first_ai_reply: expect.objectContaining({
                    first_conversation_id: 'conv-merge',
                    actor_user_id: 'actor-1',
                }),
            }));
            expect(freshShop.update.mock.calls[0][1]).toEqual({ transaction: mockTransaction });
        });

        it('patches only the activation path with a conditional JSON update on Postgres', async () => {
            mockShop.sequelize.getDialect.mockReturnValue('postgres');
            mockShop.sequelize.escape.mockReturnValue("'{\"activated_at\":\"safe\"}'");
            mockShop.sequelize.literal.mockImplementation(value => ({ value }));
            mockShop.update.mockResolvedValue([1]);
            const update = jest.fn();
            mockShop.findByPk.mockResolvedValue({ settings: { businessInfo: { x: 1 } }, update });
            mockCache.set.mockResolvedValue('OK');
            mockCache.persist.mockResolvedValue(1);

            await recordActivation('shop-1', 'conv-9');

            expect(mockShop.update).toHaveBeenCalledTimes(1);
            expect(mockShop.update.mock.calls[0][0].settings.value).toContain("'first_ai_reply'");
            expect(mockShop.update.mock.calls[0][1].where[Op.and][0]).toEqual({ id: 'shop-1' });
            expect(mockShop.update.mock.calls[0][1].where[Op.and][1].value).toContain('first_ai_reply');
            expect(update).not.toHaveBeenCalled();
            expect(mockCache.persist).toHaveBeenCalledWith('shop:first-ai-reply:shop-1');
        });

        it('skips entirely when the NX claim was already taken', async () => {
            mockCache.set.mockResolvedValue(null); // key already exists
            await recordActivation('shop-1');
            expect(mockShop.findByPk).not.toHaveBeenCalled();
        });

        it('does not overwrite an existing activation timestamp', async () => {
            mockCache.set.mockResolvedValue('OK');
            const update = jest.fn();
            mockShop.findByPk.mockResolvedValue({
                settings: { first_ai_reply: { occurred_at: '2026-01-01T00:00:00Z' } },
                update,
            });
            await recordActivation('shop-1');
            expect(update).not.toHaveBeenCalled();
            expect(mockCache.persist).toHaveBeenCalledWith('shop:first-ai-reply:shop-1');
        });

        it('releases a temporary claim when the DB write fails', async () => {
            mockCache.set.mockResolvedValue('OK');
            mockCache.del.mockResolvedValue(1);
            const update = jest.fn().mockRejectedValue(new Error('db down'));
            mockShop.findByPk.mockResolvedValue({ settings: {}, update });

            await expect(recordActivation('shop-1')).resolves.toBeUndefined();

            expect(mockCache.del).toHaveBeenCalledWith('shop:first-ai-reply:shop-1');
            expect(mockCache.persist).not.toHaveBeenCalled();
        });

        it('never throws when redis/db fails', async () => {
            mockCache.set.mockRejectedValue(new Error('redis down'));
            await expect(recordActivation('shop-1')).resolves.toBeUndefined();
        });

        it('is a no-op without a shopId', async () => {
            await recordActivation(null);
            expect(mockCache.set).not.toHaveBeenCalled();
        });
    });

    describe('getGrowthMetrics', () => {
        it('computes activation + retention and sorts by recent orders', async () => {
            mockShop.findAll.mockResolvedValue([
                { id: 's1', shop_name: 'Shop One', settings: { first_ai_reply: { occurred_at: '2026-05-20T00:00:00Z' } }, created_at: new Date('2026-05-18T00:00:00Z') },
                { id: 's2', shop_name: 'Shop Two', settings: {}, created_at: new Date('2026-05-25T00:00:00Z') },
            ]);
            // One grouped count per time window, regardless of shop count.
            mockOrder.count
                .mockResolvedValueOnce([{ shop_id: 's1', count: 3 }])
                .mockResolvedValueOnce([]);

            const result = await getGrowthMetrics({ now: new Date('2026-05-31T00:00:00Z') });

            expect(result.totals.shops).toBe(2);
            expect(result.totals.firstAiReplies).toBe(1);
            expect(result.totals.firstAiReplyRate).toBe(50);
            expect(result.totals.retainedThisWeek).toBe(1);
            expect(result.totals.retentionRate).toBe(100); // 1 of 1 activated shops retained

            // Sorted by ordersLast7d desc → s1 (3 orders) first
            expect(result.shops[0].shopId).toBe('s1');
            expect(result.shops[0].firstAiReplyRecorded).toBe(true);
            expect(result.shops[0].daysToFirstAiReply).toBe(2); // May 18 → May 20
            expect(result.shops[1].shopId).toBe('s2');
            expect(result.shops[1].firstAiReplyRecorded).toBe(false);
            expect(result.shops[1].retainedThisWeek).toBe(false);
            expect(mockOrder.count).toHaveBeenCalledTimes(2);
        });

        it('calculates retention only from the activated cohort', async () => {
            mockShop.findAll.mockResolvedValue([
                { id: 'activated', shop_name: 'Activated', settings: { first_ai_reply: { occurred_at: '2026-05-20T00:00:00Z' } }, created_at: new Date('2026-05-18T00:00:00Z') },
                { id: 'not-activated', shop_name: 'Not Activated', settings: {}, created_at: new Date('2026-05-18T00:00:00Z') },
            ]);
            mockOrder.count
                .mockResolvedValueOnce([{ shop_id: 'not-activated', count: 5 }])
                .mockResolvedValueOnce([]);

            const result = await getGrowthMetrics({ now: new Date('2026-05-31T00:00:00Z') });

            expect(result.totals.firstAiReplies).toBe(1);
            expect(result.totals.retainedThisWeek).toBe(0);
            expect(result.totals.retentionRate).toBe(0);
        });

        it('handles zero shops without dividing by zero', async () => {
            mockShop.findAll.mockResolvedValue([]);
            const result = await getGrowthMetrics();
            expect(result.totals.shops).toBe(0);
            expect(result.totals.firstAiReplyRate).toBe(0);
            expect(result.totals.retentionRate).toBe(0);
            expect(result.shops).toEqual([]);
            expect(mockOrder.count).not.toHaveBeenCalled();
        });
    });
});
