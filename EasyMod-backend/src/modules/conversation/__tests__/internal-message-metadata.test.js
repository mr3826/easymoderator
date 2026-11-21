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

// P0 sendProductCard contract — FLAGGED-FOR-PRIVACY-REVIEWER: these fields are
// allowlisted so the owning shop's readers keep receiving the deployed
// product-card payload. The independent privacy reviewer must approve or veto.
const productCardMetadata = {
    product_card: {
        product_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        title: 'Fixture Product',
        subtitle: '৳1200 · In stock (4)',
        image_url: 'https://assets.example.test/product.jpg',
        internal_note: { fixture: 'private' },
        cost_price: 900,
    },
    quick_replies: [
        {
            content_type: 'text',
            title: 'Order now',
            payload: 'product:3f2504e0-4f89-41d3-9a0c-0305e82c3301:q:0',
            customer_phone: '+8801000000000',
        },
        {
            title: 'Confirm order',
            content_type: 'text',
            payload: 'p1:3f2504e0-4f89-41d3-9a0c-0305e82c3301:checkout.confirm',
        },
    ],
    confidence_score: 0.91,
    grounding_knowledge_ids: ['knowledge-fixture'],
};

const expectedProductCardMetadata = {
    product_card: {
        product_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        title: 'Fixture Product',
        subtitle: '৳1200 · In stock (4)',
        image_url: 'https://assets.example.test/product.jpg',
    },
    quick_replies: [
        {
            content_type: 'text',
            title: 'Order now',
            payload: 'product:3f2504e0-4f89-41d3-9a0c-0305e82c3301:q:0',
        },
        {
            title: 'Confirm order',
            content_type: 'text',
            payload: 'p1:3f2504e0-4f89-41d3-9a0c-0305e82c3301:checkout.confirm',
        },
    ],
};

test('preserves the P0 product_card and quick_replies metadata for public readers', () => {
    expect(projectPublicMessageMetadata(productCardMetadata)).toEqual(expectedProductCardMetadata);
});

test('product-card allowlisting does not open a passthrough for unknown or private fields', () => {
    const projected = projectPublicMessageMetadata({
        ...productCardMetadata,
        shop_id: 'other-shop-fixture',
        external_id: 'private-external-fixture',
        other_shop_diagnostics: { fixture: 'private' },
    });
    expect(projected).toEqual(expectedProductCardMetadata);
    expect(projected).not.toHaveProperty('shop_id');
    expect(projected).not.toHaveProperty('external_id');
    expect(projected).not.toHaveProperty('other_shop_diagnostics');
    expect(projected).not.toHaveProperty('confidence_score');
    expect(projected).not.toHaveProperty('grounding_knowledge_ids');
});

test('strips malformed product-card values and PII-requesting quick-reply types', () => {
    expect(projectPublicMessageMetadata({
        product_card: 'not-a-record',
        quick_replies: 'not-an-array',
    })).toEqual({ product_card: null });
    expect(projectPublicMessageMetadata({
        product_card: { title: { fixture: 'private' }, subtitle: 42 },
        quick_replies: [
            { title: 'Share phone', content_type: 'user_phone_number', payload: 'ask-phone' },
            { content_type: 'text', payload: 'titleless-fixture' },
            { title: 'Keep', content_type: 'text', payload: 'p1:fixture:opt', extra: 'private' },
            'not-a-record',
        ],
    })).toEqual({
        product_card: null,
        quick_replies: [
            { title: 'Share phone', payload: 'ask-phone' },
            { title: 'Keep', content_type: 'text', payload: 'p1:fixture:opt' },
        ],
    });
});

test('projects product-card metadata through live SSE message events', () => {
    const projected = projectPublicMessageEvent('new_message', {
        conversation_id: 'conversation-fixture',
        message: {
            id: 'message-fixture',
            content: 'Fixture Product (৳1200 · In stock (4))',
            sender: 'agent',
            shop_id: 'private-shop-fixture',
            send_idempotency_key: 'private-idempotency-fixture',
            metadata: productCardMetadata,
        },
    });
    expect(projected.message.metadata).toEqual(expectedProductCardMetadata);
    expect(projected.message).not.toHaveProperty('shop_id');
    expect(projected.message).not.toHaveProperty('send_idempotency_key');

    expect(projectPublicMessageEvent('message_delivery_updated', {
        message_id: 'message-fixture',
        metadata: productCardMetadata,
    })).toEqual({ message_id: 'message-fixture', metadata: expectedProductCardMetadata });
});

test('keeps the PUBLIC_MESSAGE_FIELDS loop literal required by verify_reader_projection_source', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'internal-message-metadata.js'), 'utf8');
    expect(source).toContain('for (const field of PUBLIC_MESSAGE_FIELDS)');
});

test('normalizes persisted decimal confidence strings in SSE messages', () => {
    const projected = projectPublicMessageEvent('new_message', {
        message: { id: 'message-fixture', ai_confidence: '0.93' },
    });

    expect(projected.message.ai_confidence).toBe(0.93);
});
