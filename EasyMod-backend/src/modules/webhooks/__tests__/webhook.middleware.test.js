'use strict';

/**
 * bKash webhook TRANSPORT gate (§4.2, §7 row 9, D-9 caveat).
 *
 * The HMAC over the raw body is a deployment shared-secret gate, NOT a bKash
 * signature scheme (the old "B1/B17" claim was invented and is removed). Its
 * only promise: unauthenticated junk never reaches the handler. Settlement
 * evidence comes from the server-side Query inside payment-webhook.controller
 * — pinned in payment-webhook.controller.test.js. Fixtures here are
 * contract-mock (§4.2 posture), never live-provider-verified (R-12).
 */

const crypto = require('crypto');
const { validateBkashSignature, validateWebhookSignature } = require('../webhook.middleware');

describe('bKash verified system mutation context', () => {
    const previousSecret = process.env.BKASH_WEBHOOK_SECRET;

    beforeEach(() => {
        process.env.BKASH_WEBHOOK_SECRET = 'integration-test-webhook-secret';
    });

    afterAll(() => {
        if (previousSecret === undefined) delete process.env.BKASH_WEBHOOK_SECRET;
        else process.env.BKASH_WEBHOOK_SECRET = previousSecret;
    });

    test('marks the request with verified signature and event identity after HMAC validation', async () => {
        const body = { paymentID: 'payment-test-1', trxID: 'transaction-test-1' };
        const rawBody = Buffer.from(JSON.stringify(body));
        const signature = crypto.createHmac('sha256', process.env.BKASH_WEBHOOK_SECRET).update(rawBody).digest('hex');
        const req = {
            body,
            rawBody,
            headers: { 'x-bkash-signature': signature },
        };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        await validateBkashSignature(req, res, next);

        expect(next).toHaveBeenCalledWith();
        expect(req.webhookSignatureVerified).toBe(true);
        expect(req.webhookSignatureSource).toBe('bkash');
        expect(req.webhookEventId).toBe('payment-test-1');
    });

    test('tokenized v2 paymentId spelling is also accepted as the event id', async () => {
        const body = { paymentId: 'payment-test-2' };
        const rawBody = Buffer.from(JSON.stringify(body));
        const signature = crypto.createHmac('sha256', process.env.BKASH_WEBHOOK_SECRET).update(rawBody).digest('hex');
        const req = { body, rawBody, headers: { 'x-bkash-signature': signature } };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        await validateBkashSignature(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.webhookEventId).toBe('payment-test-2');
    });

    test('fails closed with 503 when the deployment secret is not configured (inert R-12)', async () => {
        delete process.env.BKASH_WEBHOOK_SECRET;
        const req = { body: { paymentID: 'x' }, rawBody: Buffer.from('{}'), headers: {} };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        await validateBkashSignature(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(503);
        expect(req.webhookSignatureVerified).toBeUndefined();
    });

    test('rejects a missing header with 401 and a wrong signature with 401', async () => {
        const body = { paymentID: 'payment-test-3' };
        const rawBody = Buffer.from(JSON.stringify(body));
        const noHeader = { body, rawBody, headers: {} };
        const resA = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const nextA = jest.fn();
        await validateBkashSignature(noHeader, resA, nextA);
        expect(resA.status).toHaveBeenCalledWith(401);
        expect(nextA).not.toHaveBeenCalled();

        const wrong = {
            body, rawBody,
            headers: { 'x-bkash-signature': crypto.createHmac('sha256', 'other-secret').update(rawBody).digest('hex') },
        };
        const resB = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const nextB = jest.fn();
        await validateBkashSignature(wrong, resB, nextB);
        expect(resB.status).toHaveBeenCalledWith(401);
        expect(nextB).not.toHaveBeenCalled();
    });

    test('unknown gateways never reach a handler', () => {
        const middleware = validateWebhookSignature('nagad');
        const req = { body: {}, headers: {} };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();
        middleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });
});
