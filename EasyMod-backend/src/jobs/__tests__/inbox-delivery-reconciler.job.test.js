'use strict';

const mockOutboxFindAll = jest.fn();
const mockOutboxUpdate = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageUpdate = jest.fn();
const mockDeliver = jest.fn();
const mockRecordAcceptedAiReply = jest.fn();

jest.mock('../../modules/entities', () => ({
    Message: {
        findOne: mockMessageFindOne,
        update: mockMessageUpdate,
    },
    InboxDeliveryOutbox: {
        findAll: mockOutboxFindAll,
        update: mockOutboxUpdate,
    },
}));
jest.mock('../../modules/conversation/conversation.controller', () => ({
    _deliverViaMetaIfApplicable: mockDeliver,
}));
jest.mock('../../modules/subscription/ai-reply-shadow-ledger.service', () => ({
    recordAcceptedAiReply: mockRecordAcceptedAiReply,
}));
jest.mock('../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() })),
}));
jest.mock('../../utils/ops-alert', () => ({
    opsAlert: jest.fn(async () => undefined),
}));

const InboxDeliveryReconcilerJob = require('../inbox-delivery-reconciler.job');

const baseRow = {
    id: 'outbox-1',
    shop_id: 'shop-1',
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    delivery_source: 'DRAFT_APPROVAL',
    status: 'PENDING',
    processing_token: null,
    attempt_count: 0,
    next_attempt_at: new Date('2026-09-06T12:00:00Z'),
};

const pendingMessage = {
    id: 'message-1',
    conversation_id: 'conversation-1',
    sender: 'ai',
    delivery_state: 'SEND_PENDING',
    provider_message_id: null,
    metadata: {
        delivery_state: 'SEND_PENDING',
        provider_send_attempted: false,
    },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockOutboxFindAll.mockResolvedValue([baseRow]);
    mockOutboxUpdate.mockResolvedValue([1]);
    mockMessageFindOne.mockResolvedValue(pendingMessage);
    mockMessageUpdate.mockResolvedValue([1]);
    mockDeliver.mockResolvedValue({ sent: false });
    mockRecordAcceptedAiReply.mockResolvedValue({ recorded: false, reason: 'flag_off' });
});

describe('InboxDeliveryReconcilerJob', () => {
    it('does not send again after a provider call whose outcome was lost', async () => {
        mockMessageFindOne.mockResolvedValue({
            ...pendingMessage,
            metadata: {
                ...pendingMessage.metadata,
                provider_send_attempted: true,
            },
        });

        const result = await new InboxDeliveryReconcilerJob().execute();

        expect(mockDeliver).not.toHaveBeenCalled();
        expect(mockOutboxUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'NEEDS_RECONCILIATION' }),
            expect.objectContaining({ where: expect.objectContaining({ id: 'outbox-1' }) }),
        );
        expect(result.reconciliations).toBe(1);
    });

    it('settles a recovered provider-confirmed delivery without creating another send', async () => {
        mockDeliver.mockResolvedValue({ sent: true, providerMessageId: 'mid-recovered' });
        mockMessageFindOne
            .mockResolvedValueOnce(pendingMessage)
            .mockResolvedValueOnce({
                ...pendingMessage,
                delivery_state: 'SENT',
                provider_message_id: 'mid-recovered',
                metadata: {
                    ...pendingMessage.metadata,
                    provider_message_id: 'mid-recovered',
                    provider_send_attempted: true,
                    provider_send_confirmed: true,
                },
            });

        const result = await new InboxDeliveryReconcilerJob().execute();

        expect(mockDeliver).toHaveBeenCalledTimes(1);
        expect(mockOutboxUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 'COMPLETED' }),
            expect.anything(),
        );
        expect(result.completed).toBe(1);
        expect(mockRecordAcceptedAiReply).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-1' }));
    });

    it('persists a provider acknowledgement saved on the outbox without sending again', async () => {
        mockOutboxFindAll.mockResolvedValue([{ ...baseRow, status: 'NEEDS_RECONCILIATION', provider_message_id: 'mid-outbox' }]);

        const result = await new InboxDeliveryReconcilerJob().execute();

        expect(mockDeliver).not.toHaveBeenCalled();
        expect(mockMessageUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                provider_message_id: 'mid-outbox',
                delivery_state: 'SENT',
            }),
            expect.anything(),
        );
        expect(result.reconciliations).toBe(1);
        expect(mockRecordAcceptedAiReply).toHaveBeenCalledWith(expect.objectContaining({
            shopId: 'shop-1',
            message: expect.objectContaining({ delivery_source: 'DRAFT_APPROVAL' }),
        }));
    });

    it('keeps a provider-confirmed draft pending when the shadow gate is temporarily unavailable', async () => {
        mockMessageFindOne.mockResolvedValue({
            ...pendingMessage,
            delivery_state: 'SENT',
            provider_message_id: 'mid-confirmed',
            metadata: {
                delivered: true,
                provider_send_confirmed: true,
                provider_message_id: 'mid-confirmed',
                provider_accepted_at: '2026-11-01T00:00:00.000Z',
            },
        });
        mockRecordAcceptedAiReply.mockResolvedValue({ recorded: false, reason: 'gate_unavailable' });

        const result = await new InboxDeliveryReconcilerJob().execute();

        expect(mockDeliver).not.toHaveBeenCalled();
        expect(mockOutboxUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'PENDING',
            last_error_code: 'AI_REPLY_SHADOW_GATE_UNAVAILABLE',
            next_attempt_at: expect.any(Date),
        }), expect.anything());
        expect(result.retried).toBe(1);
    });

    it('does not process a row lost by the outbox claim CAS', async () => {
        mockOutboxUpdate.mockResolvedValue([0]);

        const result = await new InboxDeliveryReconcilerJob().execute();

        expect(mockDeliver).not.toHaveBeenCalled();
        expect(result.claimed).toBe(0);
    });

    it('backs off an unconfirmed delivery that has not crossed the provider boundary', async () => {
        const result = await new InboxDeliveryReconcilerJob().execute();

        expect(mockDeliver).toHaveBeenCalledTimes(1);
        expect(mockOutboxUpdate).toHaveBeenLastCalledWith(
            expect.objectContaining({
                status: 'PENDING',
                attempt_count: 1,
                next_attempt_at: expect.any(Date),
            }),
            expect.anything(),
        );
        expect(result.retried).toBe(1);
    });
});
