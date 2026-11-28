'use strict';

jest.mock('../product.service', () => ({
    createProduct: jest.fn(),
}));
jest.mock('../product-link.service', () => ({}));
jest.mock('../product-upsell.service', () => ({}));
jest.mock('../product-stock-exceptions.service', () => ({}));
jest.mock('../product-overview.service', () => ({}));
jest.mock('../../../utils/image-upload.service', () => ({ publicBaseUrl: '', storeProductImage: jest.fn() }));
jest.mock('../product-media.service', () => ({ removeProductMedia: jest.fn() }));
jest.mock('../../../constants/http-status', () => ({ HTTP_STATUS: { BAD_REQUEST: 400, CREATED: 201 } }));

const productService = require('../product.service');
const controller = require('../product.controller');

function response() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

describe('product create idempotency key', () => {
    beforeEach(() => jest.clearAllMocks());

    it('uses Idempotency-Key as the stable usage request id for REST and legacy creates', async () => {
        productService.createProduct.mockResolvedValue({ id: 'product-1' });
        const body = { name: 'Product', price: 50 };
        const req = {
            user: { userId: 'user-1', shopId: 'shop-1' },
            body,
            headers: { 'idempotency-key': 'ai-row-operation-1' },
        };
        const restResponse = response();
        const legacyResponse = response();

        await controller.createProductRest(req, restResponse, jest.fn());
        await controller.createProduct(req, legacyResponse, jest.fn());

        expect(productService.createProduct).toHaveBeenNthCalledWith(1, 'user-1', 'shop-1', body, 'ai-row-operation-1');
        expect(productService.createProduct).toHaveBeenNthCalledWith(2, 'user-1', 'shop-1', body, 'ai-row-operation-1');
        expect(restResponse.status).toHaveBeenCalledWith(201);
        expect(legacyResponse.status).toHaveBeenCalledWith(201);
    });

    it('falls back to the request trace id and rejects oversized idempotency keys', async () => {
        productService.createProduct.mockResolvedValue({ id: 'product-1' });
        const body = { name: 'Product', price: 50 };
        const fallbackResponse = response();
        await controller.createProductRest({
            user: { userId: 'user-1', shopId: 'shop-1' },
            body,
            id: 'trace-request-1',
            headers: {},
        }, fallbackResponse, jest.fn());

        expect(productService.createProduct).toHaveBeenCalledWith('user-1', 'shop-1', body, 'trace-request-1');

        const rejectedResponse = response();
        await controller.createProductRest({
            user: { userId: 'user-1', shopId: 'shop-1' },
            body,
            headers: { 'idempotency-key': 'x'.repeat(129) },
        }, rejectedResponse, jest.fn());
        expect(rejectedResponse.status).toHaveBeenCalledWith(400);
        expect(productService.createProduct).toHaveBeenCalledTimes(1);
    });
});
