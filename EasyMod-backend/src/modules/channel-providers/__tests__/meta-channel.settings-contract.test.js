'use strict';

const express = require('express');
const request = require('supertest');

const mockRole = { value: 'owner' };
const mockAuthenticate = jest.fn((req, _res, next) => {
    req.user = { userId: 'user-1', shopId: 'shop-1' };
    next();
});
const mockVerifyShopAccess = jest.fn((req, _res, next) => {
    req.userRole = mockRole.value;
    next();
});
const mockRequireOwner = jest.fn((req, _res, next) => {
    if (req.userRole !== 'owner') {
        const error = new Error('Only shop owners can perform this action');
        error.status = 403;
        return next(error);
    }
    next();
});
const mockUpdateChannelSettings = jest.fn((req, res) => {
    res.status(200).json({ success: true, data: req.body });
});

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: mockAuthenticate,
}));
jest.mock('../../../middleware/shop-access.middleware', () => ({
    verifyShopAccess: mockVerifyShopAccess,
}));
jest.mock('../../../middleware/shop-permission.middleware', () => ({
    requireOwner: mockRequireOwner,
}));
jest.mock('../meta-oauth.controller', () => ({
    initiate: jest.fn(),
    callback: jest.fn(),
    connectAsset: jest.fn(),
}));
jest.mock('../meta-channel.controller', () => ({
    list: jest.fn(),
    disconnect: jest.fn(),
    reconnect: jest.fn(),
    testWebhook: jest.fn(),
    getSettings: jest.fn(),
    updateChannelSettings: mockUpdateChannelSettings,
    updatePurposeLabel: jest.fn(),
    consentSummary: jest.fn(),
}));

const metaChannelRoutes = require('../meta-channel.routes');

const CHANNEL_ID = '00000000-0000-0000-0000-000000000001';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/channels/meta', metaChannelRoutes);
    app.use((err, _req, res, _next) => {
        res.status(err.status || 500).json({
            success: false,
            code: err.code,
            message: err.message,
        });
    });
    return app;
}

describe('Meta channel settings PATCH contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRole.value = 'owner';
    });

    test.each([
        ['automationMode', { automationMode: 'AUTO' }],
        ['aiAutoReply', { aiAutoReply: false }],
        ['automation_mode', { automation_mode: 'AUTO' }],
        ['ai_auto_reply', { ai_auto_reply: false }],
    ])('rejects %s with a stable validation error', async (key, body) => {
        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send(body);

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
            },
        });
        expect(response.body.error.details).toEqual(expect.arrayContaining([
            expect.objectContaining({
                field: key,
                message: `${key} is not supported for Page settings; configure the business AI reply mode instead`,
                location: 'body',
            }),
        ]));
        expect(mockUpdateChannelSettings).not.toHaveBeenCalled();
    });

    test('rejects a non-owner before the settings handler', async () => {
        mockRole.value = 'admin';

        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send({ allowOrderCreation: false });

        expect(response.status).toBe(403);
        expect(response.body.message).toBe('Only shop owners can perform this action');
        expect(mockUpdateChannelSettings).not.toHaveBeenCalled();
    });

    test('accepts the supported Page settings', async () => {
        const body = {
            businessHours: { mon: { open: '09:00', close: '18:00' } },
            confidenceThresholdSend: 0.8,
            confidenceThresholdSuggest: 0.5,
            allowOrderCreation: false,
        };

        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send(body);

        expect(response.status).toBe(200);
        expect(mockUpdateChannelSettings).toHaveBeenCalledTimes(1);
        expect(mockUpdateChannelSettings.mock.calls[0][0].body).toEqual(body);
    });

    // ── ADR-0013 §9 amendment: top-level mode keys stay forbidden while the
    //    nested narrow-only override is accepted by the route contract. ──
    test('accepts an overrides object (narrow-only enforcement is service-side)', async () => {
        const body = {
            overrides: {
                automation_mode: 'DRAFT',
                confidence_threshold: 80,
                greeting: { enabled: true, custom_text: 'Hello' },
            },
        };

        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send(body);

        expect(response.status).toBe(200);
        expect(mockUpdateChannelSettings).toHaveBeenCalledTimes(1);
    });

    test('accepts overrides.automation_mode aliases and null revert markers', async () => {
        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send({ overrides: { automation_mode: 'AI_SUGGEST_ONLY', confidence_threshold: null } });

        expect(response.status).toBe(200);
    });

    test('accepts overrides:null as "no override changes"', async () => {
        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send({ overrides: null });

        expect(response.status).toBe(200);
    });

    test.each([
        ['unknown override key', { overrides: { model_preset: 'advanced' } }],
        ['out-of-range threshold', { overrides: { confidence_threshold: 150 } }],
        ['unknown automation mode', { overrides: { automation_mode: 'TURBO' } }],
        ['overlong greeting', { overrides: { greeting: { custom_text: 'x'.repeat(501) } } }],
        ['empty greeting', { overrides: { greeting: {} } }],
    ])('rejects %s at the route boundary', async (_label, body) => {
        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send(body);

        expect(response.status).toBe(400);
        expect(mockUpdateChannelSettings).not.toHaveBeenCalled();
    });

    test('accepts both business-hours shapes, overnight ranges, and a valid IANA timezone', async () => {
        const body = {
            businessHours: {
                mon: { open: '22:00', close: '06:00' },
                tue: [{ open: '09:00', close: '12:00' }, { open: '14:00', close: '18:00' }],
                timezone: 'America/New_York',
            },
        };

        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send(body);

        expect(response.status).toBe(200);
    });

    test.each([
        ['bad HH:MM', { businessHours: { mon: { open: '9:00', close: '18:00' } } }],
        ['unknown day key', { businessHours: { funday: { open: '09:00', close: '18:00' } } }],
        ['invalid timezone', { businessHours: { mon: { open: '09:00', close: '18:00' }, timezone: 'Mars/Olympus' } }],
        ['unknown slot key', { businessHours: { mon: { open: '09:00', close: '18:00', lunch: true } } }],
    ])('rejects tightened business hours: %s', async (_label, body) => {
        const response = await request(buildApp())
            .patch(`/api/channels/meta/${CHANNEL_ID}/settings`)
            .send(body);

        expect(response.status).toBe(400);
        expect(mockUpdateChannelSettings).not.toHaveBeenCalled();
    });
});
