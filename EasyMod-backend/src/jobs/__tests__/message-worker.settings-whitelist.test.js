'use strict';

/**
 * ADR-0013 §5 / TEST_STRATEGY §2A — the worker settings merge is a WHITELIST.
 *
 * The historical `...shopSettings` spread let any merchant-writable JSON key
 * (for example a hand-crafted `settings.ai.business_hours` or
 * `settings.ai.allow_order_creation`) shadow the channel-native value. The
 * worker now delegates to the single resolver, which copies only explicit
 * DEFAULT_AI_SETTINGS keys and then applies the effective channel values.
 */

process.env.NODE_ENV = 'test';

jest.mock('bullmq', () => ({ Worker: jest.fn(), Queue: jest.fn() }));
jest.mock('src/jobs/message-queue', () => ({ connection: {} }));
jest.mock('src/config/redis', () => ({
    cacheRedis: { get: jest.fn(), set: jest.fn(), setex: jest.fn(), del: jest.fn() },
}));
jest.mock('src/utils/ops-alert', () => ({ opsAlert: jest.fn() }));
jest.mock('src/utils/sse-manager', () => ({ emit: jest.fn() }));
jest.mock('src/modules/conversation/conversation.entity', () => ({
    Conversation: {},
    Message: {},
}));
jest.mock('src/modules/conversation/conversation-state-standalone.service', () => ({}));
jest.mock('src/modules/conversation/conversation-lock.service', () => ({}));
jest.mock('src/modules/channel-providers/provider.registry', () => ({ getProvider: jest.fn() }));
jest.mock('src/modules/channel-providers/meta-channel.service', () => ({}));
jest.mock('src/modules/policy/policy.engine', () => ({ evaluateOutbound: jest.fn() }));
jest.mock('src/modules/customer/customer.entity', () => ({ findOne: jest.fn() }));
jest.mock('src/modules/ai/grounding', () => ({
    GroundingDecision: { SEND: 'SEND', SUPPRESS: 'SUPPRESS', SAFE_FALLBACK: 'SAFE_FALLBACK' },
    ReasonCode: { GROUNDED: 'GROUNDED', RETRIEVAL_FAILED: 'RETRIEVAL_FAILED' },
    emptyEvidence: jest.fn(() => ({})),
    evaluateCandidate: jest.fn(),
    logGroundingDecision: jest.fn(),
    isModelGenerated: jest.fn(() => false),
}));
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: { getDialect: () => 'sqlite' },
}));

const { _private } = require('src/jobs/message-worker');
const { DEFAULT_AI_SETTINGS } = require('src/modules/shop/shop-defaults');

describe('buildWorkerAiSettings whitelist merge', () => {
    test('whitelisted business defaults are preserved', () => {
        const settings = _private.buildWorkerAiSettings(
            {
                automation_mode: 'AUTO',
                confidence_threshold: 90,
                tone_persona: 'formal',
                closing: { enabled: false, custom_text: 'bye' },
            },
            {},
            'AUTO',
        );

        expect(settings).toEqual(expect.objectContaining({
            automation_mode: 'AUTO',
            confidence_threshold: 90,
            tone_persona: 'formal',
            closing: { enabled: false, custom_text: 'bye' },
        }));
    });

    test('merchant JSON keys outside DEFAULT_AI_SETTINGS never reach the worker settings', () => {
        const settings = _private.buildWorkerAiSettings(
            {
                automation_mode: 'AUTO',
                malicious_key: 'must not survive',
                unknown_merchant_key: true,
            },
            {},
            'AUTO',
        );

        expect(settings.malicious_key).toBeUndefined();
        expect(settings.unknown_merchant_key).toBeUndefined();
        for (const key of Object.keys(settings)) {
            if (key === 'business_hours' || key === 'allow_order_creation'
                || key === 'purpose_label' || key === 'confidence_threshold_send'
                || key === 'confidence_threshold_suggest' || key === 'shop_timezone'
                || key === 'auto_reply_enabled') continue;
            expect(Object.keys(DEFAULT_AI_SETTINGS)).toContain(key);
        }
    });

    test('a business JSON `business_hours`/`allow_order_creation` key cannot override the channel', () => {
        const settings = _private.buildWorkerAiSettings(
            {
                automation_mode: 'AUTO',
                // Malicious/legacy business-scope values.
                business_hours: { mon: { open: '00:00', close: '23:59' } },
                allow_order_creation: true,
                purpose_label: 'business label',
            },
            {
                // Channel-native authoritative values.
                business_hours: null,
                allow_order_creation: false,
                purpose_label: 'channel label',
                overrides: { automation_mode: 'MANUAL' },
            },
            'AUTO',
        );

        expect(settings.business_hours).toBeNull();
        expect(settings.allow_order_creation).toBe(false);
        expect(settings.purpose_label).toBe('channel label');
        // Narrow-only clamp: the channel MANUAL override wins over business AUTO.
        expect(settings.automation_mode).toBe('MANUAL');
    });

    test('channel threshold and greeting overrides apply; invalid overrides inherit', () => {
        const overridden = _private.buildWorkerAiSettings(
            { automation_mode: 'AUTO', confidence_threshold: 75, greeting: { enabled: true, custom_text: 'business' } },
            { overrides: { confidence_threshold: 88, greeting: { custom_text: 'channel' } } },
            'AUTO',
        );
        expect(overridden.confidence_threshold).toBe(88);
        expect(overridden.greeting).toEqual({ enabled: true, custom_text: 'channel' });

        const invalid = _private.buildWorkerAiSettings(
            { automation_mode: 'AUTO', confidence_threshold: 75 },
            { overrides: { confidence_threshold: 'not-a-number', automation_mode: 'garbage' } },
            'AUTO',
        );
        expect(invalid.confidence_threshold).toBe(75);
        expect(invalid.automation_mode).toBe('AUTO');
    });
});