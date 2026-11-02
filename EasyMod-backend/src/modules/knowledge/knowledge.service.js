const { Shop, UserShop, FaqResponse, BanglishDictionary } = require('../entities');
const shopService = require('../shop/shop.service');
const KnowledgeGap = require('../analytics/knowledge-gap.entity');
const { AppError } = require('../../utils/AppError');
const ragService = require('../rag/rag.service');
const cacheService = require('../../utils/cache.service');
const {
    MERCHANT_KNOWLEDGE_CACHE_KEY,
    AI_KNOWLEDGE_CACHE_KEY,
    invalidateShopSettingsCaches,
} = require('../../utils/shop-settings-cache');
const crypto = require('crypto');
const { Op, fn, col, literal } = require('sequelize');

const KNOWLEDGE_CACHE_KEY = MERCHANT_KNOWLEDGE_CACHE_KEY;
const KNOWLEDGE_CACHE_TTL = 300; // 5 minutes
const MAX_DOC_SIZE = 100 * 1024; // 100 KB
const safeErrorCode = (error, fallback = 'KNOWLEDGE_RAG_ERROR') => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : fallback;
};

// ── Auth helpers ──────────────────────────────────────────────────────────────

const verifyShopAccess = async (userId, shopId) => {
    const userShop = await UserShop.findOne({
        where: { user_id: userId, shop_id: shopId, is_active: true }
    });
    if (!userShop) {
        throw new AppError('You do not have access to this shop', 403);
    }
    return userShop;
};

// ── Serialization ─────────────────────────────────────────────────────────────

/**
 * Map a FaqResponse Sequelize instance to the shape the frontend expects.
 * Frontend types: { id, question, answer, category, confidence, source,
 *                   active, usageCount, createdAt, updatedAt }
 */
const formatFaq = (faq) => ({
    id: String(faq.id),
    question: faq.category,
    answer: faq.template_en || faq.template_bn || '',
    category: faq.category,
    template_bn: faq.template_bn,
    template_en: faq.template_en,
    confidence: 1.0, // manually-authored FAQs are always highest confidence
    source: 'manual',
    active: faq.is_active,
    usageCount: faq.use_count || 0,
    priority: faq.priority,
    createdAt: faq.created_at,
    updatedAt: faq.updated_at || faq.created_at,
});

const buildFaqIndexText = (faq) => [
    faq.category && `Q: ${faq.category}`,
    faq.template_bn && `A (BN): ${faq.template_bn}`,
    faq.template_en && `A (EN): ${faq.template_en}`,
].filter(Boolean).join('\n');

const syncFaqRagIndex = async (shopId, faq) => {
    if (!faq?.id) return;

    const documentId = `faq-${faq.id}`;
    if (faq.is_active === false) {
        await ragService.deletePoint(documentId, shopId).catch(() => {});
        return;
    }

    const text = buildFaqIndexText(faq);
    if (!text) return;

    const result = await ragService.ingestData({
        text,
        metadata: {
            documentId,
            shopId,
            type: 'faq',
            faq_id: faq.id
        }
    }).catch((error) => ({ success: false, errorCode: safeErrorCode(error, 'FAQ_RAG_SYNC_FAILED') }));

    if (!result?.success) {
        console.warn('FAQ RAG sync skipped', {
            faqId: faq.id,
            errorCode: safeErrorCode({ code: result?.errorCode }, 'FAQ_RAG_SYNC_FAILED'),
        });
    }
};

const buildBusinessInfoIndexText = (businessInfo = {}) => [
    businessInfo.shopName && `Shop name: ${businessInfo.shopName}`,
    businessInfo.description && `Description: ${businessInfo.description}`,
    businessInfo.address && `Address: ${businessInfo.address}`,
    businessInfo.phone && `Phone: ${businessInfo.phone}`,
    (businessInfo.openingHours || businessInfo.businessHours) && `Business hours: ${businessInfo.openingHours || businessInfo.businessHours}`,
    businessInfo.additionalInfo && `Additional shop owner info: ${businessInfo.additionalInfo}`,
    ...Object.entries(normalizeObject(businessInfo.socialLinks))
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([key, value]) => `${key}: ${value.trim()}`),
    businessInfo.returnPolicy && `Return policy: ${businessInfo.returnPolicy}`,
    businessInfo.deliveryPolicy && `Delivery policy: ${businessInfo.deliveryPolicy}`,
].filter(Boolean).join('\n');

const syncBusinessInfoRagIndex = async (shopId, businessInfo) => {
    const documentId = `biz-${shopId}`;
    await ragService.deletePoint(documentId, shopId).catch(() => {});

    const text = buildBusinessInfoIndexText(businessInfo);
    if (!text) return;

    const result = await ragService.ingestData({
        text,
        metadata: {
            documentId,
            shopId,
            type: 'business_info'
        }
    }).catch((error) => ({ success: false, errorCode: safeErrorCode(error, 'BUSINESS_INFO_RAG_SYNC_FAILED') }));

    if (!result?.success) {
        console.warn('Business info RAG sync skipped', {
            shopId,
            errorCode: safeErrorCode({ code: result?.errorCode }, 'BUSINESS_INFO_RAG_SYNC_FAILED'),
        });
    }
};

const invalidateShopKnowledgeCaches = async (shopId) => {
    await invalidateShopSettingsCaches(shopId);
};

// ── JSON helpers ──────────────────────────────────────────────────────────────

const normalizeArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return value.split(',').map(v => v.trim()).filter(Boolean);
        }
    }
    return [];
};

const normalizeObject = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
};

const getShop = async (shopId) => {
    const shop = await Shop.findByPk(shopId);
    if (!shop) throw new AppError('Shop not found', 404);
    return shop;
};

// ── Core knowledge read ───────────────────────────────────────────────────────

const getKnowledge = async (userId, shopId) => {
    await verifyShopAccess(userId, shopId);

    const cached = await cacheService.getForShop(shopId, KNOWLEDGE_CACHE_KEY);
    if (cached) return cached;

    const [shop, faqs] = await Promise.all([
        getShop(shopId),
        FaqResponse.findAll({ where: { shop_id: shopId }, order: [['priority', 'DESC']] })
    ]);

    const settings = normalizeObject(shop.settings);

    // Fix #6: Do NOT expose the Facebook page access token to the frontend.
    // The token is for server-side API calls only.
    const businessInfo = normalizeObject(settings.businessInfo);

    const aiSettings = await shopService.getShopAiSettings(shopId).catch(() => ({}));

    const result = {
        businessInfo,
        brandingRules: normalizeObject(settings.brandingRules),
        faqs: faqs.map(formatFaq),
        documents: normalizeArray(settings.documents),
        ai_settings: aiSettings
    };

    await cacheService.setForShop(shopId, KNOWLEDGE_CACHE_KEY, result, KNOWLEDGE_CACHE_TTL).catch(() => {});
    return result;
};

// ── Business info ─────────────────────────────────────────────────────────────

const updateBusinessInfo = async (userId, shopId, data) => {
    await verifyShopAccess(userId, shopId);
    const normalizedShopName = data.shopName && String(data.shopName).trim();
    const shopUpdates = normalizedShopName
        ? { shop_name: normalizedShopName, name: normalizedShopName }
        : {};
    let businessInfo;
    await shopService.updateShopSettingsPreservingRtoConsent(shopId, (settings) => {
        const existing = normalizeObject(settings.businessInfo);

        // Merge incoming data onto fresh values; partial saves must not restore stale settings.
        businessInfo = {
            ...existing,
            shopName:       data.shopName       !== undefined ? String(data.shopName).trim()       : existing.shopName       || '',
            address:        data.address        !== undefined ? String(data.address).trim()        : existing.address        || '',
            phone:          data.phone          !== undefined ? String(data.phone).trim()          : existing.phone          || '',
            openingHours:   data.openingHours   !== undefined ? String(data.openingHours).trim()   : existing.openingHours   || '',
            additionalInfo: data.additionalInfo !== undefined ? String(data.additionalInfo).trim() : existing.additionalInfo || '',
            deliveryAreas:  data.deliveryAreas  !== undefined ? normalizeArray(data.deliveryAreas)  : normalizeArray(existing.deliveryAreas),
            paymentMethods: data.paymentMethods !== undefined ? normalizeArray(data.paymentMethods) : normalizeArray(existing.paymentMethods),
            // Social links surfaced in the order-confirmation closing (ai-messaging.renderSocialLinks).
            socialLinks:    data.socialLinks    !== undefined ? normalizeObject(data.socialLinks)    : normalizeObject(existing.socialLinks),
        };
        return { businessInfo };
    }, shopUpdates);
    await syncBusinessInfoRagIndex(shopId, businessInfo);

    return { businessInfo };
};

// ── Branding rules ────────────────────────────────────────────────────────────

const updateBrandingRules = async (userId, shopId, brandingRules) => {
    await verifyShopAccess(userId, shopId);
    await shopService.updateShopSettingsPreservingRtoConsent(shopId, {
        brandingRules: brandingRules || {},
    });

    return { brandingRules };
};

// ── FAQs ──────────────────────────────────────────────────────────────────────

const listFaqs = async (userId, shopId) => {
    await verifyShopAccess(userId, shopId);
    const faqs = await FaqResponse.findAll({
        where: { shop_id: shopId },
        order: [['priority', 'DESC']]
    });
    return faqs.map(formatFaq);
};

const createFaq = async (userId, shopId, faq) => {
    await verifyShopAccess(userId, shopId);
    const newFaq = await FaqResponse.create({
        shop_id: shopId,
        category: faq.category || faq.question || 'General',
        template_bn: faq.template_bn || null,
        template_en: faq.template_en || faq.answer || null,
        variables: faq.variables || [],
        priority: faq.priority || 0,
        is_active: faq.is_active !== undefined ? faq.is_active : (faq.active !== undefined ? faq.active : true)
    });

    await syncFaqRagIndex(shopId, newFaq);
    await invalidateShopKnowledgeCaches(shopId);

    return formatFaq(newFaq);
};

const updateFaq = async (userId, shopId, faqId, updates) => {
    await verifyShopAccess(userId, shopId);
    const faq = await FaqResponse.findOne({ where: { id: faqId, shop_id: shopId } });
    if (!faq) throw new AppError('FAQ not found', 404);

    const nextValues = {
        category: updates.category || updates.question || faq.category,
        template_bn: updates.template_bn !== undefined ? updates.template_bn : faq.template_bn,
        template_en: updates.template_en !== undefined
            ? updates.template_en
            : (updates.answer !== undefined ? updates.answer : faq.template_en),
        variables: updates.variables || faq.variables,
        priority: updates.priority !== undefined ? updates.priority : faq.priority,
        is_active: updates.is_active !== undefined
            ? updates.is_active
            : (updates.active !== undefined ? updates.active : faq.is_active)
    };

    await faq.update(nextValues);
    const indexedFaq = typeof faq.get === 'function' ? faq.get({ plain: true }) : { ...faq };
    Object.assign(indexedFaq, nextValues);

    await syncFaqRagIndex(shopId, indexedFaq);
    await invalidateShopKnowledgeCaches(shopId);

    return formatFaq(indexedFaq);
};

const deleteFaq = async (userId, shopId, faqId) => {
    await verifyShopAccess(userId, shopId);
    await FaqResponse.destroy({ where: { id: faqId, shop_id: shopId } });
    await ragService.deletePoint(`faq-${faqId}`, shopId).catch(() => {});
    await invalidateShopKnowledgeCaches(shopId);
    return { message: 'FAQ deleted successfully' };
};

// ── Knowledge Gaps ────────────────────────────────────────────────────────────

/**
 * Fix #10: Read gaps from the KnowledgeGap DB table (written by n8n),
 * aggregated by question to compute frequency + date range.
 */
const listGaps = async (userId, shopId) => {
    await verifyShopAccess(userId, shopId);

    const rows = await KnowledgeGap.findAll({
        where: { shop_id: shopId },
        order: [['created_at', 'DESC']],
        limit: 200
    });

    // Aggregate: group by normalised question text
    const gapMap = new Map();
    for (const row of rows) {
        const key = row.question.trim().toLowerCase();
        if (!gapMap.has(key)) {
            gapMap.set(key, {
                id: String(row.id),
                question: row.question,
                frequency: 0,
                platform: row.platform,
                language: row.language,
                firstAsked: row.created_at,
                lastAsked: row.created_at
            });
        }
        const g = gapMap.get(key);
        g.frequency++;
        if (new Date(row.created_at) < new Date(g.firstAsked)) g.firstAsked = row.created_at;
        if (new Date(row.created_at) > new Date(g.lastAsked))  g.lastAsked  = row.created_at;
    }

    return Array.from(gapMap.values()).sort((a, b) => b.frequency - a.frequency);
};

// ── Documents ─────────────────────────────────────────────────────────────────

const listDocuments = async (userId, shopId) => {
    await verifyShopAccess(userId, shopId);
    const shop = await getShop(shopId);
    const settings = normalizeObject(shop.settings);
    return normalizeArray(settings.documents);
};

const createDocument = async (userId, shopId, document) => {
    await verifyShopAccess(userId, shopId);

    // Fix #12: Limit document text size to 100 KB
    if (document?.text && document.text.length > MAX_DOC_SIZE) {
        throw new AppError(
            `Document text too large (${Math.round(document.text.length / 1024)} KB). Maximum is 100 KB.`,
            400
        );
    }

    const newDocument = {
        id: crypto.randomUUID(),
        name: document.name,
        contentType: document.contentType,
        size: document.size,
        source: document.source,
        tags: document.tags || [],
        createdAt: new Date().toISOString(),
        status: document?.text ? 'processing' : 'indexed'
    };

    await shopService.updateShopSettingsPreservingRtoConsent(shopId, (settings) => ({
        documents: [...normalizeArray(settings.documents), newDocument],
    }));

    // Fix #8: Non-blocking RAG ingestion — update status in background
    if (document?.text) {
        ragService.ingestData({
            text: document.text,
            metadata: {
                documentId: newDocument.id,
                shopId,
                name: document.name,
                contentType: document.contentType,
                source: document.source,
                tags: document.tags || []
            }
        }).then(async () => {
            // Update status to indexed
            await shopService.updateShopSettingsPreservingRtoConsent(shopId, (settings) => ({
                documents: normalizeArray(settings.documents).map(d =>
                    d.id === newDocument.id ? { ...d, status: 'indexed' } : d
                ),
            }));
        }).catch(async (err) => {
            const errorCode = safeErrorCode(err, 'RAG_INGEST_FAILED');
            console.warn('RAG document ingest failed', { documentId: newDocument.id, errorCode });
            // Update status to failed
            await shopService.updateShopSettingsPreservingRtoConsent(shopId, (settings) => ({
                documents: normalizeArray(settings.documents).map(d =>
                    d.id === newDocument.id ? { ...d, status: 'failed', error: errorCode } : d
                ),
            })).catch(() => {});
        });
    }

    return newDocument;
};

const deleteDocument = async (userId, shopId, documentId) => {
    await verifyShopAccess(userId, shopId);
    await shopService.updateShopSettingsPreservingRtoConsent(shopId, (settings) => ({
        documents: normalizeArray(settings.documents).filter(doc => doc.id !== documentId),
    }));
    ragService.deletePoint(documentId, shopId).catch(() => {});

    return { message: 'Document deleted successfully' };
};

// ── FAQ search ────────────────────────────────────────────────────────────────

const searchFaq = async (userId, shopId, payload) => {
    await verifyShopAccess(userId, shopId);

    const query = payload.query || payload.category || '';
    const whereClause = { shop_id: shopId, is_active: true };
    if (payload.category) whereClause.category = payload.category;
    if (query) {
        whereClause[Op.or] = [
            { category:    { [Op.iLike]: `%${query}%` } },
            { template_en: { [Op.iLike]: `%${query}%` } },
            { template_bn: { [Op.iLike]: `%${query}%` } }
        ];
    }

    const faqs = await FaqResponse.findAll({
        where: whereClause,
        order: [['priority', 'DESC'], ['use_count', 'DESC']],
        limit: payload.limit || 10
    });
    return faqs.map(faq => ({ ...formatFaq(faq), relevance_score: 0.9 }));
};

// ── Hit tracking ──────────────────────────────────────────────────────────────

/**
 * Fix #16: Increment use_count for a matched FAQ (called by intent router).
 * Best-effort — never throws.
 */
const incrementFaqHit = async (faqId) => {
    FaqResponse.increment('use_count', { where: { id: faqId } }).catch(() => {});
};

// ── Policies ──────────────────────────────────────────────────────────────────

const getShopPolicies = async (userId, shopId) => {
    await verifyShopAccess(userId, shopId);
    const shop = await getShop(shopId);
    const settings = normalizeObject(shop.settings);
    return normalizeObject(settings.policies);
};

// ── Language helpers ──────────────────────────────────────────────────────────

const normalizeLanguage = async (payload) => {
    if (!payload || !payload.text) {
        throw new AppError('Text is required', 400);
    }

    const text = payload.text;

    // Fix #19: Only attempt banglish dictionary lookup when relevant
    if (payload.detected_language !== 'banglish' || payload.target_language !== 'bangla') {
        return {
            original: text,
            normalized: text,
            language: payload.detected_language || 'unknown',
            confidence: 1.0,
            method_used: 'passthrough'
        };
    }

    const tokens = text.split(/\s+/);
    const dictionaryRows = await BanglishDictionary.findAll({
        where: { banglish: { [Op.in]: tokens.map(t => t.toLowerCase()) } }
    });

    const dictionary = new Map(dictionaryRows.map(row => [row.banglish, row.bangla]));
    const normalized = tokens.map(t => dictionary.get(t.toLowerCase()) || t).join(' ');

    return {
        original: text,
        normalized,
        language: 'bangla',
        confidence: 0.85,
        method_used: 'dictionary'
    };
};

const cacheLanguageLearning = async (payload) => {
    if (!payload || !payload.banglish_input || !payload.normalized_output) {
        throw new AppError('banglish_input and normalized_output are required', 400);
    }

    const existing = await BanglishDictionary.findOne({
        where: { banglish: payload.banglish_input.toLowerCase() }
    });

    if (existing) {
        await existing.update({
            bangla: payload.normalized_output,
            confidence: payload.confidence || existing.confidence
        });
        return { cached: true, id: existing.id };
    }

    const entry = await BanglishDictionary.create({
        banglish: payload.banglish_input.toLowerCase(),
        bangla: payload.normalized_output,
        confidence: payload.confidence || 95
    });

    return { cached: true, id: entry.id };
};

// ── Internal knowledge read (for AI/chatbot — no user auth required) ─────────

/**
 * Returns structured shop knowledge for system-prompt building.
 * Called by the AI chatbot pipeline — no JWT user, just shop ID.
 * Uses a separate cache from the merchant-facing read because inactive FAQs
 * must never enter an AI prompt.
 */
const getKnowledgeForAI = async (shopId) => {
    const cached = await cacheService.getForShop(shopId, AI_KNOWLEDGE_CACHE_KEY);
    if (cached) return cached;

    const [shop, faqs] = await Promise.all([
        getShop(shopId),
        FaqResponse.findAll({ where: { shop_id: shopId, is_active: true }, order: [['priority', 'DESC']] })
    ]);

    const settings = normalizeObject(shop.settings);
    const aiSettings = await shopService.getShopAiSettings(shopId).catch(() => ({}));

    const result = {
        businessInfo: normalizeObject(settings.businessInfo),
        brandingRules: normalizeObject(settings.brandingRules),
        faqs: faqs.map(formatFaq),
        documents: normalizeArray(settings.documents),
        ai_settings: aiSettings
    };

    await cacheService.setForShop(shopId, AI_KNOWLEDGE_CACHE_KEY, result, KNOWLEDGE_CACHE_TTL).catch(() => {});
    return result;
};

// ── Lightweight per-query FAQ relevance (for system-prompt cost optimisation) ──

/**
 * Return the top-N FAQs most relevant to the incoming message using SQL token
 * matching (same approach as intent-router Stage 2).  Much cheaper than injecting
 * all 50 FAQs into every system prompt.
 *
 * Falls back to an empty array so callers can degrade gracefully to the full FAQ
 * list when no tokens match.
 *
 * @param {string} shopId
 * @param {string} message  - Customer message text
 * @param {number} [limit=5]
 * @returns {Promise<Array>} Formatted FAQ objects compatible with buildSystemPrompt
 */
const getRelevantFaqs = async (shopId, message, limit = 5) => {
    if (!shopId || !message) return [];

    try {
        const tokens = message
            .toLowerCase()
            .replace(/[^\wঀ-৿\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3)
            .slice(0, 8); // cap to avoid giant queries

        if (tokens.length === 0) return [];

        const conditions = tokens.map(token => ({
            [Op.or]: [
                { category:    { [Op.iLike]: `%${token}%` } },
                { template_en: { [Op.iLike]: `%${token}%` } },
                { template_bn: { [Op.iLike]: `%${token}%` } },
            ]
        }));

        const rows = await FaqResponse.findAll({
            where: { shop_id: shopId, is_active: true, [Op.or]: conditions },
            order:  [['priority', 'DESC'], ['use_count', 'DESC']],
            limit,
        });

        return rows.map(formatFaq);
    } catch (_) {
        return [];
    }
};

// ── RAG query (authenticated) ─────────────────────────────────────────────────

/**
 * Fix #5: shopId always comes from the authenticated context (not request body).
 */
const queryKnowledge = async (shopId, payload) => {
    const result = await ragService.queryData({
        query: payload.query,
        limit: payload.limit || 5,
        shopId
    });
    return result;
};

module.exports = {
    getKnowledge,
    updateBusinessInfo,
    updateBrandingRules,
    listFaqs,
    createFaq,
    updateFaq,
    deleteFaq,
    listGaps,
    listDocuments,
    createDocument,
    deleteDocument,
    searchFaq,
    incrementFaqHit,
    getShopPolicies,
    normalizeLanguage,
    cacheLanguageLearning,
    getKnowledgeForAI,
    getRelevantFaqs,
    queryKnowledge
};
