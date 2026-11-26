'use strict';

/**
 * Knowledge Gap Suggestions (Pilot+ P+05) — turn recurring unanswered
 * questions into merchant-approved, reusable knowledge.
 *
 * Deterministic by design (spec §11.1): normalization + keyword domain
 * classification + frequency thresholds; NO model calls, NO embeddings.
 * Suggestions NEVER auto-publish: publishing goes through the existing
 * knowledge.service.createFaq authority (explicit status:'published' lifecycle
 * write + RAG sync + snapshot invalidation), so an unapproved answer can never
 * reach a customer.
 *
 * Evidence hygiene: only the normalized key, one short display sample and
 * counters are stored. Dismissed suggestions re-open only when at least
 * THRESHOLD genuinely NEW unanswered questions arrived after dismissal
 * (id-cursor), so a dismissed suggestion never "immediately reappears".
 */

const { Op } = require('sequelize');
const { createLogger } = require('../../utils/structured-logger');
const metrics = require('../pilot-features/pilot-metrics');

const logger = createLogger('GapSuggestions');

const WINDOW_DAYS = 14;
const THRESHOLD = 3;
const MAX_ROWS = 2000;

const normalizeQuestion = (text) => String(text || '')
    .toLowerCase()
    .replace(/[।?！!;,:'"“”‘’()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);

const DOMAIN_KEYWORDS = Object.freeze([
    ['PAYMENT', ['bkash', 'বিকাশ', 'nagad', 'নগদ', 'rocket', 'রকেট', 'payment', 'পেমেন্ট', 'advance', 'অ্যাডভান্স', 'trxid', 'trx id', 'ক্যাশ অন', 'cash on delivery', 'cod']],
    ['DELIVERY', ['delivery', 'ডেলিভারি', 'charge', 'চার্জ', 'courier', 'কুরিয়ার', 'shipping', 'area', 'এলাকা', 'ঢাকার বাইরে', 'outside dhaka', 'sending']],
    ['PRODUCT', ['size', 'সাইজ', 'color', 'রঙ', 'fabric', 'কাপড়', 'ওজন', 'weight', 'price', 'দাম', 'dam', 'koto', 'কত', 'variant']],
    ['POLICY', ['exchange', 'এক্সচেঞ্জ', 'return', 'রিটার্ন', 'refund', 'রিফান্ড', 'warranty', 'গ্যারান্টি', 'guarantee', 'change']],
]);

function classifyDomain(normQuestion) {
    const text = normQuestion || '';
    for (const [domain, words] of DOMAIN_KEYWORDS) {
        if (words.some((w) => text.includes(w))) return domain;
    }
    return 'OTHER';
}

const Suggestion = () => require('./gap-suggestion.entity');
const gapModel = () => require('../entities').KnowledgeGap;

async function groupExistingGaps(shopId, now) {
    const KnowledgeGap = gapModel();
    const since = new Date(now - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await KnowledgeGap.findAll({
        where: { shop_id: shopId, created_at: { [Op.gte]: since } },
        attributes: ['id', 'question', 'created_at'],
        order: [['id', 'ASC']],
        limit: MAX_ROWS,
    });
    const groups = new Map();
    for (const r of rows) {
        const norm = normalizeQuestion(r.question);
        if (!norm) continue;
        const g = groups.get(norm) || {
            norm, count: 0, maxId: 0, ids: [],
            firstSeen: r.created_at, lastSeen: r.created_at,
            display: String(r.question || '').trim().slice(0, 280),
        };
        g.count += 1;
        g.ids.push(Number(r.id) || 0);
        g.maxId = Math.max(g.maxId, Number(r.id) || 0);
        if (r.created_at < g.firstSeen) g.firstSeen = r.created_at;
        if (r.created_at > g.lastSeen) g.lastSeen = r.created_at;
        groups.set(norm, g);
    }
    return groups;
}

/**
 * One sweep for a flagged shop: upsert OPEN/IN_REVIEW rows for recurring
 * groups, and re-open DISMISSED rows only on genuinely NEW evidence.
 */
async function computeForShop(shopId, { now = Date.now() } = {}) {
    const Model = Suggestion();
    const groups = await groupExistingGaps(shopId, now);
    const result = { created: 0, updated: 0, reopened: 0 };

    for (const [norm, g] of groups) {
        if (g.count < THRESHOLD) continue;
        const live = await Model.findOne({
            where: { shop_id: shopId, norm_question: norm, status: ['OPEN', 'IN_REVIEW'] },
        });
        if (live) {
            const same = live.evidence_count === g.count && String(live.evidence_cursor) === String(g.maxId);
            if (!same) {
                await live.update({
                    evidence_count: g.count,
                    first_seen_at: g.firstSeen,
                    last_seen_at: g.lastSeen,
                    evidence_cursor: g.maxId,
                    display_question: g.display,
                });
                result.updated += 1;
            }
            continue;
        }
        // Was it dismissed? Re-open only when THIS question gathered at least
        // THRESHOLD genuinely new gap rows past the dismissal cursor — never
        // because unrelated questions were asked elsewhere in the shop.
        const dismissed = await Model.findOne({
            where: { shop_id: shopId, norm_question: norm, status: 'DISMISSED' },
            order: [['dismissed_at', 'DESC']],
        });
        if (dismissed) {
            const cursor = Number(dismissed.evidence_cursor) || 0;
            const newForThisQuestion = g.ids.filter((id) => id > cursor).length;
            if (newForThisQuestion < THRESHOLD) continue;
            await dismissed.update({
                status: 'OPEN',
                evidence_count: g.count,
                first_seen_at: g.firstSeen,
                last_seen_at: g.lastSeen,
                evidence_cursor: g.maxId,
                dismissed_reason: null,
                dismissed_at: null,
                display_question: g.display,
            });
            result.reopened += 1;
            metrics.increment('gap_suggestion.generated');
            continue;
        }
        const ownerDomain = classifyDomain(norm);
        await Model.create({
            shop_id: shopId,
            norm_question: norm,
            display_question: g.display.slice(0, 300),
            owner_domain: ownerDomain,
            status: 'OPEN',
            evidence_count: g.count,
            first_seen_at: g.firstSeen,
            last_seen_at: g.lastSeen,
            evidence_cursor: g.maxId,
        });
        result.created += 1;
        metrics.increment('gap_suggestion.generated');
    }
    return result;
}

async function listOpen(shopId, { limit = 50 } = {}) {
    const Model = Suggestion();
    return Model.findAll({
        where: { shop_id: shopId, status: 'OPEN' },
        order: [['evidence_count', 'DESC'], ['last_seen_at', 'DESC']],
        limit,
    });
}

async function listForShop(shopId, { statuses = ['OPEN', 'IN_REVIEW'], limit = 100 } = {}) {
    const Model = Suggestion();
    const rows = await Model.findAll({
        where: { shop_id: shopId, status: statuses },
        order: [['last_seen_at', 'DESC']],
        limit,
    });
    return rows.map((r) => ({
        id: r.id,
        display_question: r.display_question,
        owner_domain: r.owner_domain,
        status: r.status,
        evidence_count: Number(r.evidence_count) || 0,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
        resolved_faq_id: r.resolved_faq_id || null,
        published_at: r.published_at || null,
        // structured sources keep authority in configuration, not FAQ prose
        authoritative_action: r.owner_domain === 'PAYMENT'
            ? 'open_payment_settings'
            : r.owner_domain === 'DELIVERY'
                ? 'open_delivery_settings'
                : r.owner_domain === 'PRODUCT'
                    ? 'open_product_catalog'
                    : 'author_faq',
    }));
}

async function startReview(shopId, suggestionId) {
    const Model = Suggestion();
    const [updated] = await Model.update(
        { status: 'IN_REVIEW' },
        { where: { id: suggestionId, shop_id: shopId, status: 'OPEN' } },
    );
    return updated === 1;
}

/**
 * Dismiss with reason; records the CURRENT max evidence id as the cursor so
 * only genuinely new unanswered questions can bring it back.
 */
async function dismiss(shopId, suggestionId, reason, actorUserId) {
    const Model = Suggestion();
    const row = await Model.findOne({
        where: { id: suggestionId, shop_id: shopId, status: ['OPEN', 'IN_REVIEW'] },
    });
    if (!row) return false;
    const groups = await groupExistingGaps(shopId, Date.now());
    const g = groups.get(row.norm_question);
    await row.update({
        status: 'DISMISSED',
        dismissed_reason: reason || 'OTHER',
        dismissed_at: new Date(),
        evidence_cursor: g ? g.maxId : row.evidence_cursor,
    });
    metrics.increment('gap_suggestion.dismissed');
    logger.info('gap_suggestion_dismissed', { shopId, suggestionId, actor: actorUserId || null });
    return true;
}

/**
 * Publish a merchant-authored answer through the EXISTING FAQ authority path
 * (createFaq: shop scoping, validation, RAG sync, cache invalidation) and
 * link the suggestion. The bot only ever uses it after activation+indexing,
 * which is exactly createFaq's existing contract.
 */
async function publishAnswer(shopId, actorUserId, suggestionId, faq) {
    const Model = Suggestion();
    const row = await Model.findOne({
        where: { id: suggestionId, shop_id: shopId, status: ['OPEN', 'IN_REVIEW'] },
    });
    if (!row) return null;
    const knowledgeService = require('./knowledge.service');
    // Publish explicitly through the new lifecycle machine: 'published' is the
    // ONLY retrieval-eligible status. The is_active flag is the service's own
    // derived mirror — callers must never pass it. category_tag keeps the
    // domain label; the question stays authoritative (category never overwrites).
    const created = await knowledgeService.createFaq(actorUserId, shopId, {
        question: faq.question,
        answer: faq.answer,
        category_tag: faq.category || undefined,
        status: 'published',
        priority: faq.priority || 50,
    });
    await row.update({
        status: 'PUBLISHED',
        resolved_faq_id: created.id,
        published_at: new Date(),
    });
    metrics.increment('gap_suggestion.published');
    return created;
}

module.exports = {
    normalizeQuestion,
    classifyDomain,
    computeForShop,
    listOpen,
    listForShop,
    startReview,
    dismiss,
    publishAnswer,
    knowledgeGapSuggestions: { listOpen },
    THRESHOLD,
    WINDOW_DAYS,
};
