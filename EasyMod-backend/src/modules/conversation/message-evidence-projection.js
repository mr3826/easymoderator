'use strict';

const { CONFIDENCE_REASON, PROVENANCE } = require('../ai/reply-confidence.service');
const { projectPublicMessageMetadata, projectPublicMessageEvent } = require('./internal-message-metadata');

const reasons = new Set(Object.values(CONFIDENCE_REASON));
const provenance = new Set(Object.values(PROVENANCE));
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function projectMessageEvidence(metadata, lifecycle = {}) {
    const source = record(metadata) ? metadata : {};
    const result = projectPublicMessageMetadata(source);
    const approved = lifecycle.delivery_source === 'DRAFT_APPROVAL' || source.delivery_source === 'DRAFT_APPROVAL';
    const confirmed = ['SENT', 'DELIVERED'].includes(lifecycle.delivery_state ?? source.delivery_state)
        || source.delivered === true;
    const scope = confirmed ? 'delivered' : 'suggestion';
    const evidence = source.confidence_mode === 'shadow'
        ? (source.confidence_scope === scope ? {
            reasons: source.confidence_reason_codes,
            provenance: source.confidence_provenance,
        } : null)
        // SSE applies the projection both before publication and before framing.
        : source.reply_evidence;
    if (approved || (confirmed && source.confidence_scope === 'suggestion')) {
        result.reply_evidence = null;
    } else if (record(evidence) && Array.isArray(evidence.reasons)) {
        const publicReasons = [...new Set(evidence.reasons.filter(code => reasons.has(code)))];
        if (publicReasons.length > 0) {
            result.reply_evidence = {
                reasons: publicReasons,
                provenance: provenance.has(evidence.provenance) ? evidence.provenance : null,
            };
        }
    } else if (source.reply_evidence === null) {
        result.reply_evidence = null;
    }
    return result;
}

function projectMessageEvent(event, data) {
    const projected = projectPublicMessageEvent(event, data);
    if (!record(data)) return projected;
    if (event === 'new_message' && record(data.message)) {
        const message = typeof data.message.toJSON === 'function' ? data.message.toJSON() : data.message;
        if (!record(message)) return projected;
        return { ...projected, message: { ...projected.message, metadata: projectMessageEvidence(message.metadata, message) } };
    }
    if (event === 'message_delivery_updated') {
        return { ...projected, metadata: projectMessageEvidence(data.metadata, data) };
    }
    return projected;
}

module.exports = { projectMessageEvidence, projectMessageEvent };
