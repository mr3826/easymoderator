const Joi = require('joi');

// FAQ lifecycle statuses (20261126_001 migration; knowledge.service owns the
// transition MACHINE — the validator only pins the vocabulary so an unknown
// status never reaches the service).
const FAQ_STATUSES = ['draft', 'review', 'published', 'disabled', 'archived'];

// Merchant-facing enrichment bounds. keywords/notes are NEVER projected into
// customer-facing AI surfaces (see knowledge.service formatFaqProjection).
const FAQ_KEYWORDS_MAX_ITEMS = 32;
const FAQ_KEYWORD_MAX_LENGTH = 80;
const FAQ_NOTES_MAX_LENGTH = 5000;
const FAQ_CATEGORY_TAG_MAX_LENGTH = 60;

// At-least-one-answer rule for create: any answer slot may carry it.
// Legacy `answer` aliases the EN slot; `template_en`/`template_bn` are the
// storage-shaped aliases kept for old clients.
const requireAnyAnswer = (value, helpers) => {
    const hasAnswer = ['answer', 'answer_en', 'answer_bn', 'template_en', 'template_bn']
        .some((key) => typeof value[key] === 'string' && value[key].trim());
    if (!hasAnswer) {
        return helpers.error('faq.anyAnswer');
    }
    return value;
};

const faqKeywordsSchema = Joi.array()
    .items(Joi.string().trim().max(FAQ_KEYWORD_MAX_LENGTH))
    .max(FAQ_KEYWORDS_MAX_ITEMS)
    .optional();

class KnowledgeValidator {
    getKnowledge = {};

    updateBusinessInfo = {
        body: Joi.object({
            shopName: Joi.string().trim().allow('').optional(),
            // nameEn is DISPLAY metadata — shopName remains the single
            // authoritative identity (single-shop-name sync contract).
            nameEn: Joi.string().trim().max(120).allow('').optional(),
            tagline: Joi.string().trim().max(160).allow('').optional(),
            // Customer-facing contact address only — never credentials, never
            // login identity, zero auth coupling.
            email: Joi.string().trim().max(254).allow('').optional()
                .pattern(/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/, 'email'),
            city: Joi.string().trim().max(60).allow('').optional(),
            address: Joi.string().trim().allow('').optional(),
            phone: Joi.string().trim().allow('').optional(),
            openingHours: Joi.string().trim().allow('').optional(),
            additionalInfo: Joi.string().trim().max(3000).allow('').optional(),
            deliveryAreas: Joi.array().items(Joi.string().trim()).optional(),
            paymentMethods: Joi.array().items(Joi.string().trim()).optional(),
            socialLinks: Joi.object({
                facebook: Joi.string().allow('').optional(),
                instagram: Joi.string().allow('').optional(),
                whatsapp: Joi.string().allow('').optional(),
                tiktok: Joi.string().allow('').optional(),
                youtube: Joi.string().allow('').optional(),
                website: Joi.string().allow('').optional(),
            }).optional()
        })
    };

    updateBrandingRules = {
        body: Joi.object({
            tone:               Joi.string().valid('formal', 'friendly', 'casual').optional(),
            languagePreference: Joi.string().trim().max(20).optional(),
            emojiUsage:         Joi.string().valid('none', 'light', 'moderate', 'heavy').optional(),
            forbiddenPhrases:   Joi.array().items(Joi.string().trim().max(200)).max(100).optional(),
            escalationKeywords: Joi.array().items(Joi.string().trim().max(100)).max(50).optional(),
            greetingStyle:      Joi.string().trim().max(500).optional(),
            closingStyle:       Joi.string().trim().max(500).optional(),
        }).options({ allowUnknown: false })
    };

    // New shape: {question, answer_en, answer_bn, category_tag?, keywords?[],
    // notes?, status?, priority?}. Legacy aliases stay accepted
    // (answer → answer_en slot; category → question when question absent,
    // never the other way — the category-overwrites-question bug is now
    // structurally impossible because the tag lives in category_tag);
    // confidence/usageCount/source are ACCEPTED-BUT-DISCARDED for old
    // clients: confidence is not a product concept anymore, use_count is
    // server-owned ("replies used"), and source is derived ('manual').
    createFaq = {
        body: Joi.object({
            question:    Joi.string().trim().min(1).max(2000).required(),
            answer:      Joi.string().trim().allow('').optional(),
            answer_en:   Joi.string().trim().allow('').optional(),
            answer_bn:   Joi.string().trim().allow('').optional(),
            template_en: Joi.string().trim().allow('', null).optional(),
            template_bn: Joi.string().trim().allow('', null).optional(),
            category:    Joi.string().trim().allow('').optional(),
            category_tag: Joi.string().trim().max(FAQ_CATEGORY_TAG_MAX_LENGTH).allow('', null).optional(),
            keywords:    faqKeywordsSchema,
            notes:       Joi.string().trim().max(FAQ_NOTES_MAX_LENGTH).allow('', null).optional(),
            status:      Joi.string().valid(...FAQ_STATUSES).optional(),
            priority:    Joi.number().integer().min(0).max(1000).optional(),
            variables:   Joi.array().optional(),
            active:      Joi.boolean().optional(),
            confidence:  Joi.number().min(0).max(1).optional(),
            source:      Joi.string().trim().optional(),
            usageCount:  Joi.number().integer().min(0).optional()
        }).custom(requireAnyAnswer, 'faq-any-answer').messages({
            'faq.anyAnswer': 'answer is required (answer, answer_en or answer_bn)',
        })
    };

    updateFaq = {
        params: Joi.object({
            id: Joi.string().required()
        }),
        body: Joi.object({
            question:    Joi.string().trim().min(1).max(2000).optional(),
            answer:      Joi.string().trim().allow('').optional(),
            answer_en:   Joi.string().trim().allow('').optional(),
            answer_bn:   Joi.string().trim().allow('').optional(),
            template_en: Joi.string().trim().allow('', null).optional(),
            template_bn: Joi.string().trim().allow('', null).optional(),
            category:    Joi.string().trim().allow('').optional(),
            category_tag: Joi.string().trim().max(FAQ_CATEGORY_TAG_MAX_LENGTH).allow('', null).optional(),
            keywords:    faqKeywordsSchema,
            notes:       Joi.string().trim().max(FAQ_NOTES_MAX_LENGTH).allow('', null).optional(),
            status:      Joi.string().valid(...FAQ_STATUSES).optional(),
            priority:    Joi.number().integer().min(0).max(1000).optional(),
            variables:   Joi.array().optional(),
            active:      Joi.boolean().optional(),
            confidence:  Joi.number().min(0).max(1).optional(),
            source:      Joi.string().trim().optional(),
            usageCount:  Joi.number().integer().min(0).optional()
        })
    };

    faqId = {
        params: Joi.object({
            id: Joi.string().required()
        })
    };

    deleteFaq = {
        params: Joi.object({
            id: Joi.string().required()
        })
    };

    updateGaps = {
        body: Joi.array().items(Joi.object({
            id: Joi.string().required(),
            question: Joi.string().trim().required(),
            frequency: Joi.number().integer().min(0).required(),
            suggestedAnswer: Joi.string().trim().optional(),
            confidence: Joi.number().min(0).max(1).optional(),
            firstAsked: Joi.string().optional(),
            lastAsked: Joi.string().optional()
        }))
    };

    createDocument = {
        body: Joi.object({
            name: Joi.string().trim().required(),
            contentType: Joi.string().trim().optional(),
            size: Joi.number().integer().min(0).optional(),
            url: Joi.string().uri().optional(),
            text: Joi.string().allow('').optional(),
            tags: Joi.array().items(Joi.string().trim()).optional(),
            source: Joi.string().trim().optional(),
            status: Joi.string().trim().optional()
        })
    };

    deleteDocument = {
        params: Joi.object({
            id: Joi.string().required()
        })
    };
}

module.exports = new KnowledgeValidator();
module.exports.FAQ_STATUSES = FAQ_STATUSES;
