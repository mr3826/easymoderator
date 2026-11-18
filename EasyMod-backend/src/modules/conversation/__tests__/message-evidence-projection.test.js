'use strict';

const { projectMessageEvidence, projectMessageEvent } = require('../message-evidence-projection');

const diagnostic = {
    confidence_mode: 'shadow', confidence_scope: 'suggestion', confidence_score: 1,
    confidence_reason_codes: ['GROUNDED', 'GROUNDED', 'unexpected'], confidence_provenance: 'model',
    confidence_components: { private: 'synthetic diagnostics' }, grounding_knowledge_ids: ['source-1'],
};

test('only exposes documented reasons and categories and can project twice for SSE replay', () => {
    const event = { conversation_id: 'conv-1', message: { id: 'msg-1', metadata: diagnostic } };
    const projected = projectMessageEvent('new_message', event);
    expect(projected.message.metadata).toEqual({ reply_evidence: { reasons: ['GROUNDED'], provenance: 'model' } });
    expect(projectMessageEvent('new_message', projected)).toEqual(projected);
});

test('clears pre-ack and edited-draft labels at delivery', () => {
    expect(projectMessageEvidence(diagnostic, { delivery_state: 'SENT' })).toEqual({ reply_evidence: null });
    expect(projectMessageEvidence({ ...diagnostic, confidence_scope: 'delivered' }, {
        delivery_state: 'SENT', delivery_source: 'DRAFT_APPROVAL',
    })).toEqual({ reply_evidence: null });
});

test('does not pass through malformed evidence or an unrecognized provenance', () => {
    expect(projectMessageEvidence(['unexpected'])).toEqual({});
    expect(projectMessageEvidence({ ...diagnostic, confidence_provenance: { private: 'fixture' } })).toEqual({
        reply_evidence: { reasons: ['GROUNDED'], provenance: null },
    });
});
