'use strict';

const mockBus = {
    publish: jest.fn(async () => 1),
    subscribe: jest.fn(async () => {}),
    unsubscribe: jest.fn(async () => {}),
    getReplay: jest.fn(),
};
jest.mock('../sse-bus', () => ({ getBus: () => mockBus }));
const sse = require('../sse-manager');

test('projects published, live, and replayed evidence without mutating the row', async () => {
    const shopId = 'synthetic-shop';
    const metadata = {
        confidence_mode: 'shadow', confidence_scope: 'delivered', confidence_score: 0.91,
        confidence_components: { provider: 'internal' }, confidence_would_hold: false,
        confidence_reason_codes: ['GROUNDED', 'unexpected'], confidence_provenance: 'model',
        grounding_knowledge_ids: ['fixture-doc'], delivered: true,
    };
    const message = { id: 'fixture-message', metadata };
    const projected = { delivered: true, reply_evidence: { reasons: ['GROUNDED'], provenance: 'model' } };
    const res = { write: jest.fn() };
    const frame = (index) => JSON.parse(res.write.mock.calls[index][0].split('\n')[2].slice(6));
    mockBus.getReplay.mockResolvedValue([{ id: 2, event: 'new_message', data: { message } }]);
    try {
        await sse.attachToRequest({ headers: { 'last-event-id': '1' } }, res, shopId);
        expect(frame(0).message.metadata).toEqual(projected);

        const [, deliver] = mockBus.subscribe.mock.calls[0];
        deliver({ id: 3, event: 'message_delivery_updated', data: { metadata, delivery_source: 'DRAFT_APPROVAL' } });
        expect(frame(1).metadata).toEqual({ delivered: true, reply_evidence: null });

        sse.emit(shopId, 'new_message', { message: { toJSON: () => message } });
        expect(mockBus.publish).toHaveBeenCalledWith(shopId, 'new_message', { message: { id: message.id, metadata: projected } });
        expect(metadata.confidence_score).toBe(0.91);
    } finally {
        sse.unregister(shopId, res);
    }
});
