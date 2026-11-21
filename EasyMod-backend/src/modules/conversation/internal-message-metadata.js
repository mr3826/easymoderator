'use strict';

const MESSAGE_TYPES = new Set(['text', 'image', 'file', 'location']);
const DELIVERY_STATES = new Set([
    'GENERATING',
    'DRAFT_READY',
    'SEND_PENDING',
    'SENT',
    'DELIVERED',
    'FAILED',
    'HELD',
    'DISMISSED',
]);
const DELIVERY_STATUSES = new Set(['processing', 'pending', 'sent', 'failed', 'held', 'dismissed']);
const SUGGESTION_VISIBILITIES = new Set([
    'HIDDEN_AUTO_PROCESSING',
    'VISIBLE_DRAFT_REVIEW',
    'VISIBLE_HITL_REVIEW',
    'VISIBLE_MERCHANT_REQUESTED',
    'HIDDEN_SENT',
    'HIDDEN_DISMISSED',
]);
const MESSAGE_SENDERS = new Set(['customer', 'agent', 'ai']);
const SOURCE_KINDS = new Set(['rag', 'faq', 'product']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value) {
    return typeof value === 'string' ? value : undefined;
}

function nullableStringValue(value) {
    return value === null || typeof value === 'string' ? value : undefined;
}

function booleanValue(value) {
    return typeof value === 'boolean' ? value : undefined;
}

function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableNumberValue(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
}

function nullableNumericStringValue(value) {
    if (typeof value === 'string' && value.trim() !== '') {
        value = Number(value);
    }
    return nullableNumberValue(value);
}

function enumValue(values, nullable = false) {
    return (value) => (nullable && value === null) || values.has(value) ? value : undefined;
}

function stringArrayValue(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? [...value]
        : undefined;
}

function projectObject(value, fields) {
    if (!isRecord(value)) return null;

    const result = {};
    for (const [key, project] of Object.entries(fields)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const projected = project(value[key]);
        if (projected !== undefined) result[key] = projected;
    }
    return result;
}

const projectAttachment = (value) => projectObject(value, {
    type: nullableStringValue,
    url: nullableStringValue,
    name: nullableStringValue,
    mime_type: nullableStringValue,
});

const projectReplyContext = (value) => {
    const projected = projectObject(value, {
        provider_message_id: stringValue,
        internal_message_id: nullableStringValue,
        is_self_reply: booleanValue,
        status: enumValue(new Set(['resolved', 'unavailable'])),
        sender: enumValue(MESSAGE_SENDERS),
        content: nullableStringValue,
        message_type: enumValue(MESSAGE_TYPES),
        file_name: nullableStringValue,
    });
    return projected && Object.keys(projected).length > 0 ? projected : null;
};

const projectAttachments = (value) => Array.isArray(value)
    ? value.map(projectAttachment).filter(Boolean)
    : undefined;

const nullableMessageType = enumValue(MESSAGE_TYPES, true);
const nullableDeliveryState = enumValue(DELIVERY_STATES, true);

// --- P0 sendProductCard contract (post-launch baseline) ---
// FLAGGED-FOR-PRIVACY-REVIEWER: `product_card` and `quick_replies` are added to
// the typed public allowlist to preserve the deployed P0 sendProductCard
// contract — the owning shop's inbox history and SSE readers must keep
// receiving metadata.product_card and metadata.quick_replies. Both carry
// shop-scoped merchant data only: product id/title, price + stock subtitle,
// HTTPS image URL, and quick-reply titles with opaque server-generated payload
// references (`product:<product-uuid>:q:<idx>` from sendProductCard,
// `p1:<interaction-uuid>:<option>` from the interactions registry). No
// customer PII is written by either producer. The independent privacy
// reviewer must explicitly approve or veto this addition.
const QUICK_REPLY_CONTENT_TYPES = new Set(['text']);

const projectProductCard = (value) => {
    const projected = projectObject(value, {
        product_id: stringValue,
        title: stringValue,
        subtitle: stringValue,
        image_url: stringValue,
    });
    return projected && Object.keys(projected).length > 0 ? projected : null;
};

const projectQuickReply = (value) => {
    const projected = projectObject(value, {
        title: stringValue,
        // Only server-generated 'text' taps pass; PII-requesting content types
        // (user_phone_number / user_email) must never reach public readers.
        content_type: enumValue(QUICK_REPLY_CONTENT_TYPES),
        payload: stringValue,
    });
    return projected?.title ? projected : null;
};

const projectQuickReplies = (value) => Array.isArray(value)
    ? value.map(projectQuickReply).filter(Boolean)
    : undefined;

const MESSAGE_METADATA_FIELDS = Object.freeze({
    message_type: enumValue(MESSAGE_TYPES),
    attachments: projectAttachments,
    image_url: stringValue,
    file_url: stringValue,
    file_name: stringValue,
    mime_type: stringValue,
    file_size: numberValue,
    attachment_source: nullableStringValue,
    attachment_storage_key: nullableStringValue,
    attachment_available: booleanValue,
    delivery_status: enumValue(DELIVERY_STATUSES),
    delivery_error: stringValue,
    delivered: booleanValue,
    held_reason: stringValue,
    delivery_state: enumValue(DELIVERY_STATES),
    provider_message_id: nullableStringValue,
    provider_message_ids: (value) => value === null ? null : stringArrayValue(value),
    provider_send_attempted: booleanValue,
    provider_send_confirmed: booleanValue,
    delivery_source: nullableStringValue,
    suggestion_visibility: enumValue(SUGGESTION_VISIBILITIES),
    reply_to_provider_message_id: nullableStringValue,
    reply_to_internal_message_id: nullableStringValue,
    reply_to_is_self_reply: booleanValue,
    reply_to: projectReplyContext,
    // P0 sendProductCard contract — FLAGGED-FOR-PRIVACY-REVIEWER (see note above).
    product_card: projectProductCard,
    quick_replies: projectQuickReplies,
});

function projectPublicMessageMetadata(metadata) {
    if (!isRecord(metadata)) return null;
    return projectObject(metadata, MESSAGE_METADATA_FIELDS);
}

const SOURCE_REFERENCE_FIELDS = Object.freeze({
    kind: enumValue(SOURCE_KINDS),
    id: nullableStringValue,
    title: nullableStringValue,
    score: nullableNumberValue,
    contextEligible: booleanValue,
});

const PUBLIC_MESSAGE_FIELDS = Object.freeze([
    'id',
    'conversation_id',
    'content',
    'sender',
    'message_type',
    'metadata',
    'ai_suggestion',
    'ai_confidence',
    'source_references',
    'message_tag',
    'delivery_state',
    'provider_message_id',
    'delivery_source',
    'reply_to',
    'is_transcript_message',
    'created_at',
    'updated_at',
]);

function projectPublicSourceReferences(references) {
    if (!Array.isArray(references)) return null;
    return references.map((reference) => {
        const projected = projectObject(reference, SOURCE_REFERENCE_FIELDS);
        return projected?.kind ? projected : null;
    }).filter(Boolean);
}

function projectPublicMessage(message) {
    const plain = typeof message?.toJSON === 'function' ? message.toJSON() : message;
    if (!isRecord(plain)) return plain;

    const projected = {};
    for (const field of PUBLIC_MESSAGE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(plain, field)) projected[field] = plain[field];
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'metadata')) {
        projected.metadata = projectPublicMessageMetadata(plain.metadata);
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'message_type')) {
        projected.message_type = nullableMessageType(plain.message_type) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'delivery_state')) {
        projected.delivery_state = nullableDeliveryState(plain.delivery_state) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'provider_message_id')) {
        projected.provider_message_id = nullableStringValue(plain.provider_message_id) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'delivery_source')) {
        projected.delivery_source = nullableStringValue(plain.delivery_source) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'ai_suggestion')) {
        projected.ai_suggestion = nullableStringValue(plain.ai_suggestion) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'ai_confidence')) {
        projected.ai_confidence = nullableNumericStringValue(plain.ai_confidence) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'reply_to')) {
        projected.reply_to = projectReplyContext(plain.reply_to);
    }
    if (Object.prototype.hasOwnProperty.call(plain, 'source_references')) {
        projected.source_references = projectPublicSourceReferences(plain.source_references);
    }
    return projected;
}

function projectPublicMessageEvent(event, data) {
    if (!isRecord(data)) return data;

    let projected = data;
    if (isRecord(data.message)) {
        projected = { ...projected, message: projectPublicMessage(data.message) };
    } else if (Array.isArray(data.messages)) {
        projected = { ...projected, messages: data.messages.map(projectPublicMessage) };
    }

    const carriesMessageMetadata = event === 'message_delivery_updated'
        || (typeof event === 'string' && event.startsWith('message_'))
        || (data.message_id != null && Object.prototype.hasOwnProperty.call(data, 'metadata'));
    if (carriesMessageMetadata && Object.prototype.hasOwnProperty.call(data, 'metadata')) {
        projected = { ...projected, metadata: projectPublicMessageMetadata(data.metadata) };
    }
    if (carriesMessageMetadata && Object.prototype.hasOwnProperty.call(data, 'source_references')) {
        projected = { ...projected, source_references: projectPublicSourceReferences(data.source_references) };
    }

    return projected;
}

module.exports = {
    projectPublicMessageMetadata,
    projectPublicSourceReferences,
    projectPublicMessage,
    projectPublicMessageEvent,
};
