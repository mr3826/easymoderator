'use strict';

/**
 * Commercial tenant-scope security (ADR-0011).
 *
 * Two independent checks:
 *  1. Source scan — the /api/commercial router declares JWT authentication and
 *     verified shop access before any handler, and no layer reads a shop id
 *     from a client-controlled input (query, body, header, params).
 *  2. Runtime — with a forged shopId in the query string, the controller still
 *     scopes every read to the authenticated req.shop.id; a foreign billing
 *     line is a 403, never an empty/cross-tenant read.
 *
 * Mirrors src/security/__tests__/ai-mutation-boundary.security.test.js: static
 * boundary plus a behavioural assertion, no network and no database.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../../modules/commercial/claim-gate.service', () => ({
    evaluateClaim: jest.fn(),
}));
jest.mock('../../modules/commercial/commercial-query.service', () => ({
    listBillingLines: jest.fn(),
}));
jest.mock('../../modules/entities', () => ({
    BillingLine: { findAll: jest.fn() },
}));

const claimGate = require('../../modules/commercial/claim-gate.service');
const commercialQuery = require('../../modules/commercial/commercial-query.service');
const controller = require('../../modules/commercial/commercial.controller');
const { BillingLine } = require('../../modules/entities');

const backendRoot = path.resolve(__dirname, '../../..');
const readSource = (...segments) => fs.readFileSync(path.join(backendRoot, ...segments), 'utf8');

const routesSource = readSource('src', 'modules', 'commercial', 'commercial.routes.js');
const controllerSource = readSource('src', 'modules', 'commercial', 'commercial.controller.js');
const mountSource = readSource('src', 'modules', 'routes.js');

// `jest.mock` replaces the module for the controller, but the tenant rule lives
// in the real service; load the real implementation for the 403 assertions.
const realQueryService = jest.requireActual('../../modules/commercial/commercial-query.service');

const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('commercial routes tenant scope', () => {
    beforeEach(() => jest.clearAllMocks());

    test('the router mounts JWT auth + verified shop access before every handler', () => {
        expect(mountSource).toContain("router.use('/commercial'");

        const authIndex = routesSource.indexOf('router.use(authenticate)');
        const shopIndex = routesSource.indexOf('router.use(verifyShopAccess)');
        const firstRoute = routesSource.search(/router\.(get|post|put|patch|delete)\(/);

        expect(authIndex).toBeGreaterThan(-1);
        expect(shopIndex).toBeGreaterThan(authIndex);
        expect(firstRoute).toBeGreaterThan(shopIndex);
        expect(routesSource).toMatch(/require\(['"]\.\.\/\.\.\/middleware\/shop-access\.middleware['"]\)/);
    });

    test('no commercial layer reads a shop id from client-controlled input', () => {
        const clientShopId = /req\.(?:query|body|params|headers)[\s\S]{0,40}?(?:shopId|shop_id|'x-shop-id'|x-shop-id)/i;
        expect(routesSource).not.toMatch(clientShopId);
        expect(controllerSource).not.toMatch(clientShopId);
        // The only tenant source is the authenticated request's verified shop.
        expect(controllerSource).toContain('req.shop?.id');
    });

    test('claims evaluation is scoped to the authenticated shop even with a forged query shopId', async () => {
        claimGate.evaluateClaim.mockResolvedValue({ claimId: 'billing.delivered_order' });
        const req = {
            shop: { id: 'shop-authenticated' },
            query: { surface: 'pricing', locale: 'en', shopId: 'shop-other', shop_id: 'shop-other' },
        };
        const res = { json: jest.fn() };
        const next = jest.fn();

        await controller.getClaims(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(claimGate.evaluateClaim).toHaveBeenCalled();
        const scopedShopIds = claimGate.evaluateClaim.mock.calls.map(([, context]) => context.shopId);
        expect(new Set(scopedShopIds)).toEqual(new Set(['shop-authenticated']));
        expect(scopedShopIds).not.toContain('shop-other');
    });

    test('billing-line reads pass the authenticated shop id, never the query shopId', async () => {
        commercialQuery.listBillingLines.mockResolvedValue([]);
        const req = {
            shop: { id: 'shop-authenticated' },
            query: { invoiceId: INVOICE_ID, shopId: 'shop-other' },
        };
        const res = { json: jest.fn() };

        await controller.getBillingLines(req, res, jest.fn());

        expect(commercialQuery.listBillingLines).toHaveBeenCalledWith({
            shopId: 'shop-authenticated',
            invoiceId: INVOICE_ID,
        });
    });

    test('a missing authenticated shop context is a 403, never a query fallback', async () => {
        const next = jest.fn();
        await controller.getContract({ shop: null, query: { shopId: 'shop-other' } }, { json: jest.fn() }, next);

        expect(next).toHaveBeenCalledTimes(1);
        const error = next.mock.calls[0][0];
        expect(error).toMatchObject({ status: 403, code: 'SHOP_CONTEXT_REQUIRED' });
    });

    test('a billing line owned by another shop is a 403, not an empty or cross-tenant read', async () => {
        BillingLine.findAll.mockResolvedValue([
            { id: 'line-1', shop_id: 'shop-other', invoice_id: INVOICE_ID, amount_minor: 1000 },
        ]);

        await expect(realQueryService.listBillingLines({
            shopId: 'shop-authenticated',
            invoiceId: INVOICE_ID,
        })).rejects.toMatchObject({ status: 403, code: 'INVOICE_FORBIDDEN' });
    });

    test('the same-shop billing lines are returned with integer money and contract version', async () => {
        BillingLine.findAll.mockResolvedValue([
            {
                id: 'line-1',
                shop_id: 'shop-authenticated',
                invoice_id: INVOICE_ID,
                amount_minor: 1000,
                unit_price_minor: 1000,
                currency: 'BDT',
                contract_version: '1.0.0',
                created_at: '2026-11-14T00:00:00.000Z',
            },
        ]);

        const lines = await realQueryService.listBillingLines({
            shopId: 'shop-authenticated',
            invoiceId: INVOICE_ID,
        });

        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            id: 'line-1',
            invoiceId: INVOICE_ID,
            amountMinor: 1000,
            unitPriceMinor: 1000,
            currency: 'BDT',
            contractVersion: '1.0.0',
        });
    });
});