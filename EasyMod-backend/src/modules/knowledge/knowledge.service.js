const { Shop, UserShop, FaqResponse, BanglishDictionary } = require('../entities');
const shopService = require('../shop/shop.service');
const KnowledgeGap = require('../analytics/knowledge-gap.entity');
const { AppError } = require('../../utils/AppError');
const ragService = require('../rag/rag.service');
const { resolveFaqQuestion } = require('./faq-question');
const cacheService = require('../../utils/cache.service');
const {
    MERCHANT_KNOWLEDGE_CACHE_KEY,
    AI_KNOWLEDGE_CACHE_KEY,
    invalidateShopSettingsCaches,
} = require('../../utils/shop-settings-cache');
const crypto = require('crypto');
// `where` (Sequelize.where static) + literal power the keyword CAST search;
// the search VALUE stays a bound Op.iLike parameter — only the left operand is
// a fixed column expression, so there is no interpolation of user input.
const { Op, fn, col, literal, where: sequelizeWhere } = require('sequelize');

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

// ── FAQ lifecycle (20261126_001) ──────────────────────────────────────────────

const FAQ_STATUSES = Object.freeze(['draft', 'review', 'published', 'disabled', 'archived']);

// Status machine. Same-status transitions are IDEMPOTENT no-ops and always
// allowed. `disabled → published` is the merchant re-enable; `archived →
// disabled` is the ONLY restore target (restore never silently republishes).
const FAQ_STATUS_TRANSITIONS = Object.freeze({
    draft: Object.freeze(['review', 'published', 'archived']),
    review: Object.freeze(['draft', 'published', 'archived']),
    published: Object.freeze(['disabled', 'archived']),
    disabled: Object.freeze(['published', 'archived']),
    archived: Object.freeze(['disabled']),
});

// A row whose status column is missing/unexpected (defensive: legacy fixtures,
// a row read by old projection code) falls back to the is_active mirror —
// which is what the migration backfilled — instead of throwing.
const faqStatusFromRow = (row) => (
    FAQ_STATUSES.includes(row?.status)
        ? row.status
        : (row?.is_active === false ? 'disabled' : 'published')
);

const mirrorIsActive = (status) => status === 'published';

// Eligibility for vectors/retrieval: ONLY published. is_active is also
// required so a rollback-window row written by the OLD image (is_active=false
// with a stale default status) can never leak into knowledge — the mirror
// fails closed while only NEW writers keep status⇔is_active in sync.
const faqEligibleForKnowledge = (row) => (
    faqStatusFromRow(row) === 'published' && row?.is_active !== false
);

const isFaqTransitionAllowed = (from, to) => (
    from === to || (FAQ_STATUS_TRANSITIONS[from] || []).includes(to)
);

// ── Serialization ─────────────────────────────────────────────────────────────

const rowPlain = (row) => (typeof row?.get === 'function' ? row.get({ plain: true }) : { ...(row || {}) });

/**
 * Merchant-facing FAQ serialization (A5 contract §FAQ API).
 * Every serialization exposes: id, question, category_tag, answers {en,bn},
 * keywords, notes, status, is_active (mirror), priority, use_count,
 * created_at, updated_at, sync_status, sync_version, synced_at.
 * `use_count` is REPLIES USED (server-incremented when a reply used the FAQ)
 * — not a retrieval count and not a success metric.
 * The legacy alias block keeps every pre-redesign reader working; the UI is
 * forbidden from rendering `confidence`.
 */
const formatFaq = (faq) => {
    const status = faqStatusFromRow(faq);
    const questionText = resolveFaqQuestion(faq, '');
    return {
        // New shape.
        id: String(faq.id),
        question: questionText,
        category_tag: faq.category_tag ?? null,
        answers: { en: faq.template_en || null, bn: faq.template_bn || null },
        keywords: normalizeArray(faq.keywords),
        notes: faq.internal_notes ?? null,
        status,
        is_active: faq.is_active !== false,
        priority: faq.priority,
        use_count: faq.use_count || 0,
        created_at: faq.created_at,
        // Honest timestamp: NULL means never edited — the UI renders "—".
        // formatFaq MUST NOT fabricate updated_at from created_at.
        updated_at: faq.updated_at ?? null,
        sync_status: faq.sync_status || 'pending',
        sync_version: Number(faq.sync_version) || 0,
        synced_at: faq.synced_at ?? null,

        // Legacy aliases (pre-redesign readers). `category` mirrors `question`.
        answer: faq.template_en || faq.template_bn || '',
        category: faq.category,
        template_bn: faq.template_bn,
        template_en: faq.template_en,
        confidence: 1.0, // legacy alias ONLY — not a product concept; UI must never render it
        source: 'manual',
        active: faq.is_active !== false,
        usageCount: faq.use_count || 0,
        createdAt: faq.created_at,
        updatedAt: faq.updated_at ?? null,
    };
};

/**
 * Customer/AI-facing projection serializer (getKnowledgeForAI, getRelevantFaqs,
 * searchFaq answer surface). keywords and internal notes NEVER cross this
 * boundary — pinned by tests.
 */
const formatFaqProjection = (faq) => {
    const formatted = formatFaq(faq);
    delete formatted.keywords;
    delete formatted.notes;
    return formatted;
};

// ── Index text builders ───────────────────────────────────────────────────────
// Keep buildFaqIndexText / buildBusinessInfoIndexText BYTE-IDENTICAL with the
// copies in index-source.contract.js (the bulk reindex and the incremental
// write path must produce the same embedding text). The drift is pinned by
// __tests__/index-source.contract.test.js — change both together.

const buildFaqIndexText = (faq) => [
    // Mirror-invariant resolution, BYTE-IDENTICAL with index-source.contract.js
    // (shared faq-question.js). keywords/notes are NEVER indexed.
    resolveFaqQuestion(faq, '') ? `Q: ${resolveFaqQuestion(faq, '')}` : null,
    faq.template_bn && `A (BN): ${faq.template_bn}`,
    faq.template_en && `A (EN): ${faq.template_en}`,
].filter(Boolean).join('\n');

const renderPolicyParts = (policy) => {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return [];
    const parts = [];
    if (policy.stance) parts.push(`stance: ${policy.stance}`);
    if (Number.isInteger(policy.period_days)) parts.push(`window: ${policy.period_days} days`);
    if (typeof policy.details === 'string' && policy.details.trim()) parts.push(`conditions: ${policy.details.trim()}`);
    if (typeof policy.exclusions === 'string' && policy.exclusions.trim()) parts.push(`exclusions: ${policy.exclusions.trim()}`);
    if (typeof policy.process === 'string' && policy.process.trim()) parts.push(`process: ${policy.process.trim()}`);
    if (typeof policy.duration === 'string' && policy.duration.trim()) parts.push(`duration: ${policy.duration.trim()}`);
    if (typeof policy.coverage === 'string' && policy.coverage.trim()) parts.push(`coverage: ${policy.coverage.trim()}`);
    if (typeof policy.coverage_exclusions === 'string' && policy.coverage_exclusions.trim()) {
        parts.push(`coverage exclusions: ${policy.coverage_exclusions.trim()}`);
    }
    return parts;
};

// POLICIES ARE INFORMATIONAL ONLY: this text (and the settings.policies JSON)
// must never be read by order-cancel/refund/exchange/warranty enforcement code
// paths. Zero automation coupling — pinned by
// src/security/__tests__/business-policies-informational-only.test.js.
const buildBusinessInfoIndexText = (businessInfo = {}, policies = null) => {
    const info = normalizeObject(businessInfo);
    const source = normalizeObject(policies);
    const returnsParts = renderPolicyParts(source.returns);
    // description slot composition (documented by the contract test):
    // tagline + additionalInfo joined coherently; both also keep their own
    // labelled lines for continuity with existing readers.
    const composedDescription = [info.tagline, info.additionalInfo]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim())
        .join(' | ');
    return [
        info.shopName && `Shop name: ${info.shopName}`,
        info.nameEn && `English shop name: ${info.nameEn}`,
        info.tagline && `Tagline: ${info.tagline}`,
        info.email && `Email: ${info.email}`,
        info.city && `City: ${info.city}`,
        composedDescription && `Description: ${composedDescription}`,
        info.address && `Address: ${info.address}`,
        info.phone && `Phone: ${info.phone}`,
        (info.openingHours || info.businessHours) && `Business hours: ${info.openingHours || info.businessHours}`,
        info.additionalInfo && `Additional shop owner info: ${info.additionalInfo}`,
        ...Object.entries(normalizeObject(info.socialLinks))
            .filter(([, value]) => typeof value === 'string' && value.trim())
            .map(([key, value]) => `${key}: ${value.trim()}`),
        // The reserved returnPolicy slot: an explicit businessInfo.returnPolicy
        // keeps precedence; otherwise the merchant-stated returns policy fills
        // it. Absent both means the merchant never stated a return policy.
        (info.returnPolicy || returnsParts.length)
            && `Return policy: ${info.returnPolicy || returnsParts.join('; ')}`,
        info.deliveryPolicy && `Delivery policy: ${info.deliveryPolicy}`,
        ...['exchange', 'refunds', 'warranty'].flatMap((kind) => {
            const parts = renderPolicyParts(source[kind]);
            return parts.length ? [`Business policy (${kind}): ${parts.join('; ')}`] : [];
        }),
    ].filter(Boolean).join('\n');
};

// ── FAQ RAG sync lifecycle ────────────────────────────────────────────────────
// Save = row write commits first; the response means SAVED, never
// SYNCHRONIZED. Each save sets sync_status='pending' and bumps sync_version;
// the async sync below settles to 'synced' (with synced_at) or 'failed'
// (visible, retryable via resync). It NEVER blocks the response and NEVER
// throws to the caller. The Qdrant point payload carries faq_version so a
// stale async sync is refused (rag.service version guard), and every status
// write below uses a sync_version CAS so an old completion cannot settle a
// newer save.

const settleFaqSync = async (faqId, version, patch) => {
    try {
        await FaqResponse.update(patch, { where: { id: faqId, sync_version: version } });
    } catch (_) {
        // Sync bookkeeping must never throw into a fire-and-forget chain.
    }
};

const syncFaqRagIndex = async (shopId, faq) => {
    if (!faq?.id) return;

    const documentId = `faq-${faq.id}`;
    const version = Number(faq.sync_version) || 0;
    const eligible = faqEligibleForKnowledge(faq);
    const text = eligible ? buildFaqIndexText(faq) : '';

    if (!eligible || !text) {
        // Stale-snapshot guard (A9): a queued sync for an OLD ineligible
        // snapshot must never delete a point that a NEWER save has already
        // republished — the newer save's own sync owns the point from then on.
        try {
            const fresh = await FaqResponse.findByPk(faq.id);
            if (fresh && faqEligibleForKnowledge(rowPlain(fresh))) return;
        } catch (_) {
            // Re-read failed: fall through; the CAS settle below still cannot
            // clobber a newer row, and rag's version guard covers the ingest
            // side of the race.
        }
        // Out of published (draft/review/disabled/archived or empty text):
        // the point must be REMOVED; the removal itself settles the sync.
        try {
            await ragService.deletePoint(documentId, shopId);
            await settleFaqSync(faq.id, version, { sync_status: 'synced', synced_at: new Date() });
        } catch (error) {
            console.warn('FAQ RAG delete skipped', {
                faqId: faq.id,
                errorCode: safeErrorCode(error, 'FAQ_RAG_DELETE_FAILED'),
            });
            await settleFaqSync(faq.id, version, { sync_status: 'failed' });
        }
        return;
    }

    const result = await ragService.ingestData({
        text,
        metadata: {
            documentId,
            shopId,
            type: 'faq',
            faq_id: faq.id,
            faq_version: version,
        },
    }).catch((error) => ({ success: false, errorCode: safeErrorCode(error, 'FAQ_RAG_SYNC_FAILED') }));

    if (result?.success) {
        await settleFaqSync(faq.id, version, { sync_status: 'synced', synced_at: new Date() });
    } else if (result?.guarded) {
        // rag.service version guard: a NEWER save's content already owns the
        // point and its own async settles the status. This stale completion
        // must not overwrite it (not synced, not failed — leave the newer
        // pending state alone).
    } else {
        console.warn('FAQ RAG sync skipped', {
            faqId: faq.id,
            errorCode: safeErrorCode({ code: result?.errorCode || result?.message }, 'FAQ_RAG_SYNC_FAILED'),
        });
        await settleFaqSync(faq.id, version, { sync_status: 'failed' });
    }
};

const queueFaqSync = (shopId, plainRow) => {
    // Fire-and-forget contract: never awaited by a request handler, never
    // throws to the caller. The sync starts on the current tick's microtask
    // queue so it settles without delaying the HTTP response.
    Promise.resolve().then(() => syncFaqRagIndex(shopId, plainRow)).catch((error) => {
        console.warn('FAQ RAG sync skipped', {
            faqId: plainRow?.id,
            errorCode: safeErrorCode(error, 'FAQ_RAG_SYNC_FAILED'),
        });
    });
};

const syncBusinessInfoRagIndex = async (shopId, businessInfo, policies = null) => {
    const documentId = `biz-${shopId}`;
    await ragService.deletePoint(documentId, shopId).catch(() => {});

    const text = buildBusinessInfoIndexText(businessInfo || {}, policies);
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
        // Merchant list returns ALL statuses (per-status counts derive from
        // the `status` field); gap stats are served by listGaps separately.
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
    // null-safe text: explicit null clears to '' (String(null) would otherwise
    // persist the literal text "null" and leak it into prompts/indexes).
    const textOrNull = (value, fallback) => (
        value === undefined ? fallback
            : value === null ? ''
                : String(value).trim()
    );
    let businessInfo;
    let policiesSnapshot;
    await shopService.updateShopSettingsPreservingRtoConsent(shopId, (settings) => {
        const existing = normalizeObject(settings.businessInfo);

        // Merge incoming data onto fresh values; partial saves must not restore stale settings.
        businessInfo = {
            ...existing,
            shopName:       data.shopName       !== undefined ? String(data.shopName).trim()       : existing.shopName       || '',
            // nameEn is DISPLAY metadata — shopName remains THE authoritative
            // identity (the single-shop-name sync contract above is unchanged;
            // nameEn never touches shops.shop_name).
            nameEn:         textOrNull(data.nameEn, existing.nameEn || ''),
            tagline:        textOrNull(data.tagline, existing.tagline || ''),
            // Customer-facing contact address ONLY — never login identity,
            // zero auth coupling.
            email:          textOrNull(data.email, existing.email || ''),
            city:           textOrNull(data.city, existing.city || ''),
            address:        data.address        !== undefined ? String(data.address).trim()        : existing.address        || '',
            phone:          data.phone          !== undefined ? String(data.phone).trim()          : existing.phone          || '',
            openingHours:   data.openingHours   !== undefined ? String(data.openingHours).trim()   : existing.openingHours   || '',
            additionalInfo: data.additionalInfo !== undefined ? String(data.additionalInfo).trim() : existing.additionalInfo || '',
            deliveryAreas:  data.deliveryAreas  !== undefined ? normalizeArray(data.deliveryAreas)  : normalizeArray(existing.deliveryAreas),
            paymentMethods: data.paymentMethods !== undefined ? normalizeArray(data.paymentMethods) : normalizeArray(existing.paymentMethods),
            // Social links surfaced in the order-confirmation closing (ai-messaging.renderSocialLinks).
            socialLinks:    data.socialLinks    !== undefined ? normalizeObject(data.socialLinks)    : normalizeObject(existing.socialLinks),
        };
        policiesSnapshot = normalizeObject(settings.policies);
        return { businessInfo };
    }, shopUpdates);
    await syncBusinessInfoRagIndex(shopId, businessInfo, policiesSnapshot);

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

// Phase 1 P03/D3 (upgraded by the A5 redesign): `question` is now the
// authoritative column; `category` only MIRRORS it in new writes, and the
// label lives in `category_tag`. Incoming question beats an incoming
// category alias (legacy clients put the question in `category`), and a
// category update can never overwrite the stored question — structurally.
const faqQuestionText = (input) => String(input.question || input.category || '').trim() || 'General';
// (CREATE keeps this question-first payload alias. ROW reads and updateFaq use
// faq-question.resolveFaqQuestion for the rollback-window mirror invariant.)

const faqAnswerSlots = (input) => {
    // answer_en/template_en/explicit answer → EN slot; answer_bn/template_bn
    // → BN slot. The legacy `answer` aliases the EN slot only when no EN slot
    // value came, and NEVER touches BN — bn data cannot be lost.
    const en = input.answer_en ?? input.template_en ?? input.answer;
    const bn = input.answer_bn ?? input.template_bn;
    return { en, bn };
};

const faqInitialStatus = (faq) => {
    if (FAQ_STATUSES.includes(faq.status)) return faq.status;
    if (faq.active === false) return 'disabled';
    return 'published';
};

const createFaq = async (userId, shopId, faq) => {
    await verifyShopAccess(userId, shopId);
    const question = faqQuestionText(faq);
    const status = faqInitialStatus(faq);
    const { en, bn } = faqAnswerSlots(faq);
    // ACCEPTED-BUT-DISCARDED legacy fields: `confidence` (not a product
    // concept), `source` (derived: 'manual'), `usageCount` (server-owned —
    // use_count increments only when a reply actually used the FAQ).
    const newFaq = await FaqResponse.create({
        shop_id: shopId,
        // Dual-read mirror: category:=question AND question:=question, with
        // the optional tag in its own column.
        question,
        category: question,
        category_tag: faq.category_tag !== undefined && faq.category_tag !== null && String(faq.category_tag).trim()
            ? String(faq.category_tag).trim() : null,
        template_bn: bn ?? null,
        template_en: en ?? null,
        variables: faq.variables || [],
        priority: faq.priority || 0,
        keywords: faq.keywords !== undefined ? normalizeArray(faq.keywords) : null,
        internal_notes: faq.notes !== undefined && faq.notes !== null && String(faq.notes).trim()
            ? String(faq.notes).trim() : null,
        status,
        is_active: mirrorIsActive(status),
        use_count: 0,
        updated_at: new Date(),
        sync_status: 'pending',
        sync_version: 1,
    });

    const saved = rowPlain(newFaq);
    queueFaqSync(shopId, saved);
    await invalidateShopKnowledgeCaches(shopId);

    return formatFaq(saved);
};

const updateFaq = async (userId, shopId, faqId, updates) => {
    await verifyShopAccess(userId, shopId);
    const faq = await FaqResponse.findOne({ where: { id: faqId, shop_id: shopId } });
    if (!faq) throw new AppError('FAQ not found', 404);
    const current = rowPlain(faq);

    // question authoritative (see faqQuestionText): explicit question wins,
    // legacy category alias only when no question came, otherwise the stored
    // question (not the stale category) survives.
    // PATCH semantics (A9 M3): a legacy `category` field alone NEVER changes
    // the question — that was the original bug shape (and the contract says
    // category can never overwrite question). Question edits must send
    // `question`. With no question in the patch, the stored (drift-resolved)
    // question survives.
    const question = updates.question !== undefined
        ? String(updates.question).trim() || 'General'
        : resolveFaqQuestion(current);

    const en = updates.answer_en ?? updates.template_en ?? updates.answer;
    const bn = updates.answer_bn ?? updates.template_bn;
    const templateEn = en !== undefined ? en : current.template_en;
    const templateBn = bn !== undefined ? bn : current.template_bn;

    // Status machine: explicit status, then legacy `active` alias
    // (true→published, false→disabled). Same-status is an allowed no-op.
    const currentStatus = faqStatusFromRow(current);
    let nextStatus = currentStatus;
    if (updates.status !== undefined) nextStatus = updates.status;
    else if (updates.active !== undefined) nextStatus = updates.active ? 'published' : 'disabled';
    if (!FAQ_STATUSES.includes(nextStatus)) {
        throw new AppError(`Invalid FAQ status: ${nextStatus}`, 400, 'VALIDATION_ERROR');
    }
    if (!isFaqTransitionAllowed(currentStatus, nextStatus)) {
        throw new AppError(
            `FAQ status cannot change from ${currentStatus} to ${nextStatus}`,
            409,
            'INVALID_STATUS_TRANSITION',
            { from: currentStatus, to: nextStatus, allowed: FAQ_STATUS_TRANSITIONS[currentStatus] },
        );
    }

    const wasEligible = faqEligibleForKnowledge(current);
    const nextValues = {
        question,
        // Mirror write: category keeps equal to question for every old reader.
        category: question,
        category_tag: updates.category_tag !== undefined
            ? (updates.category_tag === null || !String(updates.category_tag).trim() ? null : String(updates.category_tag).trim())
            : (current.category_tag ?? null),
        template_en: templateEn,
        template_bn: templateBn,
        variables: updates.variables !== undefined ? updates.variables : current.variables,
        priority: updates.priority !== undefined ? updates.priority : current.priority,
        keywords: updates.keywords !== undefined ? normalizeArray(updates.keywords) : (current.keywords ?? null),
        internal_notes: updates.notes !== undefined
            ? (updates.notes === null || !String(updates.notes).trim() ? null : String(updates.notes).trim())
            : (current.internal_notes ?? null),
        status: nextStatus,
        // Mirror consistency: published ⇔ is_active true — EVERY transition.
        is_active: mirrorIsActive(nextStatus),
        // Honest edit stamp: writers bump explicitly (never fabricated reads).
        updated_at: new Date(),
        sync_status: 'pending',
        sync_version: (Number(current.sync_version) || 0) + 1,
    };

    // Transitions OUT of published delete the vector point IMMEDIATELY
    // (customer safety: an ineligible FAQ must never stay retrievable while
    // the async settle runs). The async below re-deletes idempotently.
    if (wasEligible && !faqEligibleForKnowledge(nextValues)) {
        await ragService.deletePoint(`faq-${faqId}`, shopId).catch(() => {});
    }

    await faq.update(nextValues);
    const saved = { ...rowPlain(faq), ...nextValues };

    queueFaqSync(shopId, saved);
    await invalidateShopKnowledgeCaches(shopId);

    return formatFaq(saved);
};

// POST /faqs/:id/archive — any state (except archived itself, idempotent)
// archives; an archived FAQ is removed from knowledge (published→archived
// deletes the point).
const archiveFaq = async (userId, shopId, faqId) => updateFaq(userId, shopId, faqId, { status: 'archived' });

// POST /faqs/:id/restore — restore means ONLY 'archived → disabled'
// (re-enabling is a deliberate published transition; we store nothing extra
// about the pre-archive state, so we restore to the disabled target).
// Already-disabled restores are idempotent no-ops without version churn.
const restoreFaq = async (userId, shopId, faqId) => {
    await verifyShopAccess(userId, shopId);
    const faq = await FaqResponse.findOne({ where: { id: faqId, shop_id: shopId } });
    if (!faq) throw new AppError('FAQ not found', 404);
    const currentStatus = faqStatusFromRow(rowPlain(faq));
    if (currentStatus === 'disabled') return formatFaq(rowPlain(faq));
    if (currentStatus !== 'archived') {
        throw new AppError(
            'Only archived FAQs can be restored',
            409,
            'INVALID_STATUS_TRANSITION',
            { from: currentStatus, to: 'disabled', reason: 'restore applies to archived FAQs only' },
        );
    }
    return updateFaq(userId, shopId, faqId, { status: 'disabled' });
};

// POST /faqs/:id/resync — owner. Sets pending + version++ + re-fires the
// async sync, returns the fresh row. Idempotent on repeat: each call bumps
// the version and re-converges the point; a published row's upsert onto the
// same scoped documentId cannot duplicate points. NOT a content edit —
// updated_at must stay honest, so only sync columns move here.
const resyncFaq = async (userId, shopId, faqId) => {
    await verifyShopAccess(userId, shopId);
    const faq = await FaqResponse.findOne({ where: { id: faqId, shop_id: shopId } });
    if (!faq) throw new AppError('FAQ not found', 404);
    const current = rowPlain(faq);
    const nextVersion = (Number(current.sync_version) || 0) + 1;
    const nextValues = { sync_status: 'pending', sync_version: nextVersion };

    await faq.update(nextValues);
    const saved = { ...current, ...nextValues };

    queueFaqSync(shopId, saved);
    await invalidateShopKnowledgeCaches(shopId);

    return formatFaq(saved);
};

const deleteFaq = async (userId, shopId, faqId) => {
    await verifyShopAccess(userId, shopId);
    await FaqResponse.destroy({ where: { id: faqId, shop_id: shopId } });
    // Hard delete removes the vector point too (scoped, ownership-checked).
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

/**
 * Merchant FAQ search. Published-only (customer-facing eligibility), over
 * question/category/templates/keywords — internal_notes are NEVER searched
 * and NEVER surfaced (the results carry formatFaqProjection).
 */
const searchFaq = async (userId, shopId, payload) => {
    await verifyShopAccess(userId, shopId);

    const query = payload.query || payload.category || '';
    const whereClause = { shop_id: shopId, is_active: true, status: 'published' };
    if (payload.category_tag) whereClause.category_tag = payload.category_tag;
    else if (payload.category) whereClause.category = payload.category; // legacy: category mirrors the question text
    if (query) {
        const like = `%${query}%`;
        whereClause[Op.or] = [
            { question:     { [Op.iLike]: like } },
            { category:     { [Op.iLike]: like } },
            { template_en:  { [Op.iLike]: like } },
            { template_bn:  { [Op.iLike]: like } },
            // keywords (JSON) are searchable via a CAST comparison whose LEFT
            // side is a fixed column expression; the pattern stays bound.
            // internal_notes is deliberately absent from this list.
            sequelizeWhere(literal('CAST("keywords" AS TEXT)'), Op.iLike, like),
        ];
    }

    const faqs = await FaqResponse.findAll({
        where: whereClause,
        order: [['priority', 'DESC'], ['use_count', 'DESC']],
        limit: payload.limit || 10
    });
    return faqs.map(faq => ({ ...formatFaqProjection(faq), relevance_score: 0.9 }));
};

// ── Hit tracking ──────────────────────────────────────────────────────────────

/**
 * Fix #16: Increment use_count for a matched FAQ (called by intent router).
 * Best-effort — never throws. use_count counts REPLIES USED — it is NOT a
 * retrieval count and never touches updated_at (honest edit timestamp).
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
 * must never enter an AI prompt. Only status='published' FAQs qualify (the
 * eligibility helper), serialized WITHOUT keywords/notes, and the merchant's
 * stated business policies (customer-facing facts only) accompany the summary.
 */
const getKnowledgeForAI = async (shopId) => {
    const cached = await cacheService.getForShop(shopId, AI_KNOWLEDGE_CACHE_KEY);
    if (cached) return cached;

    const [shop, faqs] = await Promise.all([
        getShop(shopId),
        FaqResponse.findAll({
            where: { shop_id: shopId, is_active: true, status: 'published' },
            order: [['priority', 'DESC']]
        })
    ]);

    const settings = normalizeObject(shop.settings);
    const aiSettings = await shopService.getShopAiSettings(shopId).catch(() => ({}));

    const result = {
        businessInfo: normalizeObject(settings.businessInfo),
        brandingRules: normalizeObject(settings.brandingRules),
        faqs: faqs.map(formatFaqProjection),
        documents: normalizeArray(settings.documents),
        // Informational facts only; ABSENT policies mean "the merchant never
        // stated one" — never an empty object, never 'not_offered'.
        policies: normalizeObject(settings.policies),
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
 * Published-only (eligibility), matched over question/category/templates only
 * (keywords are merchant search hints, notes are private), serialized with
 * formatFaqProjection.
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
                { question:    { [Op.iLike]: `%${token}%` } },
                { category:    { [Op.iLike]: `%${token}%` } },
                { template_en: { [Op.iLike]: `%${token}%` } },
                { template_bn: { [Op.iLike]: `%${token}%` } },
            ]
        }));

        const rows = await FaqResponse.findAll({
            where: { shop_id: shopId, is_active: true, status: 'published', [Op.or]: conditions },
            order:  [['priority', 'DESC'], ['use_count', 'DESC']],
            limit,
        });

        return rows.map(formatFaqProjection);
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
    archiveFaq,
    restoreFaq,
    resyncFaq,
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
    queryKnowledge,
    // FAQ lifecycle contract (used by tests + gap-suggestions publish).
    FAQ_STATUSES,
    FAQ_STATUS_TRANSITIONS,
    faqStatusFromRow,
    faqEligibleForKnowledge,
    mirrorIsActive,
    formatFaq,
    formatFaqProjection,
    settleFaqSync,
    resolveFaqQuestion,
    syncFaqRagIndex,
    // Index text builders (kept in lockstep with index-source.contract.js).
    buildFaqIndexText,
    buildBusinessInfoIndexText,
    syncBusinessInfoRagIndex,
};
