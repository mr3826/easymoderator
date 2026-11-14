'use strict';

/**
 * Business-wide AI emergency stop (ADR-0013 §6).
 *
 * Verifies atomic engage/resume semantics, source-aware authority, the MANUAL
 * rollback belt, idempotency, audit + SSE/cache side effects, and the "resume
 * keeps MANUAL" rule.
 */

jest.mock('../../../config/redis', () => ({
    cacheRedis: null,
    sessionRedis: null,
    rateLimitRedis: null,
    legacyRedis: null,
}));

jest.mock('../../auth/session-invalidation.service', () => ({
    invalidateUserSessions: jest.fn().mockResolvedValue(1),
}));

jest.mock('../../audit/audit.service', () => ({
    logOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../utils/shop-settings-cache', () => ({
    invalidateShopSettingsCaches: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../utils/sse-manager', () => ({
    emit: jest.fn(),
}));

jest.mock('../../entities', () => ({
    User: { findByPk: jest.fn(), findOne: jest.fn(), update: jest.fn() },
    Shop: { findByPk: jest.fn(), update: jest.fn() },
    UserShop: {
        findAll: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        destroy: jest.fn(),
    },
    Session: { update: jest.fn().mockResolvedValue([1]) },
    Subscription: { create: jest.fn() },
    Tenant: { findByPk: jest.fn() },
    GrowthOsUserRole: { findOne: jest.fn() },
    PushSubscription: { destroy: jest.fn() },
}));

const mockTransaction = {
    LOCK: { UPDATE: 'UPDATE' },
    commit: jest.fn(),
    rollback: jest.fn(),
};

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (callback) => {
            try {
                const result = await callback(mockTransaction);
                await mockTransaction.commit();
                return result;
            } catch (error) {
                await mockTransaction.rollback();
                throw error;
            }
        }),
    },
}));

const { Shop } = require('../../entities');
const AuditService = require('../../audit/audit.service');
const { invalidateShopSettingsCaches } = require('../../../utils/shop-settings-cache');
const sseManager = require('../../../utils/sse-manager');
const shopService = require('../shop.service');

function makeShop(overrides = {}) {
    const shop = {
        id: 'shop-1',
        settings: { ai: { automation_mode: 'AUTO', confidence_threshold: 80 } },
        is_active: true,
        ai_emergency_stop: false,
        ai_emergency_stop_at: null,
        ai_emergency_stop_by: null,
        ai_emergency_stop_source: null,
        ai_emergency_stop_prior_mode: null,
        update: jest.fn().mockImplementation(async (payload) => {
            Object.assign(shop, payload);
            return shop;
        }),
        toJSON: () => ({ id: 'shop-1' }),
        ...overrides,
    };
    return shop;
}

describe('shop.service emergency stop', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Shop.findByPk.mockReset();
        Shop.update.mockReset();
        Shop.update.mockResolvedValue([1]);
        mockTransaction.commit.mockReset();
        mockTransaction.rollback.mockReset();
    });

    test('engage snapshots the prior mode, sets the flag, writes MANUAL in one transaction, and audits', async () => {
        const shop = makeShop();
        Shop.findByPk.mockResolvedValue(shop);

        const state = await shopService.engageAiEmergencyStop('shop-1', 'user-1', { reason: 'incident' });

        expect(state).toEqual(expect.objectContaining({
            active: true,
            by: 'user-1',
            source: 'merchant',
            prior_mode: 'AUTO',
            already_active: false,
        }));
        expect(state.at).toBeInstanceOf(Date);

        // Conditional flag write with the snapshot columns.
        expect(Shop.update).toHaveBeenCalledWith(
            expect.objectContaining({
                ai_emergency_stop: true,
                ai_emergency_stop_by: 'user-1',
                ai_emergency_stop_source: 'merchant',
                ai_emergency_stop_prior_mode: 'AUTO',
            }),
            expect.objectContaining({ where: { id: 'shop-1', ai_emergency_stop: false } }),
        );

        // Rollback belt: MANUAL is written through the existing business setting.
        expect(shop.update).toHaveBeenCalledWith(
            expect.objectContaining({
                settings: expect.objectContaining({
                    ai: expect.objectContaining({ automation_mode: 'MANUAL' }),
                }),
            }),
            { transaction: mockTransaction },
        );

        expect(AuditService.logOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'AI_EMERGENCY_STOP_ENGAGED',
                shopId: 'shop-1',
                userId: 'user-1',
                metadata: expect.objectContaining({ prior_mode: 'AUTO', reason: 'incident' }),
            }),
            { transaction: mockTransaction, required: true },
        );

        expect(mockTransaction.commit).toHaveBeenCalled();
        expect(invalidateShopSettingsCaches).toHaveBeenCalledWith('shop-1');
        expect(sseManager.emit).toHaveBeenCalledWith(
            'shop-1',
            'emergency_stop_changed',
            expect.objectContaining({ active: true, source: 'merchant', prior_mode: 'AUTO' }),
        );
    });

    test('repeat engage is idempotent and preserves prior_mode/source/actor', async () => {
        const shop = makeShop({
            ai_emergency_stop: true,
            ai_emergency_stop_at: '2026-11-10T10:00:00.000Z',
            ai_emergency_stop_by: 'first-actor',
            ai_emergency_stop_source: 'merchant',
            ai_emergency_stop_prior_mode: 'AUTO',
        });
        Shop.findByPk.mockResolvedValue(shop);

        const state = await shopService.engageAiEmergencyStop('shop-1', 'second-actor');

        expect(state).toEqual({
            active: true,
            at: '2026-11-10T10:00:00.000Z',
            by: 'first-actor',
            source: 'merchant',
            prior_mode: 'AUTO',
            already_active: true,
        });
        // No second write, no belt re-application, no mode/stop SSE churn.
        expect(Shop.update).not.toHaveBeenCalled();
        expect(shop.update).not.toHaveBeenCalled();
        expect(sseManager.emit).not.toHaveBeenCalled();
    });

    test('a failure while writing the MANUAL belt aborts the transaction (atomicity)', async () => {
        const shop = makeShop();
        shop.update = jest.fn().mockRejectedValue(new Error('belt write failed'));
        Shop.findByPk.mockResolvedValue(shop);

        await expect(shopService.engageAiEmergencyStop('shop-1', 'user-1'))
            .rejects.toThrow('belt write failed');

        expect(mockTransaction.rollback).toHaveBeenCalled();
        expect(sseManager.emit).not.toHaveBeenCalled();
        expect(invalidateShopSettingsCaches).not.toHaveBeenCalled();
    });

    test('a lost conditional race reports the winning state unchanged', async () => {
        const shop = makeShop();
        const winningShop = makeShop({ ai_emergency_stop: true, ai_emergency_stop_prior_mode: 'AUTO' });
        Shop.findByPk
            .mockResolvedValueOnce(shop)
            .mockResolvedValueOnce(winningShop);
        Shop.update.mockResolvedValue([0]); // someone else engaged first

        const state = await shopService.engageAiEmergencyStop('shop-1', 'user-1');

        expect(state.active).toBe(true);
        expect(state.already_active).toBe(true);
        expect(shop.update).not.toHaveBeenCalled();
    });

    test('merchant resume of an admin-source stop is forbidden (403 EMERGENCY_STOP_ADMIN_SOURCE)', async () => {
        const shop = makeShop({
            ai_emergency_stop: true,
            ai_emergency_stop_source: 'admin',
            ai_emergency_stop_prior_mode: 'AUTO',
        });
        Shop.findByPk.mockResolvedValue(shop);

        await expect(shopService.resumeAiEmergencyStop('shop-1', 'user-1', { source: 'merchant' }))
            .rejects.toMatchObject({ status: 403, code: 'EMERGENCY_STOP_ADMIN_SOURCE' });

        expect(Shop.update).not.toHaveBeenCalled();
        expect(sseManager.emit).not.toHaveBeenCalled();
    });

    test('resume clears every column, keeps MANUAL, audits, and emits', async () => {
        const shop = makeShop({
            ai_emergency_stop: true,
            ai_emergency_stop_source: 'merchant',
            ai_emergency_stop_prior_mode: 'AUTO',
            ai_emergency_stop_at: '2026-11-10T10:00:00.000Z',
            ai_emergency_stop_by: 'user-1',
            settings: { ai: { automation_mode: 'MANUAL' } },
        });
        Shop.findByPk.mockResolvedValue(shop);

        const state = await shopService.resumeAiEmergencyStop('shop-1', 'user-1');

        expect(state).toEqual({
            active: false,
            automation_mode: 'MANUAL',
            prior_mode: 'AUTO',
            already_inactive: false,
        });
        expect(Shop.update).toHaveBeenCalledWith(
            {
                ai_emergency_stop: false,
                ai_emergency_stop_at: null,
                ai_emergency_stop_by: null,
                ai_emergency_stop_source: null,
                ai_emergency_stop_prior_mode: null,
            },
            { where: { id: 'shop-1' }, transaction: mockTransaction },
        );
        // Resume never rewrites the business mode.
        expect(shop.update).not.toHaveBeenCalled();
        expect(AuditService.logOperation).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'AI_EMERGENCY_STOP_RESUMED' }),
            { transaction: mockTransaction, required: true },
        );
        expect(sseManager.emit).toHaveBeenCalledWith(
            'shop-1',
            'emergency_stop_changed',
            expect.objectContaining({ active: false, prior_mode: 'AUTO' }),
        );
    });

    test('resume is idempotent when the stop is not active', async () => {
        const shop = makeShop({ settings: { ai: { automation_mode: 'MANUAL' } } });
        Shop.findByPk.mockResolvedValue(shop);

        const state = await shopService.resumeAiEmergencyStop('shop-1', 'user-1');

        expect(state).toEqual({
            active: false,
            automation_mode: 'MANUAL',
            prior_mode: null,
            already_inactive: true,
        });
        expect(Shop.update).not.toHaveBeenCalled();
        expect(sseManager.emit).not.toHaveBeenCalled();
    });

    test('an admin-source resume may clear an admin stop (mode stays MANUAL)', async () => {
        const shop = makeShop({
            ai_emergency_stop: true,
            ai_emergency_stop_source: 'admin',
            ai_emergency_stop_prior_mode: 'DRAFT',
            settings: { ai: { automation_mode: 'MANUAL' } },
        });
        Shop.findByPk.mockResolvedValue(shop);

        const state = await shopService.resumeAiEmergencyStop('shop-1', 'admin-1', { source: 'admin' });

        expect(state.active).toBe(false);
        expect(state.automation_mode).toBe('MANUAL');
        expect(state.prior_mode).toBe('DRAFT');
        expect(Shop.update).toHaveBeenCalled();
    });

    test('the general shop-update surface cannot write emergency-stop columns', async () => {
        const { UserShop } = require('../../entities');
        const shop = makeShop();
        UserShop.findOne.mockResolvedValue({ role: 'owner' });
        Shop.findByPk.mockResolvedValue(shop);

        await shopService.updateShopById('shop-1', 'user-1', {
            shop_name: 'Renamed',
            ai_emergency_stop: false,
            ai_emergency_stop_source: 'merchant',
            ai_emergency_stop_prior_mode: 'AUTO',
        });

        const payload = shop.update.mock.calls[0][0];
        expect(payload).not.toHaveProperty('ai_emergency_stop');
        expect(payload).not.toHaveProperty('ai_emergency_stop_source');
        expect(payload).not.toHaveProperty('ai_emergency_stop_prior_mode');
    });

    test('getShopEmergencyStopState returns the public block', async () => {
        Shop.findByPk.mockResolvedValue({
            ai_emergency_stop: true,
            ai_emergency_stop_at: '2026-11-10T10:00:00.000Z',
            ai_emergency_stop_by: 'user-1',
            ai_emergency_stop_source: 'admin',
            ai_emergency_stop_prior_mode: 'AUTO',
        });

        const block = await shopService.getShopEmergencyStopState('shop-1');

        expect(block).toEqual({
            active: true,
            at: '2026-11-10T10:00:00.000Z',
            by: 'user-1',
            source: 'admin',
            prior_mode: 'AUTO',
        });
    });
});