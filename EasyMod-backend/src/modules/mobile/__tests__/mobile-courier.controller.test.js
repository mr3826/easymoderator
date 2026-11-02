'use strict';

jest.mock('../../order/order.service', () => ({
    bookForOrder: jest.fn(),
}));

const mockRedisClient = {
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
};

jest.mock('../../entities', () => ({
    AuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-courier-1' }),
    },
    Order: {
        findOne: jest.fn(),
        findAndCountAll: jest.fn(),
    },
    DeliveryTracking: {
        findOne: jest.fn(),
    },
}));

jest.mock('../../../utils/redis-client', () => ({
    getRedisClient: jest.fn(() => mockRedisClient),
}));

const orderService = require('../../order/order.service');
const { AuditLog, Order, DeliveryTracking } = require('../../entities');
const controller = require('../mobile-courier.controller');

function response() {
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    };
}

describe('mobile Courier & Problem Center controller', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisClient.set.mockResolvedValue('OK');
    });

    describe('bookCourier', () => {
        test('returns 404 if order does not exist or does not belong to shop', async () => {
            const res = response();
            Order.findOne.mockResolvedValue(null);

            let thrownError = null;
            try {
                await controller.bookCourier({
                    params: { orderId: 'ord-unknown' },
                    shop: { id: 'shop-1' },
                    user: { userId: 'user-1' },
                    body: { provider: 'steadfast' },
                }, res, (err) => { thrownError = err; });
            } catch (err) {
                thrownError = err;
            }

            expect(thrownError).toBeTruthy();
            expect(thrownError.status).toBe(404);
            expect(thrownError.code).toBe('NOT_FOUND');
        });

        test('successfully books courier and records audit log', async () => {
            const res = response();
            const mockOrder = {
                id: 'ord-100',
                shop_id: 'shop-1',
                order_number: 'ORD-100',
            };
            Order.findOne.mockResolvedValue(mockOrder);
            orderService.bookForOrder.mockResolvedValue({
                tracking_code: 'SF-TRK-999',
                consignment_id: 'CS-888',
                provider: 'steadfast',
                status: 'booked',
            });

            await controller.bookCourier({
                params: { orderId: 'ord-100' },
                shop: { id: 'shop-1' },
                user: { userId: 'user-1' },
                body: { provider: 'steadfast', note: 'Fragile package' },
                headers: { 'x-idempotency-key': 'idem-book-1' },
            }, res, jest.fn());

            expect(orderService.bookForOrder).toHaveBeenCalledWith(mockOrder, expect.objectContaining({
                shopId: 'shop-1',
                provider: 'steadfast',
                trigger: 'MANUAL',
                overrides: expect.objectContaining({
                    note: 'Fragile package',
                }),
            }));

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                data: expect.objectContaining({
                    tracking_id: 'SF-TRK-999',
                    consignment_id: 'CS-888',
                    provider: 'steadfast',
                    status: 'booked',
                }),
            }));

            expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
                action: 'COURIER_BOOKED',
                resource_id: 'ord-100',
                shop_id: 'shop-1',
                user_id: 'user-1',
                metadata: expect.objectContaining({
                    source: 'MOBILE',
                    provider: 'steadfast',
                    tracking_id: 'SF-TRK-999',
                }),
            }));
        });

        test('routes an idempotent tracking replay through canonical booking without relabeling its provider', async () => {
            const res = response();
            const mockOrder = {
                id: 'ord-101',
                shop_id: 'shop-1',
                order_number: 'ORD-101',
                delivery_provider: 'pathao',
                delivery_consignment_id: 'CN-101',
                delivery_tracking_code: 'TRK-101',
            };
            Order.findOne.mockResolvedValue(mockOrder);
            mockRedisClient.set.mockResolvedValue(null);
            orderService.bookForOrder.mockResolvedValue({
                provider: 'pathao',
                consignment_id: 'CN-101',
                tracking_code: 'TRK-101',
                status: 'booked',
            });

            await controller.bookCourier({
                params: { orderId: 'ord-101' },
                shop: { id: 'shop-1' },
                user: { userId: 'user-1' },
                body: { provider: 'steadfast' },
                headers: { 'x-idempotency-key': 'idem-replay-101' },
            }, res, jest.fn());

            expect(orderService.bookForOrder).toHaveBeenCalledWith(mockOrder, expect.objectContaining({
                provider: 'steadfast',
            }));
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    provider: 'pathao',
                    tracking_id: 'TRK-101',
                    idempotencyReplay: true,
                }),
            }));
            expect(AuditLog.create).not.toHaveBeenCalled();
        });

        test('returns 409 COURIER_SETUP_REQUIRED when provider setup is missing', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({ id: 'ord-100', shop_id: 'shop-1' });
            orderService.bookForOrder.mockResolvedValue({
                blocked: true,
                status: 'courier_setup_required',
                missing: ['api_key', 'secret_key'],
                provider: 'pathao',
            });

            await controller.bookCourier({
                params: { orderId: 'ord-100' },
                shop: { id: 'shop-1' },
                user: { userId: 'user-1' },
                body: { provider: 'pathao' },
            }, res, jest.fn());

            expect(res.status).toHaveBeenCalledWith(409);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: expect.objectContaining({
                    code: 'COURIER_SETUP_REQUIRED',
                    provider: 'pathao',
                    missing: ['api_key', 'secret_key'],
                }),
            }));
        });

        test('returns 409 ORDER_CONFIDENCE_HOLD when order needs verification', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({ id: 'ord-100', shop_id: 'shop-1' });
            orderService.bookForOrder.mockResolvedValue({
                blocked: true,
                status: 'confidence_hold',
                decision: 'HOLD',
                reasons: ['HIGH_RTO_RISK'],
                decision_version: '2.0',
            });

            await controller.bookCourier({
                params: { orderId: 'ord-100' },
                shop: { id: 'shop-1' },
                user: { userId: 'user-1' },
                body: { provider: 'steadfast' },
            }, res, jest.fn());

            expect(res.status).toHaveBeenCalledWith(409);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: expect.objectContaining({
                    code: 'ORDER_CONFIDENCE_HOLD',
                    reasons: ['HIGH_RTO_RISK'],
                }),
            }));
        });

        test('returns 502 COURIER_BOOKING_FAILED when courier API fails', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({ id: 'ord-100', shop_id: 'shop-1' });
            orderService.bookForOrder.mockResolvedValue({
                failed: true,
                reason: 'Invalid delivery address postal code',
            });

            await controller.bookCourier({
                params: { orderId: 'ord-100' },
                shop: { id: 'shop-1' },
                user: { userId: 'user-1' },
                body: { provider: 'steadfast' },
            }, res, jest.fn());

            expect(res.status).toHaveBeenCalledWith(502);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: expect.objectContaining({
                    code: 'COURIER_BOOKING_FAILED',
                    message: 'Invalid delivery address postal code',
                }),
            }));
        });

        test('does not report a successful booking when tracking identity is blank', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({ id: 'ord-blank-tracking', shop_id: 'shop-1' });
            orderService.bookForOrder.mockResolvedValue({
                provider: 'pathao',
                tracking_code: '  ',
                consignment_id: null,
            });

            await controller.bookCourier({
                params: { orderId: 'ord-blank-tracking' },
                shop: { id: 'shop-1' },
                user: { userId: 'user-1' },
                body: { provider: 'steadfast' },
            }, res, jest.fn());

            expect(res.status).toHaveBeenCalledWith(409);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: expect.objectContaining({
                    code: 'COURIER_TRACKING_UNAVAILABLE',
                    message: expect.stringContaining('Do not book again'),
                }),
            }));
            expect(AuditLog.create).not.toHaveBeenCalled();
        });
    });

    describe('getProblemParcels', () => {
        test('queries problem parcels with default problem statuses and pagination', async () => {
            const res = response();
            Order.findAndCountAll.mockResolvedValue({
                count: 1,
                rows: [
                    {
                        id: 'ord-prob-1',
                        order_number: 'ORD-777',
                        customer_name: 'Tanvir Ahmed',
                        customer_phone: '01711223344',
                        total: 1500,
                        payment_method: 'cod',
                        payment_status: 'pending',
                        delivery_provider: 'steadfast',
                        delivery_consignment_id: 'CS-777',
                        delivery_tracking_code: 'TRK-777',
                        delivery_status: 'failed_delivery',
                        order_status: 'confirmed',
                        delivery_address: 'Mirpur 10, Dhaka',
                        delivery_notes: 'Customer unreachable after 3 attempts',
                        created_at: new Date('2026-10-01T10:00:00Z'),
                        updated_at: new Date('2026-10-02T12:00:00Z'),
                    },
                ],
            });

            await controller.getProblemParcels({
                shop: { id: 'shop-1' },
                query: { page: '1', limit: '20' },
            }, res, jest.fn());

            expect(Order.findAndCountAll).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({
                    shop_id: 'shop-1',
                }),
                limit: 20,
                offset: 0,
            }));

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    parcels: [
                        expect.objectContaining({
                            order_id: 'ord-prob-1',
                            order_number: 'ORD-777',
                            customer_name: 'Tanvir Ahmed',
                            customer_phone: '01711223344',
                            total_amount: 1500,
                            cod_amount: 1500,
                            delivery_status: 'failed_delivery',
                            problem_reason: 'Customer unreachable after 3 attempts',
                        }),
                    ],
                    pagination: {
                        page: 1,
                        limit: 20,
                        total: 1,
                        hasNextPage: false,
                    },
                }),
            }));
        });
    });

    describe('getDeliveryTracking', () => {
        test('returns tracking timeline with provider history', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({
                id: 'ord-trk-1',
                shop_id: 'shop-1',
                order_number: 'ORD-555',
                customer_name: 'Rafiqul Islam',
                customer_phone: '01811223344',
                total: 2200,
                payment_method: 'cash_on_delivery',
                payment_status: 'pending',
                delivery_provider: 'pathao',
                delivery_consignment_id: 'CN-555',
                delivery_tracking_code: 'PT-555',
                delivery_status: 'in_transit',
                delivery_address: 'Gulshan 2, Dhaka',
                created_at: new Date(),
                updated_at: new Date(),
            });

            DeliveryTracking.findOne.mockResolvedValue({
                provider: 'pathao',
                tracking_number: 'PT-555',
                current_status: 'in_transit',
                estimated_delivery: new Date('2026-10-06T18:00:00Z'),
                status_history: [
                    { status: 'booked', timestamp: '2026-10-04T10:00:00Z', location: 'Dhaka Hub' },
                    { status: 'in_transit', timestamp: '2026-10-05T08:00:00Z', location: 'On the way' },
                ],
            });

            await controller.getDeliveryTracking({
                params: { orderId: 'ord-trk-1' },
                shop: { id: 'shop-1' },
            }, res, jest.fn());

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    order_id: 'ord-trk-1',
                    order_number: 'ORD-555',
                    provider: 'pathao',
                    tracking_number: 'PT-555',
                    current_status: 'in_transit',
                    total_amount: 2200,
                    cod_amount: 2200,
                    status_history: expect.arrayContaining([
                        expect.objectContaining({ status: 'booked' }),
                        expect.objectContaining({ status: 'in_transit' }),
                    ]),
                    cod_derived_note: expect.stringContaining('recorded payment method'),
                }),
            }));
        });

        test('does not invent a booked history or COD amount without persisted delivery/payment facts', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({
                id: 'ord-unbooked',
                shop_id: 'shop-1',
                order_number: 'ORD-UNBOOKED',
                total: 2200,
                payment_method: 'bkash',
                payment_status: 'pending',
                delivery_status: null,
                delivery_provider: null,
                delivery_consignment_id: null,
                delivery_tracking_code: null,
            });
            DeliveryTracking.findOne.mockResolvedValue(null);

            await controller.getDeliveryTracking({
                params: { orderId: 'ord-unbooked' },
                shop: { id: 'shop-1' },
            }, res, jest.fn());

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    current_status: 'not_booked',
                    status_history: [],
                    total_amount: 2200,
                    cod_amount: 0,
                }),
            }));
        });

        test('returns no expected COD amount when the recorded method is unknown', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({
                id: 'ord-unknown-payment',
                shop_id: 'shop-1',
                order_number: 'ORD-UNKNOWN',
                total: 2200,
                payment_method: null,
                payment_status: 'pending',
                delivery_status: 'booked',
            });
            DeliveryTracking.findOne.mockResolvedValue({
                provider: 'pathao',
                tracking_number: 'PT-UNKNOWN-PAYMENT',
                current_status: 'booked',
                status_history: [{ status: 'booked', timestamp: new Date().toISOString() }],
            });

            await controller.getDeliveryTracking({
                params: { orderId: 'ord-unknown-payment' },
                shop: { id: 'shop-1' },
            }, res, jest.fn());

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({ total_amount: 2200, cod_amount: null }),
            }));
        });

        test('returns 404 if order is not found for shop', async () => {
            const res = response();
            Order.findOne.mockResolvedValue(null);

            let thrownError = null;
            try {
                await controller.getDeliveryTracking({
                    params: { orderId: 'ord-missing' },
                    shop: { id: 'shop-1' },
                }, res, (err) => { thrownError = err; });
            } catch (err) {
                thrownError = err;
            }

            expect(thrownError).toBeTruthy();
            expect(thrownError.status).toBe(404);
        });

        test('returns a safe unavailable error when the tracking-store read fails', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({
                id: 'ord-tracking-read-error',
                shop_id: 'shop-1',
                order_number: 'ORD-READ-ERROR',
                delivery_provider: 'pathao',
                delivery_tracking_code: 'PERSISTED-TRACKING',
                delivery_status: 'in_transit',
            });
            DeliveryTracking.findOne.mockRejectedValue(new Error('database connection details'));
            let thrownError = null;

            await controller.getDeliveryTracking({
                params: { orderId: 'ord-tracking-read-error' },
                shop: { id: 'shop-1' },
            }, res, (error) => { thrownError = error; });

            expect(thrownError).toMatchObject({
                status: 503,
                code: 'COURIER_TRACKING_READ_UNAVAILABLE',
                message: expect.not.stringContaining('database connection details'),
            });
            expect(res.json).not.toHaveBeenCalled();
        });

        test('uses only complete persisted order identity when the tracking row is absent', async () => {
            const res = response();
            Order.findOne.mockResolvedValue({
                id: 'ord-persisted-fallback',
                shop_id: 'shop-1',
                order_number: 'ORD-FALLBACK',
                delivery_provider: ' PATHAO ',
                delivery_consignment_id: ' CN-FALLBACK ',
                delivery_tracking_code: ' PT-FALLBACK ',
                delivery_status: 'in_transit',
            });
            DeliveryTracking.findOne.mockResolvedValue(null);

            await controller.getDeliveryTracking({
                params: { orderId: 'ord-persisted-fallback' },
                shop: { id: 'shop-1' },
                query: { provider: 'steadfast', tracking_number: 'STALE-CALLER-VALUE' },
            }, res, jest.fn());

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                data: expect.objectContaining({
                    provider: 'pathao',
                    tracking_number: 'PT-FALLBACK',
                    consignment_id: 'CN-FALLBACK',
                    current_status: 'in_transit',
                    status_history: [],
                }),
            }));
            expect(JSON.stringify(res.json.mock.calls)).not.toContain('STALE-CALLER-VALUE');
        });

        test.each([
            ['invalid provider', {
                delivery_provider: 'unregistered-courier',
                delivery_tracking_code: 'TRK-INVALID-PROVIDER',
                delivery_status: 'in_transit',
            }],
            ['missing tracking reference', {
                delivery_provider: 'pathao',
                delivery_tracking_code: '  ',
                delivery_consignment_id: null,
                delivery_status: 'booked',
            }],
        ])('rejects %s in denormalized fallback instead of returning stale identity', async (_label, fields) => {
            const res = response();
            Order.findOne.mockResolvedValue({
                id: 'ord-invalid-fallback',
                shop_id: 'shop-1',
                order_number: 'ORD-INVALID-FALLBACK',
                ...fields,
            });
            DeliveryTracking.findOne.mockResolvedValue(null);
            let thrownError = null;

            await controller.getDeliveryTracking({
                params: { orderId: 'ord-invalid-fallback' },
                shop: { id: 'shop-1' },
                query: { provider: 'steadfast', tracking_number: 'CALLER-TRACKING' },
            }, res, (error) => { thrownError = error; });

            expect(thrownError).toMatchObject({
                status: 503,
                code: 'COURIER_TRACKING_UNAVAILABLE',
            });
            expect(res.json).not.toHaveBeenCalled();
        });
    });
});
