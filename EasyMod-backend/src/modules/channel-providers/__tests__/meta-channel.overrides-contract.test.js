'use strict';

/**
 * Channel automation overrides — API_CONTRACT §2 / ADR-0013 §9.
 *
 * Service-level merge semantics (row-locked read-modify-write, sibling
 * survival, canonical storage, narrow-only widening rejection, tenant scope)
 * plus the additive GET effective-config shape.
 */

const mockTransaction = { LOCK: { UPDATE: 'UPDATE' } };

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockDrainChannelJobs = jest.fn();

const mockMetaChannel = { findByPk: jest.fn() };
const mockMetaChannelSettings = { findOrCreate: jest.fn(), findByPk: jest.fn() };
const mockShopService = { getShopAiSettings: jest.fn() };
const mockAuditService = { logOperation: jest.fn().mockResolvedValue(undefined) };
const mockInvalidateCaches = jest.fn().mockResolvedValue(undefined);
const mockSseEmit = jest.fn();
const mockLoadEffective = jest.fn();

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: {
        transaction: jest.fn(async (callback) => callback(mockTransaction)),
        getDialect: jest.fn(() => 'postgres'),
        query: jest.fn().mockResolvedValue([]),
    },
}));

jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => mockLogger),
}));

jest.mock('../../../utils/shop-settings-cache', () => ({
    invalidateShopSettingsCaches: mockInvalidateCaches,
}));

jest.mock('../../../utils/sse-manager', () => ({ emit: mockSseEmit }));

jest.mock('../../../jobs/message-queue', () => ({ drainChannelJobs: mockDrainChannelJobs }));

jest.mock('../meta-channel.entity', () => mockMetaChannel);
jest.mock('../meta-channel-settings.entity', () => mockMetaChannelSettings);
jest.mock('../meta-channel-consent-event.entity', () => ({}));
jest.mock('../meta-oauth.service', () => ({}));
jest.mock('../provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('../../entities', () => ({
    Shop: { findByPk: jest.fn() },
    Subscription: { findOne: jest.fn() },
}));
jest.mock('../../shop/shop.service', () => mockShopService);
jest.mock('../../audit/audit.service', () => mockAuditService);

jest.mock('../channel-automation.resolver', () => ({
    ...jest.requireActual('../channel-automation.resolver'),
    loadEffectiveChannelAutomation: (...args) => mockLoadEffective(...args),
}));

const metaChannelService = require('../meta-channel.service');
const metaChannelController = require('../meta-channel.controller');

const CHANNEL = { id: 'channel-1', shop_id: 'shop-1' };

function makeRow({ overrides = null } = {}) {
    const row = {
        channel_id: 'channel-1',
        overrides,
        update: jest.fn(async (payload) => {
            Object.assign(row, payload);
            return row;
        }),
    };
    return row;
}

async function flushAsync() {
    await new Promise((resolve) => setImmediate(resolve));
}

describe('MetaChannelService overrides contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockMetaChannel.findByPk.mockResolvedValue(CHANNEL);
        mockShopService.getShopAiSettings.mockResolvedValue({ automation_mode: 'AUTO' });
        mockLoadEffective.mockResolvedValue({
            mode: 'DRAFT',
            modeSource: 'channel_override',
            overrides: { automation_mode: 'DRAFT' },
        });
    });

    function primeRow(row) {
        mockMetaChannelSettings.findOrCreate.mockResolvedValue([row, false]);
        mockMetaChannelSettings.findByPk.mockResolvedValue(row);
    }

    test('stores canonical values and never persists aliases or strings', async () => {
        const row = makeRow();
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', {
            overrides: {
                automation_mode: 'AI_SUGGEST_ONLY',
                confidence_threshold: '80',
                greeting: { enabled: false },
            },
        }, { shopId: 'shop-1', userId: 'user-1' });

        expect(row.update).toHaveBeenCalledWith({
            overrides: {
                automation_mode: 'DRAFT',
                confidence_threshold: 80,
                greeting: { enabled: false },
            },
        }, { transaction: mockTransaction });
    });

    test('reads the current overrides under the row lock before merging', async () => {
        const row = makeRow();
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', {
            overrides: { confidence_threshold: 90 },
        }, { shopId: 'shop-1' });

        expect(mockMetaChannelSettings.findByPk).toHaveBeenCalledWith(
            'channel-1',
            expect.objectContaining({ transaction: mockTransaction, lock: 'UPDATE' }),
        );
    });

    test('a null key reverts to inherit while siblings survive', async () => {
        const row = makeRow({ overrides: { automation_mode: 'DRAFT', confidence_threshold: 90 } });
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', {
            overrides: { confidence_threshold: null },
        }, { shopId: 'shop-1' });

        expect(row.update).toHaveBeenCalledWith({
            overrides: { automation_mode: 'DRAFT' },
        }, { transaction: mockTransaction });
    });

    test('overrides:null means "no override changes"', async () => {
        const row = makeRow({ overrides: { automation_mode: 'DRAFT' } });
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', { overrides: null }, { shopId: 'shop-1' });
        await flushAsync();

        expect(row.update).not.toHaveBeenCalled();
        expect(mockAuditService.logOperation).not.toHaveBeenCalled();
    });

    test('reverting the last override stores NULL (inherit)', async () => {
        const row = makeRow({ overrides: { confidence_threshold: 90 } });
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', {
            overrides: { confidence_threshold: null },
        }, { shopId: 'shop-1' });

        expect(row.update).toHaveBeenCalledWith({ overrides: null }, { transaction: mockTransaction });
    });

    test('sequential PATCHes to different keys both survive (no wholesale replace)', async () => {
        const row = makeRow();
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', {
            overrides: { confidence_threshold: 90 },
        }, { shopId: 'shop-1' });
        await metaChannelService.updateSettings('channel-1', {
            overrides: { greeting: { enabled: true } },
        }, { shopId: 'shop-1' });

        expect(row.overrides).toEqual({
            confidence_threshold: 90,
            greeting: { enabled: true },
        });
    });

    test('rejects a widening automation-mode override with INVALID_OVERRIDE_WIDENING', async () => {
        const row = makeRow();
        primeRow(row);
        mockShopService.getShopAiSettings.mockResolvedValue({ automation_mode: 'MANUAL' });

        await expect(metaChannelService.updateSettings('channel-1', {
            overrides: { automation_mode: 'AUTO' },
        }, { shopId: 'shop-1' })).rejects.toMatchObject({
            status: 400,
            code: 'INVALID_OVERRIDE_WIDENING',
        });

        expect(row.update).not.toHaveBeenCalled();
        expect(mockAuditService.logOperation).not.toHaveBeenCalled();
        expect(mockSseEmit).not.toHaveBeenCalled();
    });

    test('accepts a same-or-narrower mode against a DRAFT ceiling', async () => {
        const row = makeRow();
        primeRow(row);
        mockShopService.getShopAiSettings.mockResolvedValue({ automation_mode: 'DRAFT' });

        await metaChannelService.updateSettings('channel-1', {
            overrides: { automation_mode: 'MANUAL' },
        }, { shopId: 'shop-1' });

        expect(row.update).toHaveBeenCalledWith({
            overrides: { automation_mode: 'MANUAL' },
        }, { transaction: mockTransaction });
    });

    test('rejects unknown override keys with OVERRIDE_KEY_FORBIDDEN', async () => {
        primeRow(makeRow());

        await expect(metaChannelService.updateSettings('channel-1', {
            overrides: { model_preset: 'advanced' },
        }, { shopId: 'shop-1' })).rejects.toMatchObject({
            status: 400,
            code: 'OVERRIDE_KEY_FORBIDDEN',
        });
    });

    test('rejects an invalid override value with INVALID_OVERRIDE_VALUE', async () => {
        primeRow(makeRow());

        await expect(metaChannelService.updateSettings('channel-1', {
            overrides: { confidence_threshold: 150 },
        }, { shopId: 'shop-1' })).rejects.toMatchObject({
            status: 400,
            code: 'INVALID_OVERRIDE_VALUE',
        });
    });

    test('audits the override change in the transaction and invalidates cache + emits SSE', async () => {
        const row = makeRow({ overrides: { confidence_threshold: 75 } });
        primeRow(row);
        mockLoadEffective.mockResolvedValue({
            mode: 'DRAFT',
            modeSource: 'channel_override',
            overrides: { confidence_threshold: 75, automation_mode: 'DRAFT' },
        });

        await metaChannelService.updateSettings('channel-1', {
            overrides: { automation_mode: 'DRAFT' },
        }, { shopId: 'shop-1', userId: 'user-1' });
        await flushAsync();

        expect(mockAuditService.logOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'CHANNEL_AUTOMATION_OVERRIDE_CHANGED',
                userId: 'user-1',
                shopId: 'shop-1',
                resourceId: 'channel-1',
                oldValues: { overrides: { confidence_threshold: 75 } },
                newValues: { overrides: { confidence_threshold: 75, automation_mode: 'DRAFT' } },
            }),
            { transaction: mockTransaction, required: true },
        );
        expect(mockInvalidateCaches).toHaveBeenCalledWith('shop-1');
        expect(mockSseEmit).toHaveBeenCalledWith('shop-1', 'channel_settings_changed', {
            channel_id: 'channel-1',
            effective_mode: 'DRAFT',
            mode_source: 'channel_override',
            override_keys: ['confidence_threshold', 'automation_mode'],
        });
    });

    test('does not audit or emit when no override value actually changed', async () => {
        const row = makeRow({ overrides: { automation_mode: 'DRAFT' } });
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', {
            overrides: { automation_mode: 'DRAFT' },
        }, { shopId: 'shop-1' });
        await flushAsync();

        expect(row.update).not.toHaveBeenCalled();
        expect(mockAuditService.logOperation).not.toHaveBeenCalled();
        expect(mockSseEmit).not.toHaveBeenCalled();
    });

    test('legacy channel-native keys still write alongside overrides', async () => {
        const row = makeRow();
        primeRow(row);

        await metaChannelService.updateSettings('channel-1', {
            business_hours: { mon: { open: '09:00', close: '18:00' } },
            purpose_label: 'Sales',
            overrides: { confidence_threshold: 88 },
        }, { shopId: 'shop-1' });

        expect(row.update).toHaveBeenCalledWith({
            business_hours: { mon: { open: '09:00', close: '18:00' } },
            purpose_label: 'Sales',
            overrides: { confidence_threshold: 88 },
        }, { transaction: mockTransaction });
    });

    test('rejects a cross-shop channel at the service layer (404)', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-OTHER' });

        await expect(metaChannelService.updateSettings('channel-1', {
            overrides: { confidence_threshold: 90 },
        }, { shopId: 'shop-1' })).rejects.toMatchObject({ status: 404 });

        expect(mockMetaChannelSettings.findOrCreate).not.toHaveBeenCalled();
    });

    test('requires a shop scope for writes', async () => {
        await expect(metaChannelService.updateSettings('channel-1', {
            overrides: { confidence_threshold: 90 },
        })).rejects.toMatchObject({ status: 400 });
    });

    test('GET settings applies the same tenant predicate when shopId is supplied', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-OTHER' });

        await expect(metaChannelService.getSettings('channel-1', { shopId: 'shop-1' }))
            .rejects.toMatchObject({ status: 404 });
        expect(mockMetaChannelSettings.findOrCreate).not.toHaveBeenCalled();
    });
});

describe('GET channel settings additive effective fields', () => {
    test('returns overrides/effective/mode_source/warnings/emergency/billing/deprecated markers', async () => {
        const settingsRow = {
            confidence_threshold_send: '0.80',
            confidence_threshold_suggest: '0.50',
            business_hours: { mon: { open: '09:00', close: '18:00' } },
            allow_order_creation: true,
            purpose_label: 'Sales',
        };
        const resolvedState = {
            mode: 'DRAFT',
            modeSource: 'channel_override',
            effective: {
                automation_mode: 'DRAFT',
                confidence_threshold: 88,
                greeting: { enabled: true, custom_text: 'Hello' },
                business_hours: { mon: { open: '09:00', close: '18:00' } },
                allow_order_creation: true,
                purpose_label: 'Sales',
            },
            overrides: { automation_mode: 'DRAFT', confidence_threshold: 88 },
            warnings: ['override_clamped_by_business'],
            emergencyStop: { active: false, at: null, by: null, source: null, prior_mode: null },
            billingAiActive: false,
        };

        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockMetaChannelSettings.findOrCreate.mockResolvedValue([settingsRow, false]);
        mockMetaChannelSettings.findByPk.mockResolvedValue(settingsRow);
        mockLoadEffective.mockResolvedValue(resolvedState);

        const res = { json: jest.fn() };
        const next = jest.fn();

        await metaChannelController.getSettings({
            params: { channelId: 'channel-1' },
            user: { shopId: 'shop-1' },
        }, res, next);

        expect(next).not.toHaveBeenCalled();
        const payload = res.json.mock.calls[0][0];
        expect(payload.success).toBe(true);
        expect(payload.data).toMatchObject({
            // Existing camelCase fields stay unchanged.
            confidenceThresholdSend: 0.8,
            confidenceThresholdSuggest: 0.5,
            allowOrderCreation: true,
            purposeLabel: 'Sales',
            // Additive fields.
            overrides: { automation_mode: 'DRAFT', confidence_threshold: 88 },
            mode_source: 'channel_override',
            warnings: ['override_clamped_by_business'],
            emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
            billing_ai_active: false,
            deprecated_fields: ['confidenceThresholdSend', 'confidenceThresholdSuggest'],
        });
        expect(payload.data.effective.automation_mode).toBe('DRAFT');
        expect(payload.data.effective.confidence_threshold).toBe(88);
    });
});