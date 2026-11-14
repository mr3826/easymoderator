/**
 * Order Service Tests
 * Comprehensive test suite for order creation, management, and business logic
 */

var mockOrderLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
const { Op } = require('sequelize');
const { AppError } = require('../../../utils/AppError');

// Mock entities before requiring service
jest.mock('../../entities', () => ({
    Order: {
        findOne: jest.fn(),
        findAll: jest.fn(),
        findAndCountAll: jest.fn(),
        create: jest.fn()
    },
    OrderItem: {
        findAll: jest.fn(),
        create: jest.fn()
    },
    Product: {
        findAll: jest.fn(),
        findOne: jest.fn(),
        decrement: jest.fn(),
        increment: jest.fn()
    },
    Customer: {
        findOne: jest.fn()
    },
    UserShop: {
        findOne: jest.fn()
    },
    OrderReturn: {
        create: jest.fn()
    },
    Channel: {
        findOne: jest.fn()
    }
}));

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (cb) => {
            const t = { commit: jest.fn(), rollback: jest.fn() };
            if (typeof cb === 'function') return cb(t);
            return t;
        }),
        query: jest.fn(),
        getDialect: jest.fn()
    }
}));

jest.mock('../../subscription/subscription.service', () => ({
    checkOrderLimit: jest.fn(),
    trackUsage: jest.fn()
}));

jest.mock('../../rto-shield/rto-shield.service', () => ({
    checkPhone: jest.fn()
}));

// RTO network participation lookup (reads shop.settings.rto_network) — default to enforcing.
jest.mock('../../rto-shield/rto-network-settings', () => ({
    getNetworkSettings: jest.fn().mockResolvedValue({ contribute: true, enforce: true })
}));

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => mockOrderLogger)
}));

jest.mock('../../product/stock-status-guard.service', () => ({
    invalidate: jest.fn()
}));

jest.mock('../../delivery/delivery.service', () => ({
    getTracking: jest.fn(),
    syncStatus: jest.fn(),
    createConsignment: jest.fn(),
    getActiveProvider: jest.fn(),
    createOrder: jest.fn()
}));

jest.mock('../../entities', () => ({
    Order: {
        findOne: jest.fn(),
        findAll: jest.fn(),
        findAndCountAll: jest.fn(),
        create: jest.fn()
    },
    OrderItem: {
        findAll: jest.fn(),
        create: jest.fn()
    },
    Product: {
        findAll: jest.fn(),
        findOne: jest.fn(),
        decrement: jest.fn(),
        increment: jest.fn()
    },
    Customer: {
        findOne: jest.fn()
    },
    UserShop: {
        findOne: jest.fn()
    },
    OrderReturn: {
        create: jest.fn()
    },
    Channel: {
        findOne: jest.fn()
    },
    CourierDispatch: { findOne: jest.fn(), findOrCreate: jest.fn(), update: jest.fn() },
    DeliveryTracking: { findOne: jest.fn() },
    AuditLog: { create: jest.fn() },
    PaymentConfig: { findOne: jest.fn() },
    Invoice: {
        create: jest.fn()
    },
    // ADR-0011 ledger used by the cancellation path.
    BillingLine: {
        findOne: jest.fn().mockResolvedValue(null),
        findOrCreate: jest.fn().mockResolvedValue([{}, true]),
        findAll: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue([1])
    },
    PartnerBillingAdjustment: { findOne: jest.fn(), create: jest.fn() }
}));

jest.mock('../../../utils/email.service', () => ({
    sendEmail: jest.fn()
}));

const orderService = require('../order.service');
const orderController = require('../order.controller');
const { Order, OrderItem, Product, UserShop, Customer, Invoice, Channel, CourierDispatch, DeliveryTracking, AuditLog, PaymentConfig } = require('../../entities');
const { sequelize } = require('../../../utils/database/database-setup');
const subscriptionService = require('../../subscription/subscription.service');
const rtoShieldService = require('../../rto-shield/rto-shield.service');
const stockGuardService = require('../../product/stock-status-guard.service');
const deliveryService = require('../../delivery/delivery.service');
const { sendEmail } = require('../../../utils/email.service');

// Helper to create mock order with instance methods
const createMockOrder = (overrides = {}) => ({
    id: 'order-1',
    order_number: 'ORD-001',
    order_status: 'draft',
    payment_status: 'pending',
    fulfillment_status: 'unfulfilled',
    shop_id: 'shop-1',
    customer_id: 'customer-1',
    customer_name: 'Test Customer',
    customer_phone: '01712345678',
    customer_email: 'test@example.com',
    total: 100,
    subtotal: 90,
    discount: 0,
    tax: 0,
    delivery_fee: 10,
    items: [],
    update: jest.fn().mockResolvedValue(true),
    save: jest.fn().mockResolvedValue(true),
    destroy: jest.fn().mockResolvedValue(true),
    ...overrides
});

// Helper to create mock order item with getProduct method
const createMockOrderItem = (overrides = {}) => ({
    id: 'item-1',
    order_id: 'order-1',
    product_id: 'prod-1',
    quantity: 1,
    price: 100,
    total: 100,
    getProduct: jest.fn().mockResolvedValue({
        id: 'prod-1',
        name: 'Test Product',
        increment: jest.fn().mockResolvedValue(true),
        decrement: jest.fn().mockResolvedValue(true),
        ...overrides.product
    }),
    ...overrides
});

describe('Order Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Default mock implementations
        sequelize.transaction = jest.fn(async (callback) => {
            const transaction = {
            LOCK: { UPDATE: 'UPDATE' },
            commit: jest.fn(),
            rollback: jest.fn()
            };
            return typeof callback === 'function' ? callback(transaction) : transaction;
        });
        // Postgres query mock for generateOrderNumber - returns [[{ next_number: X }]]
        sequelize.query = jest.fn().mockResolvedValue([[{ next_number: 1 }]]);
        sequelize.getDialect = jest.fn().mockReturnValue('postgres');
        
        subscriptionService.checkOrderLimit = jest.fn().mockResolvedValue(true);
        subscriptionService.trackUsage = jest.fn().mockResolvedValue({ transactionId: 'test-txn' });
        
        rtoShieldService.checkPhone = jest.fn().mockResolvedValue({ flagged: false });
        
        stockGuardService.invalidate = jest.fn().mockResolvedValue(true);
        
        deliveryService.getActiveProvider = jest.fn().mockResolvedValue(null);
        deliveryService.createOrder = jest.fn().mockResolvedValue({});
        
        Customer.findOne = jest.fn().mockResolvedValue(null);
        Invoice.create = jest.fn().mockResolvedValue({
            id: 'invoice-1',
            invoice_number: 'INV-202401-ORD-001'
        });
        Channel.findOne = jest.fn().mockResolvedValue(null);
        CourierDispatch.findOne.mockResolvedValue(null);
        DeliveryTracking.findOne.mockResolvedValue(null);
        PaymentConfig.findOne.mockResolvedValue(null);
        AuditLog.create.mockResolvedValue({ id: 'audit-1' });
        
        sendEmail.mockResolvedValue(true);
    });

    describe('Constants', () => {
        it('should have correct default values defined', () => {
            // These are defined in the service file
            const service = require('../order.service');
            expect(service).toBeDefined();
        });
    });

    describe('verifyShopAccess (via service methods)', () => {
        it('should allow access for active user-shop relationship', async () => {
            const mockUserShop = { id: 'user-shop-1', is_active: true };
            UserShop.findOne = jest.fn().mockResolvedValue(mockUserShop);

            // Test via getOrderById which internally calls verifyShopAccess
            const mockOrder = createMockOrder();
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);

            const result = await orderService.getOrderById('order-1', 'user-1', 'shop-1');
            
            expect(result).toBeDefined();
            expect(UserShop.findOne).toHaveBeenCalledWith({
                where: {
                    user_id: 'user-1',
                    shop_id: 'shop-1',
                    is_active: true
                }
            });
        });

        it('should throw AppError with 403 when user has no shop access', async () => {
            UserShop.findOne = jest.fn().mockResolvedValue(null);

            await expect(orderService.getOrderById('order-1', 'user-1', 'shop-1'))
                .rejects
                .toThrow(AppError);
            
            await expect(orderService.getOrderById('order-1', 'user-1', 'shop-1'))
                .rejects
                .toThrow('You do not have access to this shop');
        });
    });

    describe('Order Number Generation (via createOrder)', () => {
        it('should generate order number for Postgres with sequence', async () => {
            sequelize.getDialect.mockReturnValue('postgres');
            // Postgres query returns [[{ next_number: 5 }]] - nested array for destructuring
            sequelize.query.mockResolvedValue([[{ next_number: 5 }]]);

            const mockProduct = {
                id: 'prod-1',
                name: 'Test Product',
                price: 100.00,
                quantity: 10,
                track_quantity: false
            };

            const mockOrder = createMockOrder({
                order_number: 'ORD-550E8400-000005'
            });

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockImplementation((data) => Promise.resolve({ ...mockOrder, ...data }));
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            const result = await orderService.createOrder('user-1', '550e8400-e29b-41d4-a716-446655440000', {
                customer_name: 'Test',
                customer_phone: '01712345678',
                items: [{ product_id: 'prod-1', quantity: 1 }],
                payment_status: 'pending'
            });

            expect(sequelize.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO order_sequences'),
                expect.any(Object)
            );
        });

        it('should handle SQLite fallback for order number generation', async () => {
            sequelize.getDialect.mockReturnValue('sqlite');
            const mockTxn = { 
                commit: jest.fn().mockResolvedValue(true), 
                rollback: jest.fn().mockResolvedValue(true) 
            };
            sequelize.transaction.mockResolvedValue(mockTxn);
            // SQLite query returns [[{ next_number: 3 }]] format
            sequelize.query.mockResolvedValue([[{ next_number: 3, shop_id: '550e8400-e29b-41d4-a716-446655440000' }]]);

            const mockProduct = {
                id: 'prod-1',
                name: 'Test Product',
                price: 100.00,
                quantity: 10,
                track_quantity: false
            };

            const mockOrder = createMockOrder();

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockImplementation((data) => Promise.resolve({ ...mockOrder, ...data }));
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            const result = await orderService.createOrder('user-1', '550e8400-e29b-41d4-a716-446655440000', {
                customer_name: 'Test',
                customer_phone: '01712345678',
                items: [{ product_id: 'prod-1', quantity: 1 }],
                payment_status: 'pending'
            });

            expect(result).toBeDefined();
            expect(result.order_number).toMatch(/^ORD-[A-F0-9]{8}-\d{6}$/);
        });
    });

    describe('createOrder', () => {
        const validOrderData = {
            customer_name: 'Test Customer',
            customer_phone: '01712345678',
            items: [
                { product_id: 'prod-1', quantity: 2 }
            ],
            payment_status: 'pending'
        };

        it.each(['cod', 'cash on delivery', 'cash_on_delivery'])(
            'rejects creation of a COD order as paid for method %s',
            async (payment_method) => {
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

                await expect(orderService.createOrder('user-1', 'shop-1', {
                    ...validOrderData,
                    payment_method,
                    payment_status: 'paid',
                })).rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });

                expect(Order.create).not.toHaveBeenCalled();
                expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            },
        );

        it.each(['paymentMethodId', 'payment_method_id'])(
            'rejects paid creation when the shop-scoped %s resolves to COD',
            async (idField) => {
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
                PaymentConfig.findOne.mockResolvedValue({ gateway: 'cod' });

                await expect(orderService.createOrder('user-1', 'shop-1', {
                    ...validOrderData,
                    [idField]: 'cod-config-1',
                    payment_status: 'paid',
                })).rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });

                expect(PaymentConfig.findOne).toHaveBeenCalledWith({
                    where: { id: 'cod-config-1', shop_id: 'shop-1' },
                    attributes: ['gateway'],
                });
                expect(Order.create).not.toHaveBeenCalled();
                expect(OrderItem.create).not.toHaveBeenCalled();
                expect(Product.findAll).not.toHaveBeenCalled();
                expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            },
        );

        it('accepts equivalent payment ID aliases and resolves the canonical shop gateway', async () => {
            const replay = createMockOrder({ id: 'existing-order' });
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            PaymentConfig.findOne.mockResolvedValue({ gateway: 'bkash' });
            Order.findOne.mockResolvedValue(replay);

            const result = await orderService.createOrder('user-1', 'shop-1', {
                ...validOrderData,
                paymentMethodId: 'online-config-1',
                payment_method_id: 'online-config-1',
                payment_status: 'paid',
            }, 'same-payment-aliases');

            expect(result).toBe(replay);
            expect(PaymentConfig.findOne).toHaveBeenCalledWith({
                where: { id: 'online-config-1', shop_id: 'shop-1' },
                attributes: ['gateway'],
            });
            expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            expect(Order.create).not.toHaveBeenCalled();
        });

        it('rejects conflicting payment ID aliases before any order or stock mutation', async () => {
            const decrement = jest.fn();
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll.mockResolvedValue([{
                id: 'prod-1',
                name: 'Test Product',
                price: 100,
                quantity: 10,
                track_quantity: true,
                decrement,
            }]);

            await expect(orderService.createOrder('user-1', 'shop-1', {
                ...validOrderData,
                paymentMethodId: 'online-config-1',
                payment_method_id: 'cod-config-1',
                payment_status: 'paid',
            })).rejects.toMatchObject({ status: 400, code: 'PAYMENT_METHOD_ID_CONFLICT' });

            expect(PaymentConfig.findOne).not.toHaveBeenCalled();
            expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            expect(sequelize.transaction).not.toHaveBeenCalled();
            expect(Product.findAll).not.toHaveBeenCalled();
            expect(Order.create).not.toHaveBeenCalled();
            expect(OrderItem.create).not.toHaveBeenCalled();
            expect(decrement).not.toHaveBeenCalled();
        });

        it('returns conflicting payment aliases and terminal statuses as bulk row failures without writes', async () => {
            const rows = [
                {
                    ...validOrderData,
                    paymentMethodId: 'online-config-1',
                    payment_method_id: 'cod-config-1',
                },
                { ...validOrderData, order_status: 'completed' },
            ];
            const req = { user: { userId: 'user-1', shopId: 'shop-1' }, body: { orders: rows } };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn(),
            };
            const next = jest.fn();
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderController.bulkCreateOrders(req, res, next);

            expect(res.status).toHaveBeenCalledWith(207);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                summary: { total: 2, succeeded: 0, failed: 2 },
                results: [
                    expect.objectContaining({
                        index: 1,
                        success: false,
                        error: 'Payment method ID aliases must refer to the same configured payment method.',
                    }),
                    expect.objectContaining({
                        index: 2,
                        success: false,
                        error: 'Terminal order statuses cannot be set during order creation.',
                    }),
                ],
            }));
            expect(PaymentConfig.findOne).not.toHaveBeenCalled();
            expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            expect(sequelize.transaction).not.toHaveBeenCalled();
            expect(Product.findAll).not.toHaveBeenCalled();
            expect(Order.create).not.toHaveBeenCalled();
            expect(OrderItem.create).not.toHaveBeenCalled();
            expect(next).not.toHaveBeenCalled();
        });

        it('rejects one shop-scoped COD payment_method_id with paid status as a bulk row failure before writes', async () => {
            const codRow = {
                ...validOrderData,
                payment_method_id: 'cod-config-1',
                payment_status: 'paid',
            };
            UserShop.findOne.mockResolvedValue({ id: 'user-shop-1' });
            PaymentConfig.findOne.mockResolvedValue({ gateway: 'cod' });
            const req = { user: { userId: 'user-1', shopId: 'shop-1' }, body: { orders: [codRow] } };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn(),
            };
            const next = jest.fn();

            await orderController.bulkCreateOrders(req, res, next);

            expect(PaymentConfig.findOne).toHaveBeenCalledWith({
                where: { id: 'cod-config-1', shop_id: 'shop-1' },
                attributes: ['gateway'],
            });
            expect(res.status).toHaveBeenCalledWith(207);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                summary: { total: 1, succeeded: 0, failed: 1 },
                results: [expect.objectContaining({
                    index: 1,
                    success: false,
                    error: 'COD orders cannot be created as paid. Use the owner-confirmed COD settlement action after full delivery.',
                })],
            }));
            expect(sequelize.transaction).not.toHaveBeenCalled();
            expect(Product.findAll).not.toHaveBeenCalled();
            expect(Order.create).not.toHaveBeenCalled();
            expect(OrderItem.create).not.toHaveBeenCalled();
            expect(next).not.toHaveBeenCalled();
        });

        it('rejects a payment method ID not configured for the order shop', async () => {
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            PaymentConfig.findOne.mockResolvedValue(null);

            await expect(orderService.createOrder('user-1', 'shop-1', {
                ...validOrderData,
                paymentMethodId: 'foreign-config-1',
            })).rejects.toMatchObject({ status: 400, code: 'PAYMENT_METHOD_NOT_AVAILABLE' });

            expect(PaymentConfig.findOne).toHaveBeenCalledWith({
                where: { id: 'foreign-config-1', shop_id: 'shop-1' },
                attributes: ['gateway'],
            });
            expect(Order.create).not.toHaveBeenCalled();
        });

        it.each(['fulfilled', 'partially_fulfilled', 'cancelled'])(
            'rejects client creation with fulfillment status %s',
            async (fulfillment_status) => {
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

                await expect(orderService.createOrder('user-1', 'shop-1', {
                    ...validOrderData,
                    fulfillment_status,
                })).rejects.toMatchObject({ status: 409, code: 'FULFILLMENT_STATUS_SERVER_AUTHORITY' });

                expect(Order.create).not.toHaveBeenCalled();
                expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            },
        );

        it.each(['completed', 'fulfilled', 'cancelled', 'delivered'])(
            'rejects terminal order status %s before creating an order or reserving stock',
            async (order_status) => {
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

                await expect(orderService.createOrder('user-1', 'shop-1', {
                    ...validOrderData,
                    order_status,
                })).rejects.toMatchObject({ status: 400, code: 'ORDER_STATUS_SERVER_AUTHORITY' });

                expect(sequelize.transaction).not.toHaveBeenCalled();
                expect(Product.findAll).not.toHaveBeenCalled();
                expect(Order.create).not.toHaveBeenCalled();
                expect(OrderItem.create).not.toHaveBeenCalled();
                expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            },
        );

        it('should create order successfully with valid data', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Test Product',
                price: 100.00,
                quantity: 10,
                track_quantity: true,
                allow_backorder: false,
                decrement: jest.fn().mockResolvedValue(true)
            };

            const mockOrder = {
                id: 'order-1',
                order_number: 'ORD-SHOP01-000001',
                save: jest.fn().mockResolvedValue(true)
            };

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockResolvedValue(mockOrder);
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            const result = await orderService.createOrder('user-1', 'shop-1', validOrderData);

            expect(result).toBeDefined();
            expect(Order.create).toHaveBeenCalled();
            expect(subscriptionService.checkOrderLimit).toHaveBeenCalledWith('shop-1');

            // The order's JSON `items` column must carry a denormalized line-item
            // snapshot (with a display name) — the order-detail dialog, the invoice
            // and the courier all read order.items, not the order_items association.
            // Without this the manual order showed an empty "Order Items" list while
            // its total was correct (founder bug 2026-06-12).
            const createArg = Order.create.mock.calls[0][0];
            expect(createArg.fulfillment_status).toBe('unfulfilled');
            expect(createArg.items).toEqual([
                expect.objectContaining({
                    product_id: 'prod-1',
                    productName: 'Test Product',
                    quantity: 2,
                    price: 100,
                    total: 200,
                }),
            ]);
        });

        it('should reject order when subscription limit exceeded', async () => {
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            subscriptionService.checkOrderLimit = jest.fn().mockRejectedValue(
                new AppError('Order limit exceeded', 403)
            );

            await expect(orderService.createOrder('user-1', 'shop-1', validOrderData))
                .rejects
                .toThrow('Order limit exceeded');
        });

        it('creates a COD order on a neutral network review signal without auto-declining the buyer', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Test Product',
                price: 100,
                quantity: 10,
                track_quantity: true,
                allow_backorder: false,
                decrement: jest.fn().mockResolvedValue(true),
            };
            const mockOrder = createMockOrder();
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockImplementation((data) => Promise.resolve({ ...mockOrder, ...data }));
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });
            PaymentConfig.findOne.mockResolvedValue({ gateway: 'cod' });
            rtoShieldService.checkPhone = jest.fn().mockResolvedValue({
                flagged: false,
                risk_score: 0,
                tier: 'verify',
                reason: 'Elevated cross-shop return history'
            });

            const codOrderData = {
                ...validOrderData,
                payment_status: 'unpaid',
                paymentMethodId: 'cod-config-1',
                customer_phone: '01712345678'
            };

            const created = await orderService.createOrder('user-1', 'shop-1', codOrderData);

            expect(created).toBeDefined();
            expect(Order.create).toHaveBeenCalled();
            expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
                payment_method: 'cod',
                payment_method_id: 'cod-config-1',
            }), { transaction: expect.any(Object) });
            expect(rtoShieldService.checkPhone).toHaveBeenCalledWith(
                '01712345678', 'shop-1', { trustedContext: true, enforceNetwork: true }
            );
            const reviewLog = mockOrderLogger.warn.mock.calls.find(([message]) =>
                message === 'RTO Shield: COD booking review required'
            );
            expect(reviewLog).toEqual([
                'RTO Shield: COD booking review required',
                { decision: 'manual_review_required', riskTier: 'verify' },
            ]);
            expect(JSON.stringify(reviewLog)).not.toContain('01712345678');
            expect(JSON.stringify(reviewLog)).not.toContain('Elevated cross-shop return history');
        });

        it('persists a structured destination as the canonical carrier the courier reads', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Test Product',
                price: 100,
                quantity: 10,
                track_quantity: true,
                allow_backorder: false,
                decrement: jest.fn().mockResolvedValue(true),
            };
            const mockOrder = createMockOrder();
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockImplementation((data) => Promise.resolve({ ...mockOrder, ...data }));
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });
            PaymentConfig.findOne.mockResolvedValue({ gateway: 'cod' });
            rtoShieldService.checkPhone = jest.fn().mockResolvedValue({ flagged: false, risk_score: 0 });

            const location = { full_address: 'Road 1, Mirpur', source: 'manual' };

            await orderService.createOrder('user-1', 'shop-1', {
                ...validOrderData,
                payment_status: 'unpaid',
                delivery_area: 'Mirpur',
                delivery_location: location,
                delivery_address: { street_address: 'Road 1', upazila: 'Mirpur', district: 'Dhaka' },
            });

            // delivery_location is a TEXT column: an object must be serialized
            // here or the destination is lost before a courier ever sees it.
            expect(Order.create).toHaveBeenCalledWith(expect.objectContaining({
                delivery_location: JSON.stringify(location),
                delivery_area: 'Mirpur',
            }), { transaction: expect.any(Object) });
        });

        it('rejects client-supplied provider confirmations during generic order creation', async () => {
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.createOrder('user-1', 'shop-1', {
                ...validOrderData,
                delivery_location: {
                    full_address: 'Road 1, Mirpur, Dhaka',
                    provider_destination: {
                        redx: {
                            area_id: 999,
                            area_name: 'Atlantis',
                            source: 'merchant_confirmed',
                            confirmed_at: '2026-11-04T00:00:00.000Z',
                            confirmed_by: 'user-1',
                        },
                    },
                },
            })).rejects.toMatchObject({
                status: 400,
                code: 'COURIER_DESTINATION_CONFIRM_REQUIRED',
            });

            expect(Order.create).not.toHaveBeenCalled();
        });

        it('should reject order with insufficient stock', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Low Stock Product',
                price: 100.00,
                quantity: 1, // Only 1 in stock
                track_quantity: true,
                allow_backorder: false
            };

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);

            const orderData = {
                ...validOrderData,
                items: [{ product_id: 'prod-1', quantity: 5 }] // Requesting 5
            };

            await expect(orderService.createOrder('user-1', 'shop-1', orderData))
                .rejects
                .toThrow('Insufficient stock');
        });

        it('should allow backorder for products with allow_backorder flag', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Backorder Product',
                price: 100.00,
                quantity: 0,
                track_quantity: true,
                allow_backorder: true, // Allow backorder
                decrement: jest.fn().mockResolvedValue(true)
            };

            const mockOrder = {
                id: 'order-1',
                order_number: 'ORD-SHOP01-000001',
                save: jest.fn().mockResolvedValue(true)
            };

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockResolvedValue(mockOrder);
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            const orderData = {
                ...validOrderData,
                items: [{ product_id: 'prod-1', quantity: 5 }]
            };

            const result = await orderService.createOrder('user-1', 'shop-1', orderData);
            expect(result).toBeDefined();
        });

        it('should reject COD orders exceeding maximum amount', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Expensive Product',
                price: 60000.00, // Over 50,000 COD limit
                quantity: 100,
                track_quantity: true,
                allow_backorder: false
            };

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);

            const orderData = {
                ...validOrderData,
                payment_method: 'cod',
                payment_status: 'unpaid',
                items: [{ product_id: 'prod-1', quantity: 1 }]
            };

            await expect(orderService.createOrder('user-1', 'shop-1', orderData))
                .rejects
                .toThrow('COD orders cannot exceed');
        });

        it('should handle idempotency - return existing order for duplicate request', async () => {
            const existingOrder = { id: 'existing-order', order_number: 'ORD-001' };
            Order.findOne = jest.fn().mockResolvedValue(existingOrder);

            const result = await orderService.createOrder('user-1', 'shop-1', validOrderData, 'request-id-1');
            
            expect(result).toEqual(existingOrder);
            expect(Order.create).not.toHaveBeenCalled();
        });

        it('replays an existing idempotency key before enforcing a later subscription limit', async () => {
            const existingOrder = { id: 'existing-order', order_number: 'ORD-001' };
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Order.findOne = jest.fn().mockResolvedValue(existingOrder);
            subscriptionService.checkOrderLimit.mockRejectedValue(new AppError('Order limit exceeded', 403));

            const result = await orderService.createOrder('user-1', 'shop-1', validOrderData, 'request-id-1');

            expect(result).toBe(existingOrder);
            expect(subscriptionService.checkOrderLimit).not.toHaveBeenCalled();
            expect(rtoShieldService.checkPhone).not.toHaveBeenCalled();
        });

        it('rechecks an idempotency key under a shop-scoped transaction lock', async () => {
            const existingOrder = { id: 'existing-order', order_number: 'ORD-001' };
            const transaction = { LOCK: { UPDATE: 'UPDATE' }, commit: jest.fn(), rollback: jest.fn() };
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Order.findOne = jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(existingOrder);
            sequelize.transaction = jest.fn().mockResolvedValue(transaction);

            const result = await orderService.createOrder('user-1', 'shop-1', validOrderData, 'request-id-1');

            expect(result).toBe(existingOrder);
            expect(sequelize.query).toHaveBeenCalledWith(
                expect.stringContaining('pg_advisory_xact_lock'),
                expect.objectContaining({
                    replacements: { key: 'order:shop-1:request-id-1' },
                    transaction,
                }),
            );
            expect(Order.findOne).toHaveBeenNthCalledWith(2, expect.objectContaining({
                where: { shop_id: 'shop-1', idempotency_key: 'request-id-1' },
                transaction,
            }));
            expect(transaction.commit).toHaveBeenCalledTimes(1);
            expect(Order.create).not.toHaveBeenCalled();
        });

        it('aggregates duplicate product lines before checking tracked stock', async () => {
            const mockProduct = {
                id: 'prod-1', name: 'Low Stock Product', price: 100, quantity: 5,
                track_quantity: true, allow_backorder: false,
                decrement: jest.fn().mockResolvedValue(true),
            };
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockResolvedValue({ id: 'order-1', order_number: 'ORD-001' });
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });
            const orderData = {
                ...validOrderData,
                items: [
                    { product_id: 'prod-1', quantity: 3 },
                    { product_id: 'prod-1', quantity: 3 },
                ],
            };

            await expect(orderService.createOrder('user-1', 'shop-1', orderData))
                .rejects.toThrow('Insufficient stock');

            expect(Order.create).not.toHaveBeenCalled();
            expect(mockProduct.decrement).not.toHaveBeenCalled();
        });

        it('locks products in stable order before validating and decrementing tracked stock', async () => {
            const mockProduct = {
                id: 'prod-1', name: 'Test Product', price: 100, quantity: 10,
                track_quantity: true, allow_backorder: false,
                decrement: jest.fn().mockResolvedValue(true),
            };
            const transaction = { LOCK: { UPDATE: 'UPDATE' }, commit: jest.fn(), rollback: jest.fn() };
            sequelize.transaction = jest.fn().mockResolvedValue(transaction);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockResolvedValue({ id: 'order-1', order_number: 'ORD-001', save: jest.fn() });
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            await orderService.createOrder('user-1', 'shop-1', validOrderData);

            expect(Product.findAll).toHaveBeenCalledWith(expect.objectContaining({
                order: [['id', 'ASC']],
                lock: 'UPDATE',
                transaction,
            }));
        });

        it('should deduct stock atomically when creating order', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Test Product',
                price: 100.00,
                quantity: 10,
                track_quantity: true,
                allow_backorder: false,
                decrement: jest.fn().mockResolvedValue(true)
            };

            const mockOrder = {
                id: 'order-1',
                order_number: 'ORD-SHOP01-000001',
                save: jest.fn().mockResolvedValue(true)
            };

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockResolvedValue(mockOrder);
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            await orderService.createOrder('user-1', 'shop-1', validOrderData);

            expect(mockProduct.decrement).toHaveBeenCalledWith('quantity', {
                by: 2,
                transaction: expect.any(Object)
            });
        });

        it('should calculate order totals correctly', async () => {
            const mockProduct = {
                id: 'prod-1',
                name: 'Test Product',
                price: 100.00,
                quantity: 10,
                track_quantity: false,
                decrement: jest.fn()
            };

            const mockOrder = {
                id: 'order-1',
                save: jest.fn().mockResolvedValue(true)
            };

            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            Product.findAll = jest.fn().mockResolvedValue([mockProduct]);
            Order.create = jest.fn().mockImplementation((data) => Promise.resolve({ ...mockOrder, ...data }));
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            const orderData = {
                customer_name: 'Test',
                customer_phone: '01712345678',
                items: [{ product_id: 'prod-1', quantity: 2 }],
                discount: 10,
                tax: 5,
                delivery_fee: 20
            };

            await orderService.createOrder('user-1', 'shop-1', orderData);

            const createCall = Order.create.mock.calls[0][0];
            expect(createCall.subtotal).toBe(200); // 100 * 2
            expect(createCall.discount).toBe(10);
            expect(createCall.tax).toBe(5);
            expect(createCall.delivery_fee).toBe(20);
            expect(createCall.total).toBe(215); // 200 - 10 + 5 + 20
        });
    });

    describe('getOrderById', () => {
        it('should return order by ID', async () => {
            const mockOrder = createMockOrder({
                order_number: 'ORD-001'
            });

            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            const result = await orderService.getOrderById('order-1', 'user-1', 'shop-1');

            expect(result).toEqual(mockOrder);
            expect(Order.findOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 'order-1', shop_id: 'shop-1' }
                })
            );
        });

        it('scopes customer and product associations to the current shop', async () => {
            Order.findOne = jest.fn().mockResolvedValue(createMockOrder());
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.getOrderById('order-1', 'user-1', 'shop-1');

            const options = Order.findOne.mock.calls[0][0];
            const customerInclude = options.include.find((include) => include.as === 'customer');
            const itemsInclude = options.include.find((include) => include.as === 'order_items');
            const productInclude = itemsInclude.include.find((include) => include.as === 'product');
            expect(customerInclude).toMatchObject({ where: { shop_id: 'shop-1' }, required: false });
            expect(productInclude).toMatchObject({ where: { shop_id: 'shop-1' }, required: false });
        });

        it('should throw error when order not found', async () => {
            Order.findOne = jest.fn().mockResolvedValue(null);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.getOrderById('nonexistent', 'user-1', 'shop-1'))
                .rejects
                .toThrow('Order not found');
        });
    });

    describe('listOrders', () => {
        it('should return orders list', async () => {
            const mockOrders = [
                createMockOrder({ id: 'order-1', order_number: 'ORD-001' }),
                createMockOrder({ id: 'order-2', order_number: 'ORD-002' })
            ];

            Order.findAll = jest.fn().mockResolvedValue(mockOrders);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            const result = await orderService.listOrders('user-1', 'shop-1', { page: 1, limit: 10 });

            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(2);
        });

        it('should call findAll with correct parameters', async () => {
            Order.findAll = jest.fn().mockResolvedValue([]);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.listOrders('user-1', 'shop-1', { 
                page: 1, 
                limit: 10, 
                payment_status: 'paid' 
            });

            expect(Order.findAll).toHaveBeenCalled();
            const callArgs = Order.findAll.mock.calls[0][0];
            expect(callArgs.where).toMatchObject({ shop_id: 'shop-1' });
        });

        it('should verify shop access before listing orders', async () => {
            Order.findAll = jest.fn().mockResolvedValue([]);
            UserShop.findOne = jest.fn().mockResolvedValue(null);

            await expect(orderService.listOrders('user-1', 'shop-1', {}))
                .rejects
                .toThrow('You do not have access to this shop');
        });

        // MW-V1 customer-context panel: recent orders per conversation's customer,
        // filtered by the authoritative id INSIDE the shop scope (never cross-shop).
        it('filters by customer_id within the shop scope', async () => {
            Order.findAll = jest.fn().mockResolvedValue([]);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.listOrders('user-1', 'shop-1', { customer_id: 'cust-9' });

            const callArgs = Order.findAll.mock.calls[0][0];
            expect(callArgs.where).toMatchObject({ shop_id: 'shop-1', customer_id: 'cust-9' });
        });

        it('filters delivered orders within the shop scope', async () => {
            Order.findAll = jest.fn().mockResolvedValue([]);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.listOrders('user-1', 'shop-1', { order_status: 'delivered' });

            expect(Order.findAll.mock.calls[0][0].where).toMatchObject({
                shop_id: 'shop-1',
                order_status: 'delivered',
            });
        });

        it('scopes the optional Customer association to the current shop', async () => {
            Order.findAll = jest.fn().mockResolvedValue([]);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.listOrders('user-1', 'shop-1', { page: 1, limit: 10 });

            const customerInclude = Order.findAll.mock.calls[0][0].include.find((include) => include.as === 'customer');
            expect(customerInclude).toMatchObject({ where: { shop_id: 'shop-1' }, required: false });
        });
    });

    describe('deleteOrder', () => {
        it('rejects hard deletion without changing order, stock, tracking, or history', async () => {
            const mockOrder = createMockOrder({
                order_status: 'confirmed',
                metadata: { audit_log: [{ event: 'created' }] },
            });
            const tracking = {
                current_status: 'in_transit',
                status_history: [{ status: 'booked' }],
                update: jest.fn(),
            };
            const beforeOrder = { order_status: mockOrder.order_status, metadata: structuredClone(mockOrder.metadata) };
            const beforeTracking = structuredClone({
                current_status: tracking.current_status,
                status_history: tracking.status_history,
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            DeliveryTracking.findOne = jest.fn().mockResolvedValue(tracking);

            await expect(orderService.deleteOrder('order-1', 'user-1', 'shop-1'))
                .rejects.toMatchObject({
                    status: 410,
                    code: 'ORDER_HARD_DELETE_UNSUPPORTED',
                    message: expect.stringContaining('cancellation endpoint'),
                });

            expect(UserShop.findOne).toHaveBeenCalledWith({ where: {
                user_id: 'user-1', shop_id: 'shop-1', is_active: true,
            } });
            expect(Order.findOne).not.toHaveBeenCalled();
            expect(mockOrder.destroy).not.toHaveBeenCalled();
            expect(OrderItem.findAll).not.toHaveBeenCalled();
            expect(Product.increment).not.toHaveBeenCalled();
            expect(CourierDispatch.findOne).not.toHaveBeenCalled();
            expect(DeliveryTracking.findOne).not.toHaveBeenCalled();
            expect(tracking.update).not.toHaveBeenCalled();
            expect(AuditLog.create).not.toHaveBeenCalled();
            expect({ order_status: mockOrder.order_status, metadata: mockOrder.metadata }).toEqual(beforeOrder);
            expect({ current_status: tracking.current_status, status_history: tracking.status_history }).toEqual(beforeTracking);
        });
    });

    describe('confirmOrder', () => {
        it('should confirm order successfully', async () => {
            const mockOrder = createMockOrder({
                order_status: 'draft',
                total: 150
            });

            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            const result = await orderService.confirmOrder('user-1', 'shop-1', 'order-1');

            expect(mockOrder.update).toHaveBeenCalledWith({ order_status: 'confirmed' });
            expect(Invoice.create).toHaveBeenCalled();
        });

        it('should throw error when order not in draft status', async () => {
            const mockOrder = createMockOrder({
                order_status: 'confirmed'
            });

            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.confirmOrder('order-1', 'user-1', 'shop-1'))
                .rejects
                .toThrow('Cannot confirm order with status: confirmed');
        });

        it('should throw error when order not found', async () => {
            Order.findOne = jest.fn().mockResolvedValue(null);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.confirmOrder('order-1', 'user-1', 'shop-1'))
                .rejects
                .toThrow('Order not found');
        });
    });

    describe('cancelOrder', () => {
        it('should cancel order and restore stock', async () => {
            const mockOrder = createMockOrder({
                order_status: 'confirmed'
            });

            sequelize.transaction = jest.fn(async (cb) => {
                const t = { commit: jest.fn(), rollback: jest.fn() };
                return cb(t);
            });

            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            OrderItem.findAll = jest.fn().mockResolvedValue([]);

            const result = await orderService.cancelOrder('user-1', 'shop-1', 'order-1', 'Customer request');

            expect(mockOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    order_status: 'cancelled'
                }),
                expect.any(Object)
            );
        });

        it('should throw error when order not found', async () => {
            Order.findOne = jest.fn().mockResolvedValue(null);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
                .rejects
                .toThrow('Order not found');
        });

        it('does not cancel a completed order or restore its inventory', async () => {
            const mockOrder = createMockOrder({ order_status: 'completed' });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
                .rejects.toMatchObject({ status: 409 });

            expect(mockOrder.update).not.toHaveBeenCalled();
            expect(OrderItem.findAll).not.toHaveBeenCalled();
            expect(Product.findAll).not.toHaveBeenCalled();
        });

        it.each(['PENDING', 'INDETERMINATE', 'COMMITTED'])(
            'does not cancel or restore inventory with a %s courier claim',
            async (status) => {
                const mockOrder = createMockOrder({ order_status: 'confirmed' });
                Order.findOne = jest.fn().mockResolvedValue(mockOrder);
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
                CourierDispatch.findOne.mockResolvedValue({ status });

                await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
                    .rejects.toMatchObject({ status: 409, code: 'COURIER_DISPATCH_ACTIVE' });

                expect(CourierDispatch.findOne).toHaveBeenCalledWith(expect.objectContaining({
                    where: expect.objectContaining({ shop_id: 'shop-1', order_id: 'order-1' }),
                }));
                expect(mockOrder.update).not.toHaveBeenCalled();
                expect(OrderItem.findAll).not.toHaveBeenCalled();
            },
        );

        it('does not cancel or restore inventory after tracking has started', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed' });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            CourierDispatch.findOne.mockResolvedValue(null);
            DeliveryTracking.findOne.mockResolvedValue({ id: 'tracking-1', order_id: 'order-1' });

            await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
                .rejects.toMatchObject({ status: 409, code: 'ORDER_LOCKED_AFTER_COURIER_DISPATCH' });

            expect(mockOrder.update).not.toHaveBeenCalled();
            expect(OrderItem.findAll).not.toHaveBeenCalled();
        });
    });

    describe('updateOrder', () => {
        it('restores tracked stock through the dedicated cancellation path', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', metadata: {} });
            const prod = { id: 'prod-1', track_quantity: true, increment: jest.fn().mockResolvedValue(true) };
            const transaction = { LOCK: { UPDATE: 'UPDATE' }, commit: jest.fn(), rollback: jest.fn() };
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            OrderItem.findAll = jest.fn().mockResolvedValue([{ product_id: 'prod-1', quantity: 2 }]);
            Product.findAll = jest.fn().mockResolvedValue([prod]);
            sequelize.transaction = jest.fn(async (cb) => cb(transaction));

            await orderService.cancelOrder('user-1', 'shop-1', 'order-1');

            expect(mockOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({ order_status: 'cancelled' }),
                { transaction },
            );
            expect(prod.increment).toHaveBeenCalledWith('quantity', { by: 2, transaction });
        });

        it('rolls back dedicated cancellation when stock restoration fails', async () => {
            const restoreError = new Error('stock write failed');
            const mockOrder = createMockOrder({ order_status: 'confirmed', metadata: {} });
            const product = { id: 'prod-1', track_quantity: true, increment: jest.fn().mockRejectedValue(restoreError) };
            const transaction = { LOCK: { UPDATE: 'UPDATE' }, commit: jest.fn(), rollback: jest.fn() };
            sequelize.transaction = jest.fn(async (callback) => {
                try {
                    return await callback(transaction);
                } catch (error) {
                    await transaction.rollback();
                    throw error;
                }
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            OrderItem.findAll = jest.fn().mockResolvedValue([{ product_id: 'prod-1', quantity: 2 }]);
            Product.findAll = jest.fn().mockResolvedValue([product]);

            await expect(orderService.cancelOrder('user-1', 'shop-1', 'order-1'))
                .rejects.toBe(restoreError);

            expect(mockOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({ order_status: 'cancelled' }),
                { transaction },
            );
            expect(transaction.rollback).toHaveBeenCalledTimes(1);
            expect(transaction.commit).not.toHaveBeenCalled();
        });

        it('does not let generic order updates bypass the cancellation path', async () => {
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { order_status: 'cancelled' }))
                .rejects.toMatchObject({ status: 409, code: 'ORDER_CANCELLATION_PATH_REQUIRED' });

            expect(Order.findOne).not.toHaveBeenCalled();
            expect(OrderItem.findAll).not.toHaveBeenCalled();
            expect(Product.findAll).not.toHaveBeenCalled();
        });

        it('does NOT touch stock for a non-cancel status change', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.updateOrder('order-1', 'user-1', 'shop-1', { order_status: 'processing' });

            expect(mockOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({ order_status: 'processing' }),
                { transaction: expect.any(Object) }
            );
            expect(Product.findOne).not.toHaveBeenCalled();
        });

        it('records an explicit payment method correction in the order audit log', async () => {
            const mockOrder = createMockOrder({
                order_status: 'confirmed',
                payment_method: null,
                metadata: {},
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_method: 'cod' });

            expect(mockOrder.update).toHaveBeenCalledWith(expect.objectContaining({
                payment_method: 'cod',
                metadata: expect.objectContaining({
                    audit_log: [expect.objectContaining({
                        changed_by: 'user-1',
                        changes: { payment_method: { from: null, to: 'cod' } },
                    })],
                }),
            }), { transaction: expect.any(Object) });
        });

        it.each(['cod', 'cash', 'cash_on_delivery'])(
            'does not allow generic updates to settle COD method %s',
            async (payment_method) => {
                const mockOrder = createMockOrder({
                    order_status: 'confirmed',
                    payment_status: 'unpaid',
                    payment_method,
                    metadata: {},
                });
                Order.findOne = jest.fn().mockResolvedValue(mockOrder);
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

                await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_status: 'paid' }))
                    .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });
                expect(mockOrder.update).not.toHaveBeenCalled();
                expect(CourierDispatch.findOne).not.toHaveBeenCalled();
            },
        );

        it('does not allow a generic update to set COD and paid together', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', payment_status: 'unpaid', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', {
                payment_method: 'Cash on Delivery',
                payment_status: 'paid',
            })).rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('does not allow a COD order to be changed to non-COD and paid in one patch', async () => {
            const mockOrder = createMockOrder({
                order_status: 'confirmed',
                payment_status: 'unpaid',
                payment_method: 'COD',
                metadata: {},
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', {
                payment_method: 'bkash',
                payment_status: 'paid',
            })).rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });

            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('retains COD origin in the audit history to block a later generic paid patch', async () => {
            const mockOrder = createMockOrder({
                order_status: 'confirmed',
                payment_status: 'unpaid',
                payment_method: 'COD',
                metadata: {},
            });
            mockOrder.update = jest.fn(async function update(values) {
                Object.assign(this, values);
                return this;
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_method: 'bkash' });
            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_status: 'paid' }))
                .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });

            expect(mockOrder.payment_method).toBe('bkash');
            expect(mockOrder.update).toHaveBeenCalledTimes(1);
        });

        it('requires authoritative full delivery before generic order completion', async () => {
            const mockOrder = createMockOrder({ order_status: 'processing', delivery_status: null, metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            DeliveryTracking.findOne.mockResolvedValue(null);

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { order_status: 'completed' }))
                .rejects.toMatchObject({ status: 409, code: 'ORDER_COMPLETION_REQUIRES_DELIVERY' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('allows processing to completed only with authoritative full-delivery evidence', async () => {
            const mockOrder = createMockOrder({ order_status: 'processing', delivery_status: null, metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            DeliveryTracking.findOne.mockResolvedValue({ current_status: 'delivered' });
            CourierDispatch.findOne.mockResolvedValue(null);

            await orderService.updateOrder('order-1', 'user-1', 'shop-1', { order_status: 'completed' });

            expect(mockOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({ order_status: 'completed' }),
                { transaction: expect.any(Object) },
            );
        });

        it('rejects unsupported order status jumps', async () => {
            const mockOrder = createMockOrder({ order_status: 'draft', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { order_status: 'processing' }))
                .rejects.toMatchObject({ status: 409, code: 'ORDER_STATUS_TRANSITION_INVALID' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('does not let generic updates fabricate partial fulfillment', async () => {
            const mockOrder = createMockOrder({ order_status: 'processing', fulfillment_status: 'unfulfilled', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', {
                fulfillment_status: 'partially_fulfilled',
            })).rejects.toMatchObject({ status: 409, code: 'PARTIAL_FULFILLMENT_EVIDENCE_REQUIRED' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('does not let generic updates cancel fulfillment outside the cancellation path', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', fulfillment_status: 'unfulfilled', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', {
                fulfillment_status: 'cancelled',
            })).rejects.toMatchObject({ status: 409, code: 'FULFILLMENT_STATUS_SERVER_AUTHORITY' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it.each(['partially_fulfilled', 'fulfilled'])(
            'does not let generic updates regress %s fulfillment to unfulfilled',
            async (fulfillment_status) => {
                const mockOrder = createMockOrder({ order_status: 'processing', fulfillment_status, metadata: {} });
                Order.findOne = jest.fn().mockResolvedValue(mockOrder);
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

                await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', {
                    fulfillment_status: 'unfulfilled',
                })).rejects.toMatchObject({ status: 409, code: 'FULFILLMENT_STATUS_TRANSITION_INVALID' });
                expect(mockOrder.update).not.toHaveBeenCalled();
            },
        );

        it('allows fulfillment completion when an authoritative full-delivery status exists', async () => {
            const mockOrder = createMockOrder({
                order_status: 'processing',
                fulfillment_status: 'unfulfilled',
                delivery_status: 'delivered',
                metadata: {},
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            DeliveryTracking.findOne.mockResolvedValue(null);
            CourierDispatch.findOne.mockResolvedValue(null);

            await orderService.updateOrder('order-1', 'user-1', 'shop-1', { fulfillment_status: 'fulfilled' });

            expect(mockOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({ fulfillment_status: 'fulfilled' }),
                { transaction: expect.any(Object) },
            );
        });

        it('does not let a generic update write a courier destination', async () => {
            // Courier ids are only trusted after the courier's directory has
            // confirmed them; a generic write would store an unvalidated area.
            const mockOrder = createMockOrder({ order_status: 'confirmed', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', {
                delivery_location: { provider_destination: { redx: { area_id: 999 } } },
            })).rejects.toMatchObject({ status: 400, code: 'COURIER_DESTINATION_CONFIRM_REQUIRED' });

            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('records the delivery area text so booking can match it against the courier', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await orderService.updateOrder('order-1', 'user-1', 'shop-1', { delivery_area: 'Mirpur' });

            expect(mockOrder.update).toHaveBeenCalledWith(
                expect.objectContaining({ delivery_area: 'Mirpur' }),
                { transaction: expect.any(Object) },
            );
        });

        it('requires authoritative full delivery before generic fulfillment completion', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', delivery_status: null, metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            DeliveryTracking.findOne.mockResolvedValue(null);

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { fulfillment_status: 'fulfilled' }))
                .rejects.toMatchObject({ status: 409, code: 'FULFILLMENT_REQUIRES_DELIVERY' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('does not treat partial delivery as evidence for full fulfillment', async () => {
            const mockOrder = createMockOrder({ order_status: 'processing', delivery_status: 'partial_delivered', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            DeliveryTracking.findOne.mockResolvedValue({ current_status: 'partial_delivered' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { fulfillment_status: 'fulfilled' }))
                .rejects.toMatchObject({ status: 409 });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('refuses payment method correction after any active courier claim', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', payment_method: null, metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            CourierDispatch.findOne = jest.fn().mockResolvedValue({ status: 'COMMITTED' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_method: 'cod' }))
                .rejects.toMatchObject({ status: 409, code: 'COURIER_DISPATCH_ACTIVE' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it.each(['PENDING', 'INDETERMINATE', 'COMMITTED'])(
            'rejects status, address, phone, and item changes after a %s courier claim',
            async (status) => {
                const updates = [
                    { order_status: 'processing' },
                    { delivery_address: 'New address, Dhaka' },
                    { customer_phone: '01722222222' },
                    { items: [{ product_id: 'product-2', quantity: 2 }] },
                ];
                for (const update of updates) {
                    const mockOrder = createMockOrder({
                        order_status: 'confirmed',
                        delivery_address: 'Old address, Dhaka',
                        customer_phone: '01711111111',
                        items: [{ product_id: 'product-1', quantity: 1 }],
                        metadata: {},
                    });
                    Order.findOne = jest.fn().mockResolvedValue(mockOrder);
                    UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
                    CourierDispatch.findOne = jest.fn().mockResolvedValue({ status });

                    await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', update))
                        .rejects.toMatchObject({
                            status: 409,
                            code: 'COURIER_DISPATCH_ACTIVE',
                            message: expect.stringContaining('reconcile courier state'),
                        });
                    expect(mockOrder.update).not.toHaveBeenCalled();
                }
            },
        );

        it.each(['PENDING', 'INDETERMINATE', 'COMMITTED'])(
            'refuses payment status changes after a %s courier claim',
            async (status) => {
                const mockOrder = createMockOrder({ order_status: 'confirmed', payment_status: 'unpaid', metadata: {} });
                Order.findOne = jest.fn().mockResolvedValue(mockOrder);
                UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
                CourierDispatch.findOne = jest.fn().mockResolvedValue({ status });

                await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_status: 'paid' }))
                    .rejects.toMatchObject({ status: 409, code: 'COURIER_DISPATCH_ACTIVE' });
                expect(mockOrder.update).not.toHaveBeenCalled();
            },
        );

        it('refuses payment method correction when a legacy delivery tracking row exists', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', payment_method: null, metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            CourierDispatch.findOne = jest.fn().mockResolvedValue(null);
            DeliveryTracking.findOne = jest.fn().mockResolvedValue({ id: 'tracking-1', order_id: 'order-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_method: 'cod' }))
                .rejects.toMatchObject({ status: 409, code: 'PAYMENT_METHOD_LOCKED_AFTER_DISPATCH' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('refuses payment status changes when courier tracking exists', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', payment_status: 'unpaid', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            CourierDispatch.findOne = jest.fn().mockResolvedValue(null);
            DeliveryTracking.findOne = jest.fn().mockResolvedValue({ id: 'tracking-1', order_id: 'order-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_status: 'paid' }))
                .rejects.toMatchObject({ status: 409, code: 'PAYMENT_STATUS_LOCKED_AFTER_DISPATCH' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('resolves an ID-only COD method before allowing a paid transition', async () => {
            const mockOrder = createMockOrder({
                order_status: 'confirmed',
                payment_method: null,
                payment_method_id: 'cod-config-1',
                payment_status: 'unpaid',
                metadata: {},
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            PaymentConfig.findOne.mockResolvedValue({ gateway: 'cod' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_status: 'paid' }))
                .rejects.toMatchObject({ status: 409, code: 'COD_SETTLEMENT_PATH_REQUIRED' });

            expect(PaymentConfig.findOne).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'cod-config-1', shop_id: 'shop-1' },
                attributes: ['gateway'],
            }));
            expect(mockOrder.update).not.toHaveBeenCalled();
        });

        it('allows payment correction after a definitively failed dispatch claim', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', payment_status: 'unpaid', payment_method: 'bkash', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            CourierDispatch.findOne = jest.fn().mockResolvedValue(null);
            DeliveryTracking.findOne = jest.fn().mockResolvedValue(null);

            await orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_status: 'paid' });

            expect(CourierDispatch.findOne).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({ status: { [Op.in]: ['PENDING', 'INDETERMINATE', 'COMMITTED'] } }),
            }));
            expect(mockOrder.update).toHaveBeenCalledWith(expect.objectContaining({ payment_status: 'paid' }), {
                transaction: expect.any(Object),
            });
        });

        it('serializes concurrent payment corrections so both audit entries survive', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', payment_method: null, metadata: {} });
            mockOrder.update = jest.fn(async (updates) => {
                Object.assign(mockOrder, updates);
                return mockOrder;
            });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });
            CourierDispatch.findOne = jest.fn().mockResolvedValue(null);
            DeliveryTracking.findOne = jest.fn().mockResolvedValue(null);

            let transactionTail = Promise.resolve();
            sequelize.transaction = jest.fn(async (callback) => {
                const previous = transactionTail;
                let release;
                transactionTail = new Promise((resolve) => { release = resolve; });
                await previous;
                try {
                    return await callback({ LOCK: { UPDATE: 'UPDATE' } });
                } finally {
                    release();
                }
            });

            await Promise.all([
                orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_method: 'cod' }),
                orderService.updateOrder('order-1', 'user-1', 'shop-1', { payment_method: 'self-mfs' }),
            ]);

            expect(mockOrder.metadata.audit_log).toHaveLength(2);
            expect(mockOrder.metadata.audit_log.map((entry) => entry.changes.payment_method.to)).toEqual(['cod', 'self-mfs']);
        });

        it('does not transition an existing confirmed order back into Draft', async () => {
            const mockOrder = createMockOrder({ order_status: 'confirmed', metadata: {} });
            Order.findOne = jest.fn().mockResolvedValue(mockOrder);
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'user-shop-1' });

            await expect(orderService.updateOrder('order-1', 'user-1', 'shop-1', { order_status: 'draft' }))
                .rejects.toMatchObject({ status: 409, code: 'ORDER_STATUS_TRANSITION_INVALID' });
            expect(mockOrder.update).not.toHaveBeenCalled();
        });
    });

    describe('Helper Functions', () => {
        describe('isCodOrder', () => {
            it('should identify unpaid orders as COD', () => {
                const service = require('../order.service');
                // Test via createOrderInternal which uses this logic
            });
        });

        describe('calculateOrderTotals', () => {
            it('should calculate totals correctly', async () => {
                // Test through createOrder
            });
        });
    });

    // Creation supports documented nonterminal statuses, but terminal lifecycle
    // states must only be reached through their server-side transition paths.
    describe('State consistency at creation (Pilot+ F3)', () => {
        const runCreateInternal = async (orderDataOverrides) => {
            UserShop.findOne = jest.fn().mockResolvedValue({ id: 'us-1' });
            Product.findAll = jest.fn().mockResolvedValue([{
                id: 'prod-1', name: 'Test Product', price: 100.00, quantity: 10, track_quantity: false,
            }]);
            Order.create = jest.fn().mockImplementation((data) => Promise.resolve({
                ...createMockOrder(), ...data,
            }));
            OrderItem.create = jest.fn().mockResolvedValue({ id: 'item-1' });

            return orderService.createOrderInternal('shop-1', {
                customer_name: 'Test',
                customer_phone: '01712345678',
                items: [{ product_id: 'prod-1', quantity: 1 }],
                payment_status: 'pending',
                ...orderDataOverrides,
            });
        };

        it.each(['confirmed', 'processing', 'draft', 'pending'])(
            'creation preserves nonterminal status "%s"',
            async (status) => {
                const order = await runCreateInternal({ order_status: status });
                expect(order.order_status).toBe(status);
            }
        );

        it('legacy nonterminal statuses placed and paid are still recognized', async () => {
            for (const status of ['placed', 'paid']) {
                const order = await runCreateInternal({ order_status: status });
                expect(order.order_status).toBe(status);
            }
        });

        it.each(['completed', 'fulfilled', 'cancelled', 'delivered', 'refunded'])(
            'rejects terminal status "%s" before creating the order',
            async (status) => {
                await expect(runCreateInternal({ order_status: status })).rejects.toMatchObject({
                    status: 400,
                    code: 'ORDER_STATUS_SERVER_AUTHORITY',
                });
                expect(Order.create).not.toHaveBeenCalled();
                expect(OrderItem.create).not.toHaveBeenCalled();
                expect(Product.findAll).not.toHaveBeenCalled();
            }
        );

        it('a genuinely unknown status is still coerced to draft', async () => {
            const order = await runCreateInternal({ order_status: 'not-a-real-state' });
            expect(order.order_status).toBe('draft');
        });

        it('an invalid payment_status is still coerced to pending', async () => {
            const order = await runCreateInternal({ payment_status: 'weird' });
            expect(order.payment_status).toBe('pending');
        });
    });
});
