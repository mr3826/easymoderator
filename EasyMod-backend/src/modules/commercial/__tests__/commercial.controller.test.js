'use strict';

/**
 * UNIT lane — controller is HTTP-only. Services are mocked; these tests pin
 * tenant sourcing (req.shop.id only), surface validation, claim evaluation
 * fan-out and the 403 on a foreign invoice.
 */

const mockEvaluateClaim = jest.fn();
const mockListBillingLines = jest.fn();

jest.mock('../claim-gate.service', () => ({
    evaluateClaim: (...args) => mockEvaluateClaim(...args),
    renderClaim: jest.fn(),
}));

jest.mock('../commercial-query.service', () => ({
    listBillingLines: (...args) => mockListBillingLines(...args),
}));

const { AppError } = require('../../../utils/AppError');
const controller = require('../commercial.controller');
const {
    CLAIM_IDS,
    CLAIM_REGISTRY,
    registryHash,
} = require('../claim.registry');
const {
    COMMERCIAL_CONTRACT_VERSION,
    contractHash,
    COMMERCIAL_CONTRACT,
} = require('../commercial.contract');

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOP_ID = '22222222-2222-4222-8222-222222222222';

function makeRes() {
    const res = {
        statusCode: 200,
        body: null,
    };
    res.status = jest.fn((code) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((body) => {
        res.body = body;
        return res;
    });
    return res;
}

function makeReq(overrides = {}) {
    return {
        shop: { id: SHOP_ID },
        query: {},
        body: {},
        headers: {},
        ...overrides,
    };
}

const pricingClaimIds = CLAIM_IDS.filter((id) => CLAIM_REGISTRY[id].surfaces.includes('pricing'));

beforeEach(() => {
    jest.clearAllMocks();
    mockEvaluateClaim.mockImplementation(async (claimId) => ({
        claimId,
        available: true,
        render: 'claim',
        textKey: `claims.${claimId}.bn`,
    }));
    mockListBillingLines.mockResolvedValue([]);
});

describe('GET /api/commercial/contract', () => {
    it('serves the frozen contract, hashes and merchant claim allowlist', async () => {
        const res = makeRes();
        await controller.getContract(makeReq(), res, jest.fn());

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toMatchObject({
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            contractHash,
            registryHash,
        });
        expect(res.body.data.contract).toBe(COMMERCIAL_CONTRACT);
        // Internal-only claims never reach a merchant-facing payload.
        expect(res.body.data.claims.every((claim) => claim.id !== 'ai.reply_shadow_meter')).toBe(true);
        expect(res.body.data.claims.length).toBe(CLAIM_IDS.length - 1);
    });

    it('rejects a request without shop context', async () => {
        const next = jest.fn();
        await controller.getContract(makeReq({ shop: null }), makeRes(), next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
        expect(next.mock.calls[0][0].status).toBe(403);
        expect(next.mock.calls[0][0].code).toBe('SHOP_CONTEXT_REQUIRED');
    });
});

describe('GET /api/commercial/claims', () => {
    it('evaluates every claim registered to the surface, in order', async () => {
        const res = makeRes();
        await controller.getClaims(makeReq({ query: { surface: 'pricing' } }), res, jest.fn());

        expect(res.statusCode).toBe(200);
        expect(mockEvaluateClaim).toHaveBeenCalledTimes(pricingClaimIds.length);
        pricingClaimIds.forEach((claimId, index) => {
            expect(mockEvaluateClaim.mock.calls[index][0]).toBe(claimId);
            expect(mockEvaluateClaim.mock.calls[index][1]).toEqual({
                surface: 'pricing',
                locale: 'bn',
                shopId: SHOP_ID,
            });
        });
        expect(res.body.data).toMatchObject({
            surface: 'pricing',
            locale: 'bn',
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            registryHash,
        });
        expect(res.body.data.decisions).toHaveLength(pricingClaimIds.length);
    });

    it('reads shopId only from the JWT-derived req.shop, never query or body', async () => {
        await controller.getClaims(makeReq({
            query: { surface: 'pricing', shopId: OTHER_SHOP_ID },
            body: { shopId: OTHER_SHOP_ID },
            headers: { 'x-shop-id': OTHER_SHOP_ID },
        }), makeRes(), jest.fn());

        for (const call of mockEvaluateClaim.mock.calls) {
            expect(call[1].shopId).toBe(SHOP_ID);
        }
    });

    it('passes an explicit locale through', async () => {
        await controller.getClaims(makeReq({ query: { surface: 'pricing', locale: 'en' } }), makeRes(), jest.fn());
        expect(mockEvaluateClaim.mock.calls[0][1].locale).toBe('en');
    });

    it('rejects an unknown surface with 400', async () => {
        const next = jest.fn();
        await controller.getClaims(makeReq({ query: { surface: 'not-a-surface' } }), makeRes(), next);

        expect(mockEvaluateClaim).not.toHaveBeenCalled();
        expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
        expect(next.mock.calls[0][0].status).toBe(400);
        expect(next.mock.calls[0][0].code).toBe('UNKNOWN_CLAIM_SURFACE');
    });

    it('rejects a missing surface with 400', async () => {
        const next = jest.fn();
        await controller.getClaims(makeReq(), makeRes(), next);
        expect(next.mock.calls[0][0].code).toBe('UNKNOWN_CLAIM_SURFACE');
    });

    it('rejects a request without shop context', async () => {
        const next = jest.fn();
        await controller.getClaims(makeReq({ shop: null, query: { surface: 'pricing' } }), makeRes(), next);
        expect(next.mock.calls[0][0].status).toBe(403);
    });
});

describe('GET /api/commercial/billing-lines', () => {
    it('returns tenant-scoped billing lines from the query service', async () => {
        const lines = [{
            id: 'line-1',
            invoiceId: 'inv-1',
            orderId: 'order-1',
            outcome: 'DELIVERED',
            amountMinor: 1000,
            currency: 'BDT',
        }];
        mockListBillingLines.mockResolvedValue(lines);

        const res = makeRes();
        await controller.getBillingLines(makeReq({
            query: { invoiceId: 'inv-1', shopId: OTHER_SHOP_ID },
        }), res, jest.fn());

        expect(mockListBillingLines).toHaveBeenCalledWith({ shopId: SHOP_ID, invoiceId: 'inv-1' });
        expect(res.body.data).toEqual({
            invoiceId: 'inv-1',
            contractVersion: COMMERCIAL_CONTRACT_VERSION,
            lines,
        });
    });

    it('propagates the 403 for a foreign invoice', async () => {
        mockListBillingLines.mockRejectedValue(
            new AppError('Invoice does not belong to this shop', 403, 'INVOICE_FORBIDDEN'),
        );

        const next = jest.fn();
        await controller.getBillingLines(makeReq({ query: { invoiceId: 'inv-foreign' } }), makeRes(), next);

        expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
        expect(next.mock.calls[0][0].status).toBe(403);
        expect(next.mock.calls[0][0].code).toBe('INVOICE_FORBIDDEN');
    });

    it('rejects a request without shop context', async () => {
        const next = jest.fn();
        await controller.getBillingLines(makeReq({ shop: null, query: { invoiceId: 'inv-1' } }), makeRes(), next);
        expect(next.mock.calls[0][0].status).toBe(403);
        expect(mockListBillingLines).not.toHaveBeenCalled();
    });
});