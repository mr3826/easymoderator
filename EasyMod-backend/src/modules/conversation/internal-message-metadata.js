'use strict';

// Before Stage 2 is deployed, keep its persisted diagnostic namespace private
// so an API image restored during rollback can safely read newer message rows.
function withoutInternalMessageMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    return Object.fromEntries(Object.entries(metadata).filter(([key]) =>
        !key.startsWith('confidence_') && !key.startsWith('grounding_') && key !== 'reply_evidence'
    ));
}

function withoutInternalMessageEvent(event, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    if (event === 'message_delivery_updated') {
        return { ...data, metadata: withoutInternalMessageMetadata(data.metadata) };
    }
    if (event === 'new_message' && data.message && typeof data.message === 'object' && !Array.isArray(data.message)) {
        const message = typeof data.message.toJSON === 'function' ? data.message.toJSON() : data.message;
        return { ...data, message: { ...message, metadata: withoutInternalMessageMetadata(message.metadata) } };
    }
    return data;
}

module.exports = { withoutInternalMessageMetadata, withoutInternalMessageEvent };
