'use strict';

const express = require('express');
const request = require('supertest');

const identity = {
    user: { userId: 'merchant-1', shopId: 'shop-1', role: 'admin' },
    platformRole: null,
};
const mockUserFindByPk = jest.fn();

jest.mock('../../modules/entities', () => ({
    User: { findByPk: mockUserFindByPk },
}));
jest.mock('../../utils/cache.service', () => ({
    get: jest.fn(async () => null),
    set: jest.fn(async () => true),
}));
jest.mock('../../utils/sse-bus', () => ({
    getBus: () => ({
        subscribe: jest.fn(async () => undefined),
        unsubscribe: jest.fn(async () => undefined),
        publish: jest.fn(async () => undefined),
        getReplay: jest.fn(async () => []),
    }),
}));
jest.mock('../../middleware/auth.middleware', () => ({
    authenticate: (...args) => {
        const middleware = (req, _res, next) => {
            req.user = { ...identity.user };
            next();
        };
        return args.length === 1 ? middleware : middleware(...args);
    },
}));
jest.mock('../../modules/audit/audit.controller', () => ({
    getAuditLogs: jest.fn(),
    getResourceAuditLogs: jest.fn(),
    cleanupIdempotencyKeys: (_req, res) => res.status(200).json({ success: true }),
}));
jest.mock('../../modules/knowledge/knowledge.controller', () => ({
    getKnowledge: jest.fn(),
    updateBrandingRules: jest.fn(),
    searchFaq: jest.fn(),
    getPolicies: jest.fn(),
    normalizeLanguage: jest.fn(),
    cacheLanguageLearning: (_req, res) => res.status(200).json({ success: true }),
    queryKnowledge: jest.fn(),
    listFaqs: jest.fn(),
    createFaq: jest.fn(),
    updateFaq: jest.fn(),
    deleteFaq: jest.fn(),
    // 20261126_001 lifecycle routes mounted by knowledge.routes (the suite
    // exercises route loading + auth, not these handlers).
    archiveFaq: jest.fn(),
    restoreFaq: jest.fn(),
    resyncFaq: jest.fn(),
    listGaps: jest.fn(),
    listDocuments: jest.fn(),
    createDocument: jest.fn(),
    deleteDocument: jest.fn(),
}));
jest.mock('../../modules/knowledge/knowledge.validator', () => ({
    getKnowledge: {},
    updateBrandingRules: {},
    createFaq: {},
    updateFaq: {},
    deleteFaq: {},
    faqId: {},
    createDocument: {},
    deleteDocument: {},
}));

const auditRoutes = require('../../modules/audit/audit.routes');
const knowledgeRoutes = require('../../modules/knowledge/knowledge.routes');
const sseManager = require('../../utils/sse-manager');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/audit', auditRoutes);
    app.use('/knowledge', knowledgeRoutes);
    app.use((error, _req, res, _next) => {
        res.status(error.status || 500).json({ code: error.code });
    });
    return app;
}

describe('cross-tenant administrative route guards', () => {
    let app;

    beforeEach(() => {
        identity.platformRole = null;
        mockUserFindByPk.mockResolvedValue({ platform_role: null });
        app = buildApp();
    });

    test('shop admin is denied both global mutation endpoints', async () => {
        const auditResponse = await request(app).post('/audit/cleanup');
        const knowledgeResponse = await request(app)
            .post('/knowledge/language/cache-learning')
            .send({ banglish: 'taka', english: 'money' });

        expect(auditResponse.status).toBe(403);
        expect(knowledgeResponse.status).toBe(403);
    });

    test('platform super admin can invoke both guarded endpoints', async () => {
        identity.platformRole = 'SUPER_ADMIN';
        mockUserFindByPk.mockResolvedValue({ platform_role: 'SUPER_ADMIN' });

        const auditResponse = await request(app).post('/audit/cleanup');
        const knowledgeResponse = await request(app)
            .post('/knowledge/language/cache-learning')
            .send({ banglish: 'taka', english: 'money' });

        expect(auditResponse.status).toBe(200);
        expect(knowledgeResponse.status).toBe(200);
    });
});

describe('local SSE membership revocation', () => {
    test('disconnects every local stream for the user and leaves other users connected', () => {
        const revokedShopOne = { end: jest.fn() };
        const revokedShopTwo = { end: jest.fn() };
        const unaffected = { end: jest.fn() };

        sseManager.register('shop-one', revokedShopOne, 'user-1');
        sseManager.register('shop-two', revokedShopTwo, 'user-1');
        sseManager.register('shop-two', unaffected, 'user-2');

        sseManager.disconnectUser('user-1');
        sseManager.disconnectUser('user-1');

        expect(revokedShopOne.end).toHaveBeenCalledTimes(1);
        expect(revokedShopTwo.end).toHaveBeenCalledTimes(1);
        expect(unaffected.end).not.toHaveBeenCalled();
    });
});
