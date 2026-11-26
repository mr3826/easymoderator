'use strict';

const crypto = require('crypto');

// question||category preference (20261126_001): the merchant question is the
// authoritative column; `category` is only its legacy mirror, used for rows
// written before the migration (question NULL). keywords/internal_notes are
// private merchant data and must NEVER enter snapshot content (the snapshot
// fingerprint is compared at the AI send boundary).
const faqQuestionText = (faq) => {
    const question = faq?.question;
    if (question !== null && question !== undefined && String(question).trim()) {
        return String(question);
    }
    return faq?.category;
};

const faqContent = (faq) => [faqQuestionText(faq), faq?.template_en, faq?.template_bn]
    .filter(value => value !== null && value !== undefined && String(value).trim())
    .map(value => String(value))
    .join('\n');

const faqContentHash = (faq) => crypto.createHash('sha256')
    .update(faqContent(faq), 'utf8')
    .digest('hex');

const faqSnapshot = (faq) => faq?.id === null || faq?.id === undefined
    ? null
    : { id: String(faq.id), type: 'faq', contentHash: faqContentHash(faq) };

const normalizeKnowledgeId = (id) => String(id || '').replace(/^faq-/i, '');

module.exports = {
    faqContent,
    faqContentHash,
    faqSnapshot,
    normalizeKnowledgeId,
};
