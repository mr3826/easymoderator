'use strict';

const { withoutInternalMessageMetadata, withoutInternalMessageEvent } = require('../internal-message-metadata');

const metadata = { delivered: true, attachment_available: true, confidence_score: 1,
    confidence_components: { diagnostic: 'fixture' }, grounding_knowledge_ids: ['fixture'], reply_evidence: { reasons: ['GROUNDED'] } };
const expected = { delivered: true, attachment_available: true };

test('legacy API can read a Stage 2 row without exposing its diagnostic fields', () => {
    expect(withoutInternalMessageMetadata(metadata)).toEqual(expected);
    expect(metadata.confidence_score).toBe(1);
});

test('legacy API can project Stage 2 live and replay message events', () => {
    const message = { id: 'fixture', metadata };
    const event = { conversation_id: 'fixture', message: { toJSON: () => message } };
    expect(withoutInternalMessageEvent('new_message', event)).toEqual({
        conversation_id: 'fixture', message: { id: 'fixture', metadata: expected },
    });
    expect(withoutInternalMessageEvent('message_delivery_updated', { metadata })).toEqual({ metadata: expected });
});
