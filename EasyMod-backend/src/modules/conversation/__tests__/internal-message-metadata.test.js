'use strict';

const {
    projectPublicMessageMetadata,
    projectPublicSourceReferences,
    projectPublicMessageEvent,
} = require('../internal-message-metadata');

const metadata = {
    message_type: 'file',
    attachments: [{
        type: 'file',
        url: 'https://assets.example.test/catalog.pdf',
        name: 'catalog.pdf',
        mime_type: 'application/pdf',
        internal_note: { fixture: true },
    }],
    file_name: 'catalog.pdf',
    attachment_source: 'inbox_upload',
    attachment_storage_key: 'shop-fixture/catalog.pdf',
    attachment_available: true,
    delivery_status: 'held',
    delivery_state: 'HELD',
    delivery_source: 'AI_DRAFT',
    delivered: false,
    held_reason: 'low_confidence',
    suggestion_visibility: 'VISIBLE_HITL_REVIEW',
    provider_message_id: null,
    provider_send_attempted: false,
    provider_send_confirmed: false,
    reply_to: {
        provider_message_id: 'provider-fixture',
        internal_message_id: 'message-fixture',
        status: 'resolved',
        message_type: 'text',
        content: 'Earlier message',
        private_context: { fixture: true },
    },
    confidence_score: 0.96,
    confidence_components: { fixture: 'private' },
    grounding_knowledge_ids: ['knowledge-fixture'],
    reply_evidence: { label: 'GROUNDED', fixture: 'private' },
    custom_metadata: { fixture: 'private' },
};

const expectedMetadata = {
    message_type: 'file',
    attachments: [{
        type: 'file',
        url: 'https://assets.example.test/catalog.pdf',
        name: 'catalog.pdf',
        mime_type: 'application/pdf',
    }],
    file_name: 'catalog.pdf',
    attachment_source: 'inbox_upload',
    attachment_storage_key: 'shop-fixture/catalog.pdf',
    attachment_available: true,
    delivery_status: 'held',
    delivery_state: 'HELD',
    delivery_source: 'AI_DRAFT',
    delivered: false,
    held_reason: 'low_confidence',
    suggestion_visibility: 'VISIBLE_HITL_REVIEW',
    provider_message_id: null,
    provider_send_attempted: false,
    provider_send_confirmed: false,
    reply_to: {
        provider_message_id: 'provider-fixture',
        internal_message_id: 'message-fixture',
        status: 'resolved',
        message_type: 'text',
        content: 'Earlier message',
    },
};

test('projects the typed message metadata contract and nested consumer fields', () => {
    expect(projectPublicMessageMetadata(metadata)).toEqual(expectedMetadata);
});

test('rejects malformed metadata and values with the wrong field type', () => {
    expect(projectPublicMessageMetadata(null)).toBeNull();
    expect(projectPublicMessageMetadata([])).toBeNull();
    expect(projectPublicMessageMetadata({
        delivery_state: { fixture: 'private' },
        delivered: 'yes',
        attachments: [{ type: 'image', url: { fixture: 'private' }, secret: 'private' }],
        reply_to: { content: 'safe', metadata: { fixture: 'private' } },
    })).toEqual({
        attachments: [{ type: 'image' }],
        reply_to: { content: 'safe' },
    });
});

test('projects legacy source references separately from diagnostic metadata', () => {
    expect(projectPublicSourceReferences([
        { kind: 'faq', id: 'faq-fixture', title: 'Delivery times', score: 0.8, contextEligible: true, private: 'fixture' },
        { kind: 'unknown', title: 'not a supported source type' },
        { kind: 'product', title: { fixture: 'private' }, score: '0.7' },
    ])).toEqual([
        { kind: 'faq', id: 'faq-fixture', title: 'Delivery times', score: 0.8, contextEligible: true },
        { kind: 'product' },
    ]);
});

test('projects message metadata for live, replay, and other message-shaped SSE events', () => {
    const message = {
        id: 'message-fixture',
        conversation_id: 'conversation-fixture',
        content: 'A public message',
        sender: 'ai',
        message_type: 'text',
        ai_suggestion: 'A public suggestion',
        ai_confidence: '0.93',
        shop_id: 'private-shop-fixture',
        external_id: 'private-external-fixture',
        send_idempotency_key: 'private-idempotency-fixture',
        metadata,
        source_references: [{ kind: 'rag', id: 'source-fixture', title: 'Shipping policy', internal: 'fixture' }],
        reply_to: { provider_message_id: 'provider-fixture', content: 'Earlier message', private_context: 'fixture' },
    };
    const live = projectPublicMessageEvent('new_message', {
        conversation_id: 'conversation-fixture',
        message: { toJSON: () => message },
    });
    expect(live.message).toEqual({
        id: 'message-fixture',
        conversation_id: 'conversation-fixture',
        content: 'A public message',
        sender: 'ai',
        message_type: 'text',
        ai_suggestion: 'A public suggestion',
        ai_confidence: 0.93,
        metadata: expectedMetadata,
        source_references: [{ kind: 'rag', id: 'source-fixture', title: 'Shipping policy' }],
        reply_to: { provider_message_id: 'provider-fixture', content: 'Earlier message' },
    });

    expect(projectPublicMessageEvent('message_delivery_updated', { message_id: 'message-fixture', metadata }))
        .toEqual({ message_id: 'message-fixture', metadata: expectedMetadata });
    expect(projectPublicMessageEvent('message_replayed', {
        message_id: 'message-fixture',
        metadata,
        message: { id: 'message-fixture', metadata },
    })).toEqual({
        message_id: 'message-fixture',
        metadata: expectedMetadata,
        message: { id: 'message-fixture', metadata: expectedMetadata },
    });
});

test('normalizes persisted decimal confidence strings in SSE messages', () => {
    const projected = projectPublicMessageEvent('new_message', {
        message: { id: 'message-fixture', ai_confidence: '0.93' },
    });

    expect(projected.message.ai_confidence).toBe(0.93);
});
