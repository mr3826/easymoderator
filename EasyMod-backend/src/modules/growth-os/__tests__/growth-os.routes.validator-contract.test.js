'use strict';

/**
 * B6 (A9-R3, 2026-11-26) — growth-os ROUTE-LEVEL wire-contract pins.
 *
 * docs/growth-os/EXECUTION_STATE.md documents GROWTH_OS_PROSPECT_INVALID_INPUT
 * / GROWTH_OS_WORK_INVALID_INPUT as the codes a validator-edge rejection must
 * carry on these routes. F-7's global validate.middleware re-tagging to
 * 'VALIDATION_ERROR' made the validateProspect/validateWork wrappers dead for
 * their intended path (they only matched the old 'INTERNAL_ERROR' default) —
 * every Joi-shape rejection silently surfaced VALIDATION_ERROR instead.
 * These pins exercise the REAL router + REAL Joi validators (service layer,
 * auth and access middleware stubbed): a malformed body must come back with
 * the documented code, NOT VALIDATION_ERROR, and the controller must never
 * run. One route-level pin per wrapper.
 */
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const mockHandlers = {
    getSession: jest.fn(),
    grantRole: jest.fn(), revokeRole: jest.fn(),
    listEligibleAssignees: jest.fn(),
    listProspects: jest.fn(), createProspect: jest.fn(), checkDuplicates: jest.fn(),
    getProspect: jest.fn(), updateProspect: jest.fn(), transitionProspect: jest.fn(),
    assignProspect: jest.fn(), linkProspect: jest.fn(), linkageSuggestions: jest.fn(),
    mergeProspect: jest.fn(),
    home: jest.fn(), analytics: jest.fn(), search: jest.fn(),
    listFollowups: jest.fn(), createFollowup: jest.fn(), updateFollowup: jest.fn(),
    transitionFollowup: jest.fn(),
    listNotes: jest.fn(), createNote: jest.fn(), deleteNote: jest.fn(),
    listMerchants: jest.fn(), merchantDetail: jest.fn(),
    setMerchantStatus: jest.fn(), grantMerchantCredits: jest.fn(),
    requestChannelReconnect: jest.fn(), operations: jest.fn(), auditLogs: jest.fn(),
    listGrowthUsers: jest.fn(), createGrowthUser: jest.fn(), setUserStatus: jest.fn(),
    changeUserRole: jest.fn(), revokeUserAccess: jest.fn(), resetUserPassword: jest.fn(),
    revokeUserSessions: jest.fn(),
};

jest.mock('../../../middleware/auth.middleware', () => ({
    authenticate: Object.assign(
        (req, _res, next) => { req.user = { userId: 'growth-1', shopId: null }; next(); },
        { withOptions: () => (req, _res, next) => { req.user = { userId: 'growth-1', shopId: null }; next(); } },
    ),
}));
jest.mock('../growth-os.middleware', () => ({
    requireGrowthOsAccess: () => (_req, _res, next) => next(),
}));
jest.mock('../growth-os.prospect.scope', () => ({ hasProspectReadAccess: [] }));
jest.mock('../../../config/redis', () => ({ rateLimitRedis: { _isMemoryFallback: true } }));
jest.mock('../growth-os.controller', () => ({ getSession: mockHandlers.getSession }));
jest.mock('../growth-os.roles.controller', () => ({ grantRole: mockHandlers.grantRole, revokeRole: mockHandlers.revokeRole }));
jest.mock('../growth-os.prospect.controller', () => ({
    listEligibleAssignees: mockHandlers.listEligibleAssignees,
    listProspects: mockHandlers.listProspects,
    createProspect: mockHandlers.createProspect,
    checkDuplicates: mockHandlers.checkDuplicates,
    getProspect: mockHandlers.getProspect,
    updateProspect: mockHandlers.updateProspect,
    transitionProspect: mockHandlers.transitionProspect,
    assignProspect: mockHandlers.assignProspect,
    linkProspect: mockHandlers.linkProspect,
    linkageSuggestions: mockHandlers.linkageSuggestions,
    mergeProspect: mockHandlers.mergeProspect,
}));
jest.mock('../growth-os.workspace.controller', () => ({
    home: mockHandlers.home,
    analytics: mockHandlers.analytics,
    search: mockHandlers.search,
    listFollowups: mockHandlers.listFollowups,
    createFollowup: mockHandlers.createFollowup,
    updateFollowup: mockHandlers.updateFollowup,
    transitionFollowup: mockHandlers.transitionFollowup,
    listNotes: mockHandlers.listNotes,
    createNote: mockHandlers.createNote,
    deleteNote: mockHandlers.deleteNote,
}));
jest.mock('../growth-os.admin.controller', () => ({
    listMerchants: mockHandlers.listMerchants,
    merchantDetail: mockHandlers.merchantDetail,
    setMerchantStatus: mockHandlers.setMerchantStatus,
    grantMerchantCredits: mockHandlers.grantMerchantCredits,
    requestChannelReconnect: mockHandlers.requestChannelReconnect,
    operations: mockHandlers.operations,
    auditLogs: mockHandlers.auditLogs,
}));
jest.mock('../growth-os.users.controller', () => ({
    listGrowthUsers: mockHandlers.listGrowthUsers,
    createGrowthUser: mockHandlers.createGrowthUser,
    setUserStatus: mockHandlers.setUserStatus,
    changeUserRole: mockHandlers.changeUserRole,
    revokeUserAccess: mockHandlers.revokeUserAccess,
    resetUserPassword: mockHandlers.resetUserPassword,
    revokeUserSessions: mockHandlers.revokeUserSessions,
}));

const router = require('../growth-os.routes');

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/api/internal/growth-os', router);
    instance.use((err, _req, res, _next) => res
        .status(err.status || 500)
        .json({ success: false, code: err.code, message: err.message }));
    return instance;
}

beforeEach(() => jest.clearAllMocks());

describe('growth-os route validator wire contract (B6, A9-R3)', () => {
    test('malformed prospect body at the Joi edge ⇒ documented GROWTH_OS_PROSPECT_INVALID_INPUT, never VALIDATION_ERROR', async () => {
        // Invalid source enum + no business name + no channel key — pure
        // shape rejection at the validateProspect edge (service never runs).
        const res = await request(app())
            .post('/api/internal/growth-os/prospects')
            .send({ source: 'not_a_source' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('GROWTH_OS_PROSPECT_INVALID_INPUT');
        expect(res.body.code).not.toBe('VALIDATION_ERROR');
        expect(mockHandlers.createProspect).not.toHaveBeenCalled();
    });

    test('malformed work (followup) body at the Joi edge ⇒ documented GROWTH_OS_WORK_INVALID_INPUT, never VALIDATION_ERROR', async () => {
        // followups.create requires prospectId/dueAt/action — empty body is
        // an edge-shape rejection routed through validateWork.
        const res = await request(app())
            .post('/api/internal/growth-os/followups')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('GROWTH_OS_WORK_INVALID_INPUT');
        expect(res.body.code).not.toBe('VALIDATION_ERROR');
        expect(mockHandlers.createFollowup).not.toHaveBeenCalled();
    });

    test('the same validator rejection on another guarded route keeps its family code (wrapper is per-family, not global)', async () => {
        const res = await request(app())
            .post('/api/internal/growth-os/notes')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('GROWTH_OS_WORK_INVALID_INPUT');
        expect(mockHandlers.createNote).not.toHaveBeenCalled();
    });
});
