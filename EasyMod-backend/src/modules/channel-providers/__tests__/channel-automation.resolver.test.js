'use strict';

const mockMetaChannel = { findByPk: jest.fn() };
const mockMetaChannelSettings = { findByPk: jest.fn(), findOrCreate: jest.fn() };
const mockEntities = {
    Shop: { findByPk: jest.fn() },
    Subscription: { findOne: jest.fn() },
};
const mockIsAiActive = jest.fn((sub) => (
    !sub || !['suspended', 'cancelled', 'inactive', 'trial_expired'].includes(String(sub.status || ''))
));

jest.mock('../meta-channel.entity', () => mockMetaChannel);
jest.mock('../meta-channel-settings.entity', () => mockMetaChannelSettings);
jest.mock('../../entities', () => mockEntities);
jest.mock('../../subscription/subscription.access', () => ({ isAiActive: mockIsAiActive }));

const { DEFAULT_AI_SETTINGS } = require('../../shop/shop-defaults');
const {
    resolveChannelAutomation,
    loadEffectiveChannelAutomation,
    buildEffectiveWorkerAiSettings,
} = require('../channel-automation.resolver');

const baseChannel = (overrides = {}) => ({
    business_hours: null,
    allow_order_creation: true,
    purpose_label: 'Sales',
    overrides: null,
    ...overrides,
});

describe('resolveChannelAutomation (pure)', () => {
    test('inherits the business default when no override exists', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO', confidence_threshold: 80 },
            channelSettings: baseChannel(),
        });

        expect(result.mode).toBe('AUTO');
        expect(result.modeSource).toBe('business_default');
        expect(result.effective.automation_mode).toBe('AUTO');
        expect(result.effective.confidence_threshold).toBe(80);
        expect(result.overrides).toEqual({});
        expect(result.warnings).toEqual([]);
    });

    test('a narrower channel override wins and is reported as channel_override', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO' },
            channelSettings: baseChannel({ overrides: { automation_mode: 'DRAFT' } }),
        });

        expect(result.mode).toBe('DRAFT');
        expect(result.modeSource).toBe('channel_override');
        expect(result.overrides).toEqual({ automation_mode: 'DRAFT' });
        expect(result.warnings).toEqual([]);
    });

    test('a widening stored override is clamped at runtime, never rewriting storage', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'MANUAL' },
            channelSettings: baseChannel({ overrides: { automation_mode: 'AUTO' } }),
        });

        expect(result.mode).toBe('MANUAL');
        expect(result.modeSource).toBe('business_default');
        expect(result.overrides).toEqual({ automation_mode: 'AUTO' });
        expect(result.warnings).toContain('override_clamped_by_business');
    });

    test('business DRAFT clamps a stored AUTO override to DRAFT', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'DRAFT' },
            channelSettings: baseChannel({ overrides: { automation_mode: 'AUTO' } }),
        });

        expect(result.mode).toBe('DRAFT');
        expect(result.warnings).toContain('override_clamped_by_business');
    });

    test('legacy aliases are accepted at input but stored canonical', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO' },
            channelSettings: baseChannel({ overrides: { automation_mode: 'AI_SUGGEST_ONLY' } }),
        });

        expect(result.mode).toBe('DRAFT');
        expect(result.overrides.automation_mode).toBe('DRAFT');
    });

    test('an unknown override mode inherits the business default with a warning', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO' },
            channelSettings: baseChannel({ overrides: { automation_mode: 'TURBO' } }),
        });

        expect(result.mode).toBe('AUTO');
        expect(result.modeSource).toBe('business_default');
        expect(result.overrides).toEqual({});
        expect(result.warnings).toContain('invalid_override_value');
    });

    test('unknown business mode normalizes to MANUAL fail-closed', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'NONSENSE' },
            channelSettings: baseChannel(),
        });

        expect(result.mode).toBe('MANUAL');
    });

    test('missing/unreadable business settings fail closed to MANUAL', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: null,
            channelSettings: baseChannel({ overrides: { automation_mode: 'AUTO' } }),
        });

        expect(result.mode).toBe('MANUAL');
        expect(result.modeSource).toBe('fail_closed');
    });

    test('a confidence override replaces the business threshold', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO', confidence_threshold: 75 },
            channelSettings: baseChannel({ overrides: { confidence_threshold: 90 } }),
        });

        expect(result.modeSource).toBe('business_default');
        expect(result.effective.confidence_threshold).toBe(90);
        expect(result.overrides.confidence_threshold).toBe(90);
    });

    test('invalid thresholds inherit the business value with a warning', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO', confidence_threshold: 75 },
            channelSettings: baseChannel({ overrides: { confidence_threshold: 150 } }),
        });

        expect(result.effective.confidence_threshold).toBe(75);
        expect(result.overrides).toEqual({});
        expect(result.warnings).toContain('invalid_override_value');
    });

    test('numeric-string thresholds are coerced into the canonical number', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO' },
            channelSettings: baseChannel({ overrides: { confidence_threshold: '80' } }),
        });

        expect(result.effective.confidence_threshold).toBe(80);
    });

    test('a partial greeting override is merged over the business greeting', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO', greeting: { enabled: true, custom_text: 'business hello' } },
            channelSettings: baseChannel({ overrides: { greeting: { enabled: false } } }),
        });

        expect(result.effective.greeting).toEqual({ enabled: false, custom_text: 'business hello' });
    });

    test('an over-long greeting override is invalid and inherits with a warning', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO', greeting: { enabled: true, custom_text: 'business hello' } },
            channelSettings: baseChannel({ overrides: { greeting: { custom_text: 'x'.repeat(501) } } }),
        });

        expect(result.effective.greeting).toEqual({ enabled: true, custom_text: 'business hello' });
        expect(result.overrides).toEqual({});
        expect(result.warnings).toContain('invalid_override_value');
    });

    test('emergency stop trumps every channel override', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO' },
            channelSettings: baseChannel({ overrides: { automation_mode: 'AUTO' } }),
            emergencyStop: { active: true },
        });

        expect(result.mode).toBe('MANUAL');
        expect(result.modeSource).toBe('emergency_stop');
    });

    test('an inactive shop resolves to MANUAL shop_inactive', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO' },
            channelSettings: baseChannel({ overrides: { automation_mode: 'AUTO' } }),
            shopIsActive: false,
        });

        expect(result.mode).toBe('MANUAL');
        expect(result.modeSource).toBe('shop_inactive');
    });

    test('channel-native values come from the channel row, not business JSON', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: {
                automation_mode: 'AUTO',
                // Malicious/legacy business keys must not shadow channel values.
                business_hours: { mon: { open: '00:00', close: '23:59' } },
                allow_order_creation: false,
                purpose_label: 'business-label',
            },
            channelSettings: baseChannel({
                business_hours: { mon: { open: '09:00', close: '18:00' } },
                allow_order_creation: true,
                purpose_label: 'channel-label',
            }),
        });

        expect(result.effective.business_hours).toEqual({ mon: { open: '09:00', close: '18:00' } });
        expect(result.effective.allow_order_creation).toBe(true);
        expect(result.effective.purpose_label).toBe('channel-label');
    });

    test('channel-native defaults: hours null, order creation allowed', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO' },
            channelSettings: {},
        });

        expect(result.effective.business_hours).toBeNull();
        expect(result.effective.allow_order_creation).toBe(true);
        expect(result.effective.purpose_label).toBeNull();
    });

    test('per-key sources are reported independently', () => {
        const result = resolveChannelAutomation({
            shopAiSettings: { automation_mode: 'AUTO', confidence_threshold: 75 },
            channelSettings: baseChannel({ overrides: { confidence_threshold: 95, greeting: { enabled: true } } }),
        });

        expect(result.modeSource).toBe('business_default');
        expect(result.overrides).toEqual({
            confidence_threshold: 95,
            greeting: { enabled: true },
        });
    });
});

describe('buildEffectiveWorkerAiSettings', () => {
    test('whitelist-picks business keys and never spreads unknown merchant JSON', () => {
        const settings = buildEffectiveWorkerAiSettings(
            {
                automation_mode: 'AUTO',
                confidence_threshold: 75,
                greeting: { enabled: true, custom_text: 'business' },
                business_hours: { mon: { open: '00:00', close: '23:59' } },
                allow_order_creation: false,
                injected_key: 'should-not-survive',
            },
            {
                business_hours: { mon: { open: '10:00', close: '16:00' } },
                allow_order_creation: true,
                purpose_label: 'Support',
                confidence_threshold_send: '0.75',
                confidence_threshold_suggest: '0.5',
                overrides: { automation_mode: 'DRAFT', confidence_threshold: 88 },
            },
            'AUTO',
        );

        expect(settings.business_hours).toEqual({ mon: { open: '10:00', close: '16:00' } });
        expect(settings.allow_order_creation).toBe(true);
        expect(settings.purpose_label).toBe('Support');
        expect(settings.confidence_threshold).toBe(88);
        expect(settings.automation_mode).toBe('DRAFT');
        expect(settings.auto_reply_enabled).toBe(false);
        expect(settings).not.toHaveProperty('injected_key');
        expect(settings.confidence_threshold_send).toBe('0.75');
    });

    test('an explicit business mode is the ceiling even without settings.automation_mode', () => {
        const settings = buildEffectiveWorkerAiSettings(
            { confidence_threshold: 60 },
            { overrides: { automation_mode: 'AUTO' } },
            'MANUAL',
        );

        expect(settings.automation_mode).toBe('MANUAL');
        expect(settings.auto_reply_enabled).toBe(false);
    });
});

describe('loadEffectiveChannelAutomation', () => {
    const shopRow = (overrides = {}) => ({
        is_active: true,
        settings: { ai: { automation_mode: 'AUTO', confidence_threshold: 80 } },
        ai_emergency_stop: false,
        ai_emergency_stop_at: null,
        ai_emergency_stop_by: null,
        ai_emergency_stop_source: null,
        ai_emergency_stop_prior_mode: null,
        ...overrides,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockIsAiActive.mockImplementation((sub) => (
            !sub || !['suspended', 'cancelled', 'inactive', 'trial_expired'].includes(String(sub.status || ''))
        ));
    });

    test('returns null when the channel does not exist', async () => {
        mockMetaChannel.findByPk.mockResolvedValue(null);

        await expect(loadEffectiveChannelAutomation('shop-1', 'channel-1')).resolves.toBeNull();
        expect(mockEntities.Shop.findByPk).not.toHaveBeenCalled();
    });

    test('returns null for a cross-shop channel (tenant assertion)', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-OTHER' });

        await expect(loadEffectiveChannelAutomation('shop-1', 'channel-1')).resolves.toBeNull();
        expect(mockEntities.Shop.findByPk).not.toHaveBeenCalled();
    });

    test('throws a retryable SHOP_SETTINGS_UNAVAILABLE when the shop row is missing', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(null);

        await expect(loadEffectiveChannelAutomation('shop-1', 'channel-1')).rejects.toMatchObject({
            code: 'SHOP_SETTINGS_UNAVAILABLE',
            retryable: true,
        });
    });

    test('merges DEFAULT_AI_SETTINGS when settings.ai is empty (MANUAL)', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow({ settings: {} }));
        mockMetaChannelSettings.findByPk.mockResolvedValue(baseChannel());
        mockEntities.Subscription.findOne.mockResolvedValue(null);

        const result = await loadEffectiveChannelAutomation('shop-1', 'channel-1');

        expect(result.mode).toBe('MANUAL');
        expect(result.modeSource).toBe('business_default');
        expect(result.effective.confidence_threshold).toBe(DEFAULT_AI_SETTINGS.confidence_threshold);
        expect(result.shopIsActive).toBe(true);
        // Missing subscription row: the worker blocks (subscription_missing), so
        // the display field fails closed (ADR-0011 C5).
        expect(result.billingAiActive).toBe(false);
    });

    test('missing subscription row reports billing_ai_active=false (fail-closed display)', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow());
        mockMetaChannelSettings.findByPk.mockResolvedValue(baseChannel());
        mockEntities.Subscription.findOne.mockResolvedValue(null);

        const result = await loadEffectiveChannelAutomation('shop-1', 'channel-1');

        expect(result.billingAiActive).toBe(false);
    });

    test('subscription read error reports billing_ai_active=false (fail-closed display)', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow());
        mockMetaChannelSettings.findByPk.mockResolvedValue(baseChannel());
        mockEntities.Subscription.findOne.mockRejectedValue(new Error('db unavailable'));

        const result = await loadEffectiveChannelAutomation('shop-1', 'channel-1');

        expect(result.billingAiActive).toBe(false);
    });

    test('missing channel settings row returns null unless createIfMissing', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow());
        mockMetaChannelSettings.findByPk.mockResolvedValue(null);

        await expect(loadEffectiveChannelAutomation('shop-1', 'channel-1')).resolves.toBeNull();
        expect(mockMetaChannelSettings.findOrCreate).not.toHaveBeenCalled();
    });

    test('createIfMissing creates defaults outside a transaction (Guard 4)', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow());
        mockMetaChannelSettings.findByPk.mockResolvedValue(null);
        mockMetaChannelSettings.findOrCreate.mockResolvedValue([baseChannel(), true]);
        mockEntities.Subscription.findOne.mockResolvedValue(null);

        const result = await loadEffectiveChannelAutomation('shop-1', 'channel-1', { createIfMissing: true });

        expect(mockMetaChannelSettings.findOrCreate).toHaveBeenCalledWith({
            where: { channel_id: 'channel-1' },
            defaults: { channel_id: 'channel-1' },
        });
        expect(result.mode).toBe('AUTO');
    });

    test('never INSERTs inside a boundary transaction, even with createIfMissing', async () => {
        const transaction = { id: 'tx-1' };
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow());
        mockMetaChannelSettings.findByPk.mockResolvedValue(null);

        const result = await loadEffectiveChannelAutomation('shop-1', 'channel-1', {
            transaction,
            createIfMissing: true,
        });

        expect(result).toBeNull();
        expect(mockMetaChannelSettings.findOrCreate).not.toHaveBeenCalled();
        // Fresh reads happen inside the supplied transaction when one is given.
        expect(mockEntities.Shop.findByPk).toHaveBeenCalledWith('shop-1', { transaction });
    });

    test('surfaces the emergency stop block and forces MANUAL', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow({
            ai_emergency_stop: true,
            ai_emergency_stop_at: '2026-11-14T00:00:00.000Z',
            ai_emergency_stop_by: 'user-1',
            ai_emergency_stop_source: 'merchant',
            ai_emergency_stop_prior_mode: 'AUTO',
        }));
        mockMetaChannelSettings.findByPk.mockResolvedValue(baseChannel({ overrides: { automation_mode: 'AUTO' } }));
        mockEntities.Subscription.findOne.mockResolvedValue(null);

        const result = await loadEffectiveChannelAutomation('shop-1', 'channel-1');

        expect(result.mode).toBe('MANUAL');
        expect(result.modeSource).toBe('emergency_stop');
        expect(result.emergencyStop).toEqual({
            active: true,
            at: '2026-11-14T00:00:00.000Z',
            by: 'user-1',
            source: 'merchant',
            prior_mode: 'AUTO',
        });
    });

    test('reports billing_ai_active=false for a suspended subscription', async () => {
        mockMetaChannel.findByPk.mockResolvedValue({ id: 'channel-1', shop_id: 'shop-1' });
        mockEntities.Shop.findByPk.mockResolvedValue(shopRow());
        mockMetaChannelSettings.findByPk.mockResolvedValue(baseChannel());
        mockEntities.Subscription.findOne.mockResolvedValue({ status: 'suspended' });

        const result = await loadEffectiveChannelAutomation('shop-1', 'channel-1');

        expect(result.billingAiActive).toBe(false);
    });
});