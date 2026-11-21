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

// P0 sendProductCard contract — FLAGGED-FOR-PRIVACY-REVIEWER: product_card and
// quick_replies are allowlisted merchant data and must survive SSE projection
// for the owning shop, while private metadata stays stripped.
test('preserves allowlisted product-card metadata through publish and frame projection', async () => {
    const res = response();
    sseManager.register('shop-fixture', res, 'user-fixture');
    const productCard = {
        product_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        title: 'Fixture Product',
        subtitle: '৳1200 · Available',
        image_url: 'https://assets.example.test/product.jpg',
    };
    const quickReplies = [{
        content_type: 'text',
        title: 'Order now',
        payload: 'product:3f2504e0-4f89-41d3-9a0c-0305e82c3301:q:0',
    }];
    sseManager.emit('shop-fixture', 'new_message', {
        conversation_id: 'conversation-fixture',
        message: {
            id: 'message-fixture',
            shop_id: 'private-shop-fixture',
            metadata: {
                ...privateMetadata,
                product_card: { ...productCard, internal_note: { fixture: 'private' } },
                quick_replies: quickReplies.map((reply) => ({ ...reply, customer_phone: '+8801000000000' })),
            },
        },
    });

    const published = mockBus.publish.mock.calls[0][2];
    expect(published.message.metadata).toEqual({
        ...publicMetadata,
        product_card: productCard,
        quick_replies: quickReplies,
    });
    expect(published.message).not.toHaveProperty('shop_id');
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
