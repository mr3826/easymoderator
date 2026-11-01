'use strict';

const mockLedger = {
    findOrCreate: jest.fn(),
    sum: jest.fn(),
};
const mockSubscriptionFindOne = jest.fn();
const mockGetPilotFeatures = jest.fn();
const mockAssertAddonEnabled = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../ai-reply-shadow-ledger.entity', () => ({ AiReplyShadowLedger: mockLedger }));
jest.mock('../subscription.entity', () => ({ findOne: mockSubscriptionFindOne }));
jest.mock('../../pilot-features/pilot-features.service', () => ({
    getPilotFeatures: mockGetPilotFeatures,
    getPilotFeaturesStrict: mockGetPilotFeatures,
}));
jest.mock('../../shop-addons/shop-addons.service', () => ({
    assertAddonEnabled: mockAssertAddonEnabled,
}), { virtual: true });
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: () => ({ warn: mockLoggerWarn }),
}));

const service = require('../ai-reply-shadow-ledger.service');

const acceptedMessage = (overrides = {}) => ({
    id: 'outbound-message-1',
    sender: 'ai',
    delivery_state: 'SENT',
    delivery_source: 'AUTO',
    provider_message_id: 'meta-mid-1',
    content: 'private reply text',
    customer_id: 'customer-private-id',
    metadata: {
        delivered: true,
        provider_send_confirmed: true,
        provider_message_id: 'meta-mid-1',
        logical_turn_id: 'logical-turn-1',
        provider_accepted_at: '2026-11-01T00:00:00.000Z',
    },
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockGetPilotFeatures.mockResolvedValue({
        aiReplyShadowMeter: true,
        aiReplyShadowMeterEnabledAt: '2026-10-01T00:00:00.000Z',
    });
    mockAssertAddonEnabled.mockResolvedValue(true);
    mockLedger.findOrCreate.mockResolvedValue([{ id: 'ledger-row-1' }, true]);
    mockLedger.sum.mockResolvedValue(7);
    mockSubscriptionFindOne.mockResolvedValue({
        plan_code: 'SHURU',
        conversations_used: 12,
        conversations_limit: 100,
    });
});

describe('recordAcceptedAiReply', () => {
    it('stores one PII-free unit for an accepted and durably recorded AI reply', async () => {
        const result = await service.recordAcceptedAiReply({
            shopId: 'shop-1',
            message: acceptedMessage(),
        });

        expect(result).toEqual({ recorded: true, reason: null });
        expect(mockGetPilotFeatures).toHaveBeenCalledWith('shop-1');
        expect(mockAssertAddonEnabled).toHaveBeenCalledWith('shop-1', 'AI_REPLY_METER');
        const createOptions = mockLedger.findOrCreate.mock.calls[0][0];
        expect(createOptions.defaults).toEqual(expect.objectContaining({
            shop_id: 'shop-1',
            period_start: '2026-11-01',
            period_end: '2026-12-01',
            accepted_at: new Date('2026-11-01T00:00:00.000Z'),
            plan_code: 'SHURU',
            reply_source: 'AUTO',
            units: 1,
        }));
        expect(createOptions.defaults.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(createOptions.defaults)).not.toContain('private reply text');
        expect(JSON.stringify(createOptions.defaults)).not.toContain('customer-private-id');
        expect(JSON.stringify(createOptions.defaults)).not.toContain('outbound-message-1');
    });

    it('uses logical-turn identity across retries and lets the unique row fence concurrent duplicates', async () => {
        const rows = new Set();
        mockLedger.findOrCreate.mockImplementation(async ({ where, defaults }) => {
            const key = `${where.shop_id}:${where.idempotency_key}`;
            if (rows.has(key)) return [{ id: 'existing' }, false];
            rows.add(key);
            return [{ id: 'created', ...defaults }, true];
        });

        const firstAttempt = acceptedMessage();
        const retry = acceptedMessage({ id: 'transport-retry-message-2' });
        const results = await Promise.all([
            service.recordAcceptedAiReply({ shopId: 'shop-1', message: firstAttempt }),
            service.recordAcceptedAiReply({ shopId: 'shop-1', message: retry }),
        ]);

        expect(results.map(({ recorded }) => recorded).sort()).toEqual([false, true]);
        expect(mockLedger.findOrCreate).toHaveBeenCalledTimes(2);
        expect(mockLedger.findOrCreate.mock.calls[0][0].where.idempotency_key)
            .toBe(mockLedger.findOrCreate.mock.calls[1][0].where.idempotency_key);
        expect(mockLedger.findOrCreate.mock.calls[0][0].where.idempotency_key)
            .not.toContain('logical-turn-1');
    });

    it('falls back to the durable outbound message id when no logical turn id exists', async () => {
        const message = acceptedMessage({
            metadata: {
                delivered: true,
                provider_send_confirmed: true,
                provider_accepted_at: '2026-11-01T00:00:00.000Z',
            },
        });

        await service.recordAcceptedAiReply({ shopId: 'shop-1', message });

        expect(mockLedger.findOrCreate.mock.calls[0][0].where.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('counts a provider-accepted AI draft only after explicit merchant approval', async () => {
        const draft = acceptedMessage({
            delivery_source: 'DRAFT_APPROVAL',
            metadata: {
                delivered: true,
                provider_send_confirmed: true,
                provider_message_id: 'meta-mid-1',
                logical_turn_id: 'approved-draft-turn',
                provider_accepted_at: '2026-11-01T00:00:00.000Z',
            },
        });

        await expect(service.recordAcceptedAiReply({ shopId: 'shop-1', message: draft }))
            .resolves.toEqual({ recorded: true, reason: null });
        expect(mockLedger.findOrCreate.mock.calls[0][0].defaults.reply_source).toBe('DRAFT_APPROVAL');
    });

    it.each([
        ['inbound customer message', acceptedMessage({ sender: 'customer' })],
        ['human business message', acceptedMessage({ sender: 'business', delivery_source: 'MANUAL' })],
        ['HITL escalation', acceptedMessage({ delivery_source: 'HITL_ESCALATION' })],
        ['unsent draft', acceptedMessage({
            delivery_state: 'DRAFT_READY',
            provider_message_id: null,
            metadata: { delivered: false, provider_send_confirmed: false },
        })],
        ['failed delivery', acceptedMessage({
            delivery_state: 'FAILED',
            provider_message_id: null,
            metadata: { delivered: false, provider_send_confirmed: false },
        })],
        ['legacy send without an acceptance timestamp', acceptedMessage({
            metadata: { delivered: true, provider_send_confirmed: true, logical_turn_id: 'old-turn' },
        })],
    ])('excludes %s', async (_label, message) => {
        await expect(service.recordAcceptedAiReply({ shopId: 'shop-1', message }))
            .resolves.toEqual({ recorded: false, reason: 'not_eligible' });
        expect(mockGetPilotFeatures).not.toHaveBeenCalled();
        expect(mockLedger.findOrCreate).not.toHaveBeenCalled();
    });

    it('skips recording when the platform flag is off', async () => {
        mockGetPilotFeatures.mockResolvedValue({ aiReplyShadowMeter: false });

        await expect(service.recordAcceptedAiReply({ shopId: 'shop-1', message: acceptedMessage() }))
            .resolves.toEqual({ recorded: false, reason: 'flag_off' });
        expect(mockAssertAddonEnabled).not.toHaveBeenCalled();
        expect(mockLedger.findOrCreate).not.toHaveBeenCalled();
    });

    it('does not backfill replies accepted before a shop opted into shadow measurement', async () => {
        await expect(service.recordAcceptedAiReply({
            shopId: 'shop-1',
            message: acceptedMessage({
                metadata: {
                    delivered: true,
                    provider_send_confirmed: true,
                    provider_accepted_at: '2026-09-30T23:59:59.999Z',
                    logical_turn_id: 'before-enabled-turn',
                },
            }),
        })).resolves.toEqual({ recorded: false, reason: 'before_meter_enabled' });
        expect(mockLedger.findOrCreate).not.toHaveBeenCalled();
    });

    it('fails open for gate-read failures and skips metering without logging raw error text', async () => {
        mockAssertAddonEnabled.mockRejectedValue(new Error('private customer/reply details'));

        await expect(service.recordAcceptedAiReply({ shopId: 'shop-1', message: acceptedMessage() }))
            .resolves.toEqual({ recorded: false, reason: 'gate_unavailable' });
        expect(mockLedger.findOrCreate).not.toHaveBeenCalled();
        expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('private customer/reply details');
    });

    it('fails open when the platform feature lookup itself rejects', async () => {
        mockGetPilotFeatures.mockRejectedValue(new Error('private feature lookup detail'));

        await expect(service.recordAcceptedAiReply({ shopId: 'shop-1', message: acceptedMessage() }))
            .resolves.toEqual({ recorded: false, reason: 'gate_unavailable' });
        expect(mockAssertAddonEnabled).not.toHaveBeenCalled();
        expect(mockLedger.findOrCreate).not.toHaveBeenCalled();
        expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('private feature lookup detail');
    });
});

describe('shadow usage projection', () => {
    it.each([
        ['SHURU', 300],
        ['GROWTH', 3000],
        ['PARTNER', null],
        ['UNKNOWN', null],
    ])('uses the internal %s target', async (planCode, target) => {
        mockSubscriptionFindOne.mockResolvedValue({
            plan_code: planCode,
            conversations_used: 12,
            conversations_limit: 100,
        });

        const usage = await service.getShadowUsage('shop-1', new Date('2026-11-30T23:59:59.999Z'));

        expect(usage).toEqual(expect.objectContaining({
            candidate_units: 1,
            target,
            current_shadow_use: 7,
            period: {
                start: '2026-11-01T00:00:00.000Z',
                end: '2026-12-01T00:00:00.000Z',
            },
            billing_mode: 'shadow',
            billable: false,
            enforce: false,
            unit: 'provider_accepted_ai_reply',
            conversation_usage: { used: 12, limit: 100 },
        }));
        expect(mockLedger.sum).toHaveBeenCalledWith('units', {
            where: { shop_id: 'shop-1', period_start: '2026-11-01' },
        });
    });

    it('assigns exact UTC month boundaries without using the billing period', () => {
        expect(service._private.utcCalendarMonthPeriod('2026-10-31T23:59:59.999Z')).toEqual({
            start: '2026-10-01T00:00:00.000Z',
            end: '2026-11-01T00:00:00.000Z',
            startDate: '2026-10-01',
        });
        expect(service._private.utcCalendarMonthPeriod('2026-11-01T00:00:00.000Z')).toEqual({
            start: '2026-11-01T00:00:00.000Z',
            end: '2026-12-01T00:00:00.000Z',
            startDate: '2026-11-01',
        });
    });

    it('omits conversation usage when the subscription read is unavailable', async () => {
        mockSubscriptionFindOne.mockRejectedValue(new Error('subscription unavailable'));

        const usage = await service.getShadowUsage('shop-1', new Date('2026-11-04T00:00:00.000Z'));

        expect(usage).not.toHaveProperty('conversation_usage');
        expect(usage.target).toBeNull();
        expect(usage.plan_code).toBeNull();
    });

    it('reports when the shop-level shadow measurement gate is off', async () => {
        mockGetPilotFeatures.mockResolvedValue({ aiReplyShadowMeter: false });

        const usage = await service.getShadowUsage('shop-1', new Date('2026-11-04T00:00:00.000Z'));

        expect(usage.recording_enabled).toBe(false);
        expect(usage.recording_status).toBe('flag_off');
        expect(usage.billing_mode).toBe('shadow');
        expect(usage.enforce).toBe(false);
    });
});
