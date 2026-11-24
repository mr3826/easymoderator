/**
 * Dashboard Analytics Tests
 * Tests for analytics logging and aggregation
 */
const dashboardAnalytics = require('../dashboard.analytics');
const cacheService = require('../../../utils/cache.service');

// Mock dependencies
jest.mock('../../entities', () => ({
    Analytics: {
        findOrCreate: jest.fn(),
        increment: jest.fn(),
        findOne: jest.fn(),
        findAll: jest.fn()
    }
}));

jest.mock('../../../utils/cache.service', () => ({
    deleteForShop: jest.fn().mockResolvedValue(),
    deletePatternForShop: jest.fn().mockResolvedValue()
}));

const { Analytics } = require('../../entities');

describe('Dashboard Analytics', () => {
    const mockShopId = '550e8400-e29b-41d4-a716-446655440000';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('logEvent', () => {
        it('should create analytics row if not exists', async () => {
            const mockRow = { id: 1, total_messages: 0 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, true]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            const payload = {
                event_type: 'message',
                timestamp: new Date().toISOString()
            };

            await dashboardAnalytics.logEvent(mockShopId, payload);

            expect(Analytics.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({ shop_id: mockShopId })
            }));
        });

        it('should increment total_messages for message events', async () => {
            const mockRow = { id: 1, total_messages: 0 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            const payload = { event_type: 'message' };

            await dashboardAnalytics.logEvent(mockShopId, payload);

            expect(Analytics.increment).toHaveBeenCalledWith(
                { total_messages: 1 },
                expect.any(Object)
            );
        });

        it('should increment llm_calls for AI model events', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            const payload = {
                event_type: 'ai_response',
                metadata: { ai_model: 'gpt-4' }
            };

            await dashboardAnalytics.logEvent(mockShopId, payload);

            expect(Analytics.increment).toHaveBeenCalledWith(
                expect.objectContaining({ llm_calls: 1 }),
                expect.any(Object)
            );
        });

        it('should increment cache_hits for cache events', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            const payload = {
                event_type: 'response',
                metadata: { cache_hit: true }
            };

            await dashboardAnalytics.logEvent(mockShopId, payload);

            expect(Analytics.increment).toHaveBeenCalledWith(
                expect.objectContaining({ cache_hits: 1 }),
                expect.any(Object)
            );
        });

        it('should increment keyword_matches for keyword events', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            const payload = {
                event_type: 'message',
                metadata: { keyword_match: true }
            };

            await dashboardAnalytics.logEvent(mockShopId, payload);

            expect(Analytics.increment).toHaveBeenCalledWith(
                expect.objectContaining({ keyword_matches: 1 }),
                expect.any(Object)
            );
        });

        it('should add cost_estimate when provided', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            const payload = {
                event_type: 'ai_response',
                metadata: { cost_estimate: 0.05 }
            };

            await dashboardAnalytics.logEvent(mockShopId, payload);

            expect(Analytics.increment).toHaveBeenCalledWith(
                expect.objectContaining({ cost_estimate: 0.05 }),
                expect.any(Object)
            );
        });

        it('should invalidate the tenant summary cache family after logging', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            await dashboardAnalytics.logEvent(mockShopId, { event_type: 'message' });

            // Phase 1 D11 cache fix regression pin: the summary lives under
            // the tenant-prefixed `dashboard:summary:{period}` family, NOT the
            // old `dashboard:metrics` key nothing ever read.
            expect(cacheService.deletePatternForShop).toHaveBeenCalledWith(
                mockShopId,
                'dashboard:summary:*'
            );
            expect(cacheService.deleteForShop).not.toHaveBeenCalled();
        });

        it('should still return the row when cache eviction fails', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);
            cacheService.deletePatternForShop.mockRejectedValueOnce(new Error('redis unavailable'));

            const row = await dashboardAnalytics.logEvent(mockShopId, { event_type: 'message' });

            expect(row).toBe(mockRow);
        });

        it('should use current date when timestamp not provided', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);
            Analytics.increment.mockResolvedValue();
            Analytics.findOne.mockResolvedValue(mockRow);

            await dashboardAnalytics.logEvent(mockShopId, { event_type: 'message' });

            const today = new Date().toISOString().split('T')[0];
            expect(Analytics.findOrCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { shop_id: mockShopId, date: today }
                })
            );
        });
    });

    describe('logMetric', () => {
        it('should create analytics row if not exists', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, true]);

            await dashboardAnalytics.logMetric(mockShopId, {
                metric_type: 'response_time',
                value: 150
            });

            expect(Analytics.findOrCreate).toHaveBeenCalled();
        });

        it('should invalidate the tenant summary cache family after logging metric', async () => {
            const mockRow = { id: 1 };
            Analytics.findOrCreate.mockResolvedValue([mockRow, false]);

            await dashboardAnalytics.logMetric(mockShopId, {
                metric_type: 'response_time',
                value: 150
            });

            expect(cacheService.deletePatternForShop).toHaveBeenCalledWith(
                mockShopId,
                'dashboard:summary:*'
            );
            expect(cacheService.deleteForShop).not.toHaveBeenCalled();
        });
    });

    describe('getDashboardAnalytics', () => {
        it('should return aggregated totals', async () => {
            Analytics.findOne.mockResolvedValue({
                total_messages: 1000,
                llm_calls: 500,
                cache_hits: 800,
                keyword_matches: 200,
                cost_estimate: 25.50
            });

            const result = await dashboardAnalytics.getDashboardAnalytics(mockShopId);

            expect(result.totals).toEqual({
                total_messages: 1000,
                llm_calls: 500,
                cache_hits: 800,
                keyword_matches: 200,
                cost_estimate: 25.50
            });
        });

        it('should handle null values', async () => {
            Analytics.findOne.mockResolvedValue({
                total_messages: null,
                llm_calls: null,
                cache_hits: null,
                keyword_matches: null,
                cost_estimate: null
            });

            const result = await dashboardAnalytics.getDashboardAnalytics(mockShopId);

            expect(result.totals.total_messages).toBe(0);
            expect(result.totals.cost_estimate).toBe(0);
        });

        it('should handle empty result', async () => {
            Analytics.findOne.mockResolvedValue(null);

            const result = await dashboardAnalytics.getDashboardAnalytics(mockShopId);

            expect(result.totals).toEqual({
                total_messages: 0,
                llm_calls: 0,
                cache_hits: 0,
                keyword_matches: 0,
                cost_estimate: 0
            });
        });

        it('should query with correct shop filter', async () => {
            Analytics.findOne.mockResolvedValue({
                total_messages: 100,
                llm_calls: 50,
                cache_hits: 80,
                keyword_matches: 20,
                cost_estimate: 2.50
            });

            await dashboardAnalytics.getDashboardAnalytics(mockShopId);

            expect(Analytics.findOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { shop_id: mockShopId }
                })
            );
        });
    });
});
