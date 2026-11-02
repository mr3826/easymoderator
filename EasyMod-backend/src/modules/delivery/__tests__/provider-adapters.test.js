'use strict';

jest.mock('axios', () => ({
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
}));

const axios = require('axios');
const RedXProvider = require('../providers/redx.provider');
const PathaoProvider = require('../providers/pathao.provider');
const SteadfastProvider = require('../providers/steadfast.provider');
const { COURIER_REGISTRY } = require('../providers/provider.registry');
const { deliveryValidators } = require('../delivery.validator');

describe('courier provider adapters', () => {
    beforeEach(() => jest.clearAllMocks());

    test('RedX uses the environment host, documented auth header, endpoint, and timeout', async () => {
        process.env.REDX_REQUEST_TIMEOUT_MS = '3210';
        axios.get.mockResolvedValue({ data: { data: [{ id: 1 }] } });
        const provider = new RedXProvider({ api_key: 'redx-secret' }, true);

        await expect(provider.validateCredentials()).resolves.toEqual({
            valid: true,
            areas: [{ id: 1 }],
        });
        expect(axios.get).toHaveBeenCalledWith(
            'https://sandbox.redx.com.bd/v1.0.0-beta/areas',
            expect.objectContaining({
                timeout: 3210,
                headers: expect.objectContaining({
                    'API-ACCESS-TOKEN': 'Bearer redx-secret',
                }),
            }),
        );
        expect(axios.get.mock.calls[0][0]).not.toContain('/v1.0.0-beta/v1.0.0-beta');
        delete process.env.REDX_REQUEST_TIMEOUT_MS;
    });

    test('RedX normalizes parcel payload and latest tracking status', async () => {
        axios.post.mockResolvedValue({ data: { data: { tracking_number: 'RX-1', status: 'Initiated' } } });
        axios.get.mockResolvedValue({
            data: {
                tracking: [
                    { status: 'pickup-pending', created_at: '2026-01-01T00:00:00Z' },
                    { status: 'delivery-in-progress', created_at: '2026-01-02T00:00:00Z' },
                ],
            },
        });
        const provider = new RedXProvider({ api_key: 'secret' });

        await provider.createOrder({
            customer_name: 'Customer',
            customer_phone: '01700000000',
            customer_address: 'House 1',
            pickup_store_id: 'store-1',
        });
        expect(axios.post).toHaveBeenCalledWith(
            'https://openapi.redx.com.bd/v1.0.0-beta/parcels',
            expect.objectContaining({ pickup_store_id: 'store-1' }),
            expect.any(Object),
        );

        await expect(provider.getOrderStatus('RX-1')).resolves.toMatchObject({
            tracking_code: 'RX-1',
            delivery_status: 'delivery-in-progress',
        });
    });

    test('RedX provider errors carry status and redact the API key', async () => {
        axios.get.mockRejectedValue({
            response: {
                status: 401,
                data: { message: 'Invalid API-ACCESS-TOKEN: Bearer redx-secret' },
            },
        });
        const provider = new RedXProvider({ api_key: 'redx-secret' });

        const error = await provider.getAreas().catch((caught) => caught);
        expect(error).toMatchObject({ status: 401, statusCode: 401 });
        expect(error.message).toContain('RedX area lookup failed');
        expect(error.message).not.toContain('redx-secret');
    });

    test('Pathao provider errors carry status and redact access credentials', async () => {
        axios.get.mockRejectedValue({
            response: {
                status: 401,
                data: {
                    message: 'Bearer pathao-access-secret with pathao-client-secret',
                },
            },
        });
        const provider = new PathaoProvider({
            access_token: 'pathao-access-secret',
            client_secret: 'pathao-client-secret',
        });

        const error = await provider.getStores().catch((caught) => caught);
        expect(error).toMatchObject({ status: 401, statusCode: 401 });
        expect(error.message).toContain('Pathao stores fetch failed');
        expect(error.message).not.toContain('pathao-access-secret');
        expect(error.message).not.toContain('pathao-client-secret');
    });

    test('Steadfast order errors preserve provider 4xx status for claim recovery', async () => {
        axios.post.mockRejectedValue({
            response: { status: 422, data: { message: 'Invalid recipient phone' } },
        });
        const provider = new SteadfastProvider({ api_key: 'key', secret_key: 'secret' });

        const error = await provider.createOrder({ customer_phone: 'invalid' }).catch((caught) => caught);

        expect(error).toMatchObject({ status: 422, response: { status: 422 } });
        expect(error.message).toContain('Invalid recipient phone');
    });

    test('RedX credentials and registry statuses preserve the provider contract', async () => {
        await expect(new RedXProvider({}).validateCredentials()).resolves.toEqual({
            valid: false,
            error: 'RedX API key is required',
        });
        expect(axios.get).not.toHaveBeenCalled();
        expect(COURIER_REGISTRY.redx.statusMap['agent-area-change']).toBe('in_transit');
        expect(COURIER_REGISTRY.redx.statusMap.paid).toBe('paid');
        expect(COURIER_REGISTRY.redx.statusMap['unmapped-status']).toBeUndefined();
    });

    test('registry emits canonical RedX fields and maps pickup metadata', () => {
        const payload = COURIER_REGISTRY.redx.normalizePayload({
            order_number: 'ORD-1',
            customer_name: 'Customer',
            customer_phone: '01700000000',
            delivery_address: 'House 1',
            total: 100,
            item_weight: 1,
        }, {
            delivery_area: 'Dhanmondi',
            delivery_area_id: 7,
            pickup_store_id: 'store-1',
        });

        expect(payload).toEqual(expect.objectContaining({
            customer_address: 'House 1',
            delivery_area: 'Dhanmondi',
            delivery_area_id: 7,
            merchant_invoice_id: 'ORD-1',
            pickup_store_id: 'store-1',
            instruction: '',
        }));
        expect(payload).not.toHaveProperty('special_instruction');
    });

    test('all providers preserve an explicit zero collection amount ahead of order total fallbacks', () => {
        const orderData = {
            order_number: 'ORD-PREPAID',
            customer_name: 'Customer',
            customer_phone: '01700000000',
            delivery_address: 'House 1',
            total: 1200,
            cod_amount: 0,
        };

        expect(COURIER_REGISTRY.pathao.normalizePayload(orderData).amount_to_collect).toBe(0);
        expect(COURIER_REGISTRY.steadfast.normalizePayload(orderData).cod_amount).toBe(0);
        expect(COURIER_REGISTRY.redx.normalizePayload(orderData).cash_collection_amount).toBe(0);
    });

    test('Pathao production host, weight bounds, and asynchronous bulk response are supported', async () => {
        axios.post.mockResolvedValue({ status: 202, data: { code: 202, message: 'Accepted' } });
        const provider = new PathaoProvider({ access_token: 'token', refresh_token: 'refresh' });
        expect(provider.baseUrl).toBe('https://api-hermes.pathao.com');

        await expect(provider.createBulkOrders([{ merchant_order_id: 'ORD-1' }])).resolves.toMatchObject({
            success: true,
            async: true,
        });
        expect(() => COURIER_REGISTRY.pathao.normalizePayload({
            order_number: 'ORD-1',
            customer_name: 'Customer',
            customer_phone: '01700000000',
            delivery_address: 'House 1',
            item_weight: 11,
        })).toThrow('between 0.5 and 10 kg');

        const payload = COURIER_REGISTRY.pathao.normalizePayload({
            order_number: 'ORD-1',
            customer_name: 'Customer',
            customer_phone: '01700000000',
            delivery_address: 'House 1',
        });
        expect(payload).not.toHaveProperty('recipient_city');
        expect(payload).not.toHaveProperty('recipient_zone');
        expect(payload).not.toHaveProperty('recipient_area');
    });

    test('Pathao exposes store info and the validator requires a RedX api_key', async () => {
        axios.get.mockResolvedValue({ data: { data: { store_id: 7, store_name: 'Main' } } });
        const provider = new PathaoProvider({ access_token: 'token' });

        await expect(provider.getStoreInfo(7)).resolves.toEqual({ store_id: 7, store_name: 'Main' });
        expect(axios.get).toHaveBeenCalledWith(
            'https://api-hermes.pathao.com/aladdin/api/v1/stores/7',
            expect.any(Object),
        );

        const result = deliveryValidators.connectProvider.validate({
            provider: 'redx',
            credentials: {},
        });
        expect(result.error?.details.map((detail) => detail.message)).toContain(
            'API Key is required for RedX',
        );
    });
});
