/**
 * Dashboard Controller Tests
 * Tests for HTTP request handling
 */
const { Op } = require('sequelize');
const { buildBucketWhere } = require('../../order/order-worklist.buckets');

const dashboardController = require('../dashboard.controller');
const dashboardService = require('../dashboard.service');
const dashboardAnalytics = require('../dashboard.analytics');

// Mock dependencies
jest.mock('../dashboard.service');
jest.mock('../dashboard.analytics');
jest.mock('../../entities', () => ({
    Order: {
        count: jest.fn(),
        findAll: jest.fn()
    },
    BillingLine: {
        findAll: jest.fn()
    },
    AuditLog: {
        findAll: jest.fn()
    },
    User: {}
}));
// The queue composes two independently-failing sources; their own suites test
// them. Here we pin the composition contract (doc 05 §3) only.
jest.mock('../dashboard-commerce-signals.service', () => ({
    getCommerceSignals: jest.fn()
}));
jest.mock('../../inbox/inbox-needs-reply.service', () => ({
    getNeedsReplyCount: jest.fn()
}));

const { Order, BillingLine, AuditLog, User } = require('../../entities');
const { getCommerceSignals } = require('../dashboard-commerce-signals.service');
const inboxNeedsReply = require('../../inbox/inbox-needs-reply.service');

describe('Dashboard Controller', () => {
    const mockShopId = '550e8400-e29b-41d4-a716-446655440000';
    const mockUserId = '550e8400-e29b-41d4-a716-446655440001';

    let mockReq;
    let mockRes;
    let mockNext;

    beforeEach(() => {
        jest.clearAllMocks();
        
        mockReq = {
            user: {
                userId: mockUserId,
                shopId: mockShopId
            },
            query: {},
            params: {},
            body: {}
        };
        
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        
        mockNext = jest.fn();
    });

    describe('getDashboardMetricsRest', () => {
        it('should return 200 with metrics data', async () => {
            const mockMetrics = {
                metrics: { totalMessages: 100, ordersToday: 5 },
                period: 30
            };
            dashboardService.getDashboardMetrics.mockResolvedValue(mockMetrics);

            await dashboardController.getDashboardMetricsRest(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: true,
                data: mockMetrics
            });
        });

        it('should use default period of 30 when not specified', async () => {
            dashboardService.getDashboardMetrics.mockResolvedValue({});

            await dashboardController.getDashboardMetricsRest(mockReq, mockRes, mockNext);

            expect(dashboardService.getDashboardMetrics).toHaveBeenCalledWith(
                mockUserId,
                mockShopId,
                30
            );
        });

        it('should use specified period from query', async () => {
            mockReq.query.period = '7';
            dashboardService.getDashboardMetrics.mockResolvedValue({});

            await dashboardController.getDashboardMetricsRest(mockReq, mockRes, mockNext);

            expect(dashboardService.getDashboardMetrics).toHaveBeenCalledWith(
                mockUserId,
                mockShopId,
                7
            );
        });

        it('should call next with error on failure', async () => {
            const error = new Error('Database error');
            dashboardService.getDashboardMetrics.mockRejectedValue(error);

            await dashboardController.getDashboardMetricsRest(mockReq, mockRes, mockNext);

            expect(mockNext).toHaveBeenCalledWith(error);
        });
    });

    describe('getDashboardMetricsById', () => {
        it('should return 200 with metrics when found', async () => {
            mockReq.params.id = mockShopId;
            const mockMetrics = {
                metrics: { totalMessages: 100 },
                chartData: []
            };
            dashboardService.getDashboardMetricsById.mockResolvedValue(mockMetrics);

            await dashboardController.getDashboardMetricsById(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: true,
                data: mockMetrics
            });
        });

        it('should return 404 when metrics not found', async () => {
            mockReq.params.id = 'different-id';
            dashboardService.getDashboardMetricsById.mockResolvedValue(null);

            await dashboardController.getDashboardMetricsById(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(404);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Dashboard not found.'
                }
            });
        });
    });

    describe('getDashboardChart', () => {
        it('should return 200 with chart data', async () => {
            const mockChartData = [
                { date: '2024-01-01', orders: 5 },
                { date: '2024-01-02', orders: 8 }
            ];
            dashboardService.getDashboardChart.mockResolvedValue(mockChartData);

            await dashboardController.getDashboardChart(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: true,
                data: mockChartData
            });
        });

        it('should pass period to service', async () => {
            mockReq.query.period = '7';
            dashboardService.getDashboardChart.mockResolvedValue([]);

            await dashboardController.getDashboardChart(mockReq, mockRes, mockNext);

            expect(dashboardService.getDashboardChart).toHaveBeenCalledWith(mockShopId, 7);
        });
    });

    describe('logAnalyticsEvent', () => {
        it('should return 201 with event_id', async () => {
            const mockRow = { id: 123 };
            dashboardAnalytics.logEvent.mockResolvedValue(mockRow);

            mockReq.body = {
                event_type: 'message',
                timestamp: new Date().toISOString()
            };

            await dashboardController.logAnalyticsEvent(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(201);
            expect(mockRes.json).toHaveBeenCalledWith({
                event_id: '123',
                logged: true
            });
        });

        it('should pass payload to analytics service', async () => {
            dashboardAnalytics.logEvent.mockResolvedValue({ id: 1 });
            mockReq.body = { event_type: 'message' };

            await dashboardController.logAnalyticsEvent(mockReq, mockRes, mockNext);

            expect(dashboardAnalytics.logEvent).toHaveBeenCalledWith(
                mockShopId,
                mockReq.body
            );
        });
    });

    describe('logAnalyticsMetric', () => {
        it('should return 201 when recorded', async () => {
            dashboardAnalytics.logMetric.mockResolvedValue();
            mockReq.body = {
                metric_type: 'response_time',
                value: 150
            };

            await dashboardController.logAnalyticsMetric(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(201);
            expect(mockRes.json).toHaveBeenCalledWith({ recorded: true });
        });
    });

    describe('getAnalyticsDashboard', () => {
        it('should return aggregated analytics data', async () => {
            const mockTotals = {
                total_messages: 1000,
                llm_calls: 500,
                cache_hits: 800,
                keyword_matches: 200,
                cost_estimate: 25.50
            };
            dashboardAnalytics.getDashboardAnalytics.mockResolvedValue({
                totals: mockTotals
            });

            await dashboardController.getAnalyticsDashboard(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
                total_messages: 1000,
                llm_calls: 500,
                cache_hits: 800,
                keyword_matches: 200,
                cost_estimate: 25.50
            }));
        });

        it('should include placeholder metrics', async () => {
            dashboardAnalytics.getDashboardAnalytics.mockResolvedValue({
                totals: {
                    total_messages: 0,
                    llm_calls: 0,
                    cache_hits: 0,
                    keyword_matches: 0,
                    cost_estimate: 0
                }
            });

            await dashboardController.getAnalyticsDashboard(mockReq, mockRes, mockNext);

            expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
                avg_response_time_ms: 0,
                intent_breakdown: {},
                handover_rate: 0,
                customer_satisfaction: 0,
                error_rate: 0
            }));
        });
    });

    describe('getTodayQueue (Phase 1 C3 — worklist-v1, doc 05 §3)', () => {
        const needsReplyFixture = {
            count: 2, scanned: 5, cap: 200,
            coverageComplete: true, generated_at: '2026-11-24T10:00:00.000Z'
        };

        beforeEach(() => {
            Order.count.mockResolvedValue(0);
            Order.findAll.mockResolvedValue([]);
            inboxNeedsReply.getNeedsReplyCount.mockResolvedValue(needsReplyFixture);
            getCommerceSignals.mockResolvedValue({ deliveredCharges: null, recentActivity: null });
        });

        it('pins pending_payment to the UNCHANGED predicate and dispatch to the authoritative to_pack bucket', async () => {
            await dashboardController.getTodayQueue(mockReq, mockRes, mockNext);

            expect(Order.count).toHaveBeenCalledTimes(2);
            const [pendingPaymentWhere, readyToDispatchWhere] = Order.count.mock.calls.map((call) => call[0].where);
            expect(pendingPaymentWhere).toEqual({
                shop_id: mockShopId,
                payment_status: 'pending',
                order_status: { [Op.notIn]: ['cancelled', 'refunded'] }
            });
            expect(readyToDispatchWhere).toEqual({
                [Op.and]: [{ shop_id: mockShopId }, buildBucketWhere('to_pack')]
            });
        });

        it('answers with the C3 contract shape and NO deprecated unread_count', async () => {
            Order.count.mockResolvedValueOnce(5).mockResolvedValueOnce(3);

            await dashboardController.getTodayQueue(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: true,
                data: expect.objectContaining({
                    commerce_signals: { deliveredCharges: null, recentActivity: null },
                    needs_reply: needsReplyFixture,
                    predicate_version: 'worklist-v1',
                    pending_payment_count: 5,
                    ready_to_dispatch_count: 3,
                    at_risk_orders: []
                })
            });
            expect(mockRes.json.mock.calls[0][0].data).not.toHaveProperty('unread_count');
        });

        it('maps the needs_reply sub-source to null (never 5xx) when the C1 service fails', async () => {
            inboxNeedsReply.getNeedsReplyCount.mockRejectedValue(new Error('db down'));

            await dashboardController.getTodayQueue(mockReq, mockRes, mockNext);

            expect(mockNext).not.toHaveBeenCalled();
            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json.mock.calls[0][0].data.needs_reply).toBeNull();
        });

        it('samples the authoritative needs_action bucket with a PII-free projection', async () => {
            // DE-5 regression guard: a real Sequelize instance on the
            // underscored:true Order model keys the timestamp as `updatedAt`
            // (the attribute), never `updated_at` (the column) — so the
            // fixture must carry ONLY the attribute key. The old `updated_at`
            // fixture shape matched the buggy read and masked the defect:
            // against real rows it shipped updatedAt:null.
            Order.findAll.mockResolvedValue([
                {
                    id: 'order-1',
                    order_number: 'ORD-042',
                    order_status: 'confirmed',
                    delivery_tracking_code: 'TRACK123',
                    updatedAt: new Date('2026-11-24T09:30:00Z'),
                    // Fields a loose SELECT might still return — the projection must drop them:
                    customer_name: 'Rahim Uddin',
                    customer_phone: '01711111111'
                }
            ]);

            await dashboardController.getTodayQueue(mockReq, mockRes, mockNext);

            const options = Order.findAll.mock.calls[0][0];
            expect(options.where).toEqual({
                [Op.and]: [{ shop_id: mockShopId }, buildBucketWhere('needs_action')]
            });
            // DE-5: the timestamp must be selected by its MODEL attribute key
            // (`updatedAt`), not the column name (`updated_at`) — the latter
            // is what made real instances return no value.
            expect(options.attributes).toEqual(['id', 'order_number', 'order_status', 'delivery_tracking_code', 'updatedAt']);
            expect(options.attributes).not.toContain('updated_at');
            expect(options.attributes).not.toContain('customer_name');
            expect(options.attributes).not.toContain('customer_phone');
            expect(options.limit).toBe(10);
            expect(options.order).toEqual([['updatedAt', 'DESC']]);

            const payload = mockRes.json.mock.calls[0][0];
            expect(payload.data.at_risk_orders).toEqual([
                {
                    id: 'order-1',
                    orderNumber: 'ORD-042',
                    status: 'confirmed',
                    tracking_id: 'TRACK123',
                    updatedAt: '2026-11-24T09:30:00.000Z'
                }
            ]);
            // doc 05 §3 contract: at_risk_orders[].updatedAt is a non-null
            // ISO string through the projection path (DE-5 shipped null).
            expect(payload.data.at_risk_orders[0].updatedAt).toEqual(expect.any(String));
            expect(payload.data.at_risk_orders[0].updatedAt).not.toBeNull();
            expect(new Date(payload.data.at_risk_orders[0].updatedAt).toISOString())
                .toBe('2026-11-24T09:30:00.000Z');
            const serialized = JSON.stringify(payload);
            expect(serialized).not.toContain('customer_name');
            expect(serialized).not.toContain('customer_phone');
            expect(serialized).not.toContain('Rahim Uddin');
            expect(serialized).not.toContain('01711111111');
        });

        it('falls back orderNumber to the id and keeps tracking null-safe', async () => {
            Order.findAll.mockResolvedValue([
                // Attribute-key form (DE-5): real instances expose `updatedAt`;
                // a null there must still project null, never "null"/Invalid Date.
                { id: 'order-9', order_status: 'processing', delivery_tracking_code: null, updatedAt: null }
            ]);

            await dashboardController.getTodayQueue(mockReq, mockRes, mockNext);

            expect(mockRes.json.mock.calls[0][0].data.at_risk_orders).toEqual([
                { id: 'order-9', orderNumber: 'order-9', status: 'processing', tracking_id: null, updatedAt: null }
            ]);
        });

        it('fails the queue (next/error) when the authoritative order reads fail', async () => {
            const error = new Error('db down');
            Order.count.mockRejectedValue(error);

            await dashboardController.getTodayQueue(mockReq, mockRes, mockNext);

            expect(mockNext).toHaveBeenCalledWith(error);
            expect(mockRes.status).not.toHaveBeenCalledWith(200);
        });

        it('passes tenant-scoped models into commerce signals and returns them verbatim', async () => {
            const signals = { deliveredCharges: { dayUtc: '2026-11-24', count: 1, amountMinor: 1000 }, recentActivity: [] };
            getCommerceSignals.mockResolvedValue(signals);

            await dashboardController.getTodayQueue(mockReq, mockRes, mockNext);

            expect(getCommerceSignals).toHaveBeenCalledWith({ shopId: mockShopId, BillingLine, AuditLog, User });
            expect(mockRes.json.mock.calls[0][0].data.commerce_signals).toEqual(signals);
        });
    });

    describe('Legacy getDashboardMetrics', () => {
        it('should still work for backward compatibility', async () => {
            const mockMetrics = { metrics: { ordersToday: 5 } };
            dashboardService.getDashboardMetrics.mockResolvedValue(mockMetrics);

            await dashboardController.getDashboardMetrics(mockReq, mockRes, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: true,
                data: mockMetrics
            });
        });
    });
});
