'use strict';

let mockBus;
let sseManager;

function response() {
    return { write: jest.fn() };
}

function frameData(res) {
    const frame = res.write.mock.calls[0][0];
    const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
    return JSON.parse(line.slice('data: '.length));
}

const privateMetadata = {
    delivery_state: 'SENT',
    delivered: true,
    provider_message_id: 'provider-fixture',
    confidence_score: 0.93,
    confidence_components: { fixture: 'private' },
    grounding_knowledge_ids: ['knowledge-fixture'],
    reply_evidence: { label: 'GROUNDED', fixture: 'private' },
    nested_extension: { fixture: 'private' },
};

const publicMetadata = {
    delivery_state: 'SENT',
    delivered: true,
    provider_message_id: 'provider-fixture',
};

beforeEach(() => {
    jest.resetModules();
    const handlers = new Map();
    mockBus = {
        subscribe: jest.fn(async (shopId, handler) => handlers.set(shopId, handler)),
        unsubscribe: jest.fn(async () => {}),
        publish: jest.fn(async (shopId, event, data) => {
            handlers.get(shopId)?.({ id: 7, event, data });
        }),
        getReplay: jest.fn(),
    };
    jest.doMock('../sse-bus', () => ({ getBus: () => mockBus }));
    jest.doMock('../structured-logger', () => ({
        createLogger: () => ({ debug: jest.fn(), warn: jest.fn() }),
    }));
    sseManager = require('../sse-manager');
});

test('projects the live message before publishing and writing the SSE frame', async () => {
    const res = response();
    sseManager.register('shop-fixture', res, 'user-fixture');
    sseManager.emit('shop-fixture', 'new_message', {
        conversation_id: 'conversation-fixture',
        message: {
            id: 'message-fixture',
            metadata: privateMetadata,
            source_references: [{ kind: 'faq', id: 'faq-fixture', title: 'Shipping', private_note: 'fixture' }],
        },
    });

    const published = mockBus.publish.mock.calls[0][2];
    expect(published.message.metadata).toEqual(publicMetadata);
    expect(published.message.source_references).toEqual([{ kind: 'faq', id: 'faq-fixture', title: 'Shipping' }]);
    expect(frameData(res)).toEqual(published);

    sseManager.unregister('shop-fixture', res);
});

test('projects replayed message-delivery metadata before writing the SSE frame', async () => {
    const res = response();
    mockBus.getReplay.mockResolvedValue([{
        id: 8,
        event: 'message_delivery_updated',
        data: { message_id: 'message-fixture', metadata: privateMetadata },
    }]);

    await sseManager.attachToRequest({ headers: { 'last-event-id': '7' } }, res, 'shop-fixture', 'user-fixture');

    expect(frameData(res)).toEqual({ message_id: 'message-fixture', metadata: publicMetadata });
    sseManager.unregister('shop-fixture', res);
});
