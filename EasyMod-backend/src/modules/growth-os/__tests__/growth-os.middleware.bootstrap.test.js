'use strict';

const mockRoleCache = new Map();

jest.mock('../../../config/config', () => ({
    env: 'test',
    growthOsEnabled: true,
}));

jest.mock('../../../config/redis', () => ({
    cacheRedis: { status: 'ready', _isMemoryFallback: false },
}));

jest.mock('../../../utils/cache.service', () => ({
    get: jest.fn(async (key) => mockRoleCache.get(key) ?? null),
    set: jest.fn(async (key, value) => mockRoleCache.set(key, value)),
    getStrict: jest.fn(async (key) => mockRoleCache.get(key) ?? null),
    setStrict: jest.fn(async (key, value) => mockRoleCache.set(key, value)),
}));

jest.mock('../growth-os.repository', () => ({
    findActiveRoleForUser: jest.fn(async () => null),
}));

const { requireGrowthOsAccess } = require('../growth-os.middleware');

function runGuard(user) {
    const next = jest.fn();
    const req = { user };
    return requireGrowthOsAccess()(req, {}, next).then(() => ({ req, next }));
}

describe('Growth OS initial-admin authorization boundary', () => {
    beforeEach(() => {
        mockRoleCache.clear();
    });

    test('returns the pending role-grant boundary without granting Growth access', async () => {
        const { req, next } = await runGuard({ userId: 'bootstrap-user', bootstrapOperator: true });

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            status: 403,
            code: 'GROWTH_OS_BOOTSTRAP_PENDING',
        }));
        expect(req.growthOs).toBeUndefined();
    });

    test('keeps the pending grant boundary even when an MFA claim is present', async () => {
        const { req, next } = await runGuard({
            userId: 'bootstrap-user',
            bootstrapOperator: true,
            mfaVerified: true,
        });

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            status: 403,
            code: 'GROWTH_OS_BOOTSTRAP_PENDING',
        }));
        expect(req.growthOs).toBeUndefined();
    });

    test('keeps ordinary shop-less users on the existing generic denial', async () => {
        const { next } = await runGuard({ userId: 'ordinary-user' });

        expect(next).toHaveBeenCalledWith(expect.objectContaining({
            status: 403,
            code: 'GROWTH_OS_FORBIDDEN',
        }));
    });
});
