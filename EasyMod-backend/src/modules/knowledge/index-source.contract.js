'use strict';

const { buildEmbeddingText } = require('../product/product-embedding-text');

// These are PostgreSQL source relations. The Qdrant collection name is
// deliberately absent: a vector-store identifier is not a database table.
const SOURCE_TABLES = Object.freeze(['shops', 'faq_responses', 'products']);

const SOURCE_COUNT_RULE =
    'one row per non-empty business-info source, published active FAQ, or active product selected by reindex:qdrant; products are capped at 200 per shop';

// Keep the selection SQL in one place. The reindex job and the proof runner
// both consume this module so the source-count contract cannot drift.
const SOURCE_QUERIES = Object.freeze({
    requiredRelations: `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name
    `,
    activeShops: `
        SELECT id, settings
        FROM shops
        WHERE is_active = true OR is_active IS NULL
        ORDER BY id
    `,
    shopById: `
        SELECT id, settings
        FROM shops
        WHERE id = $1
    `,
    // Eligible FAQ rows only: status='published' AND the is_active mirror
    // (20261126_001 lifecycle). sync_version feeds the point payload
    // faq_version so the bulk path participates in the stale-clobber guard;
    // keywords/internal_notes are deliberately NOT selected — they must never
    // reach index text (pinned by the drift test against
    // knowledge.service.buildFaqIndexText).
    activeFaqs: `
        SELECT id, shop_id, question, category, template_bn, template_en, sync_version
        FROM faq_responses
        WHERE shop_id = $1 AND is_active = true AND status = 'published'
        ORDER BY priority DESC, id
    `,
    activeProducts: `
        SELECT id, shop_id, name, name_bn, category, description, variants, tags,
               ai_description, ai_tags, ai_category, ai_color_primary,
               ai_material, ai_attributes, image_url, sku
        FROM products
        WHERE shop_id = $1 AND is_active = true
        ORDER BY id
        LIMIT 200
    `,
});

const readRows = async (query, sql, values = []) => {
    const result = await query(sql, values);
    if (Array.isArray(result)) return result[0] || [];
    if (Array.isArray(result?.rows)) return result.rows;
    throw new Error('PostgreSQL source query returned no row set');
};

const objectValue = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }
    return {};
};

// IMPORTANT: these two builders must stay BYTE-IDENTICAL in output to the
// same-named builders in knowledge.service.js (the incremental write path and
// the bulk reindex cannot diverge into two embedding spaces). The drift
// detector is __tests__/index-source.contract.test.js — extend it whenever
// either builder changes.
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

const buildBusinessInfoIndexText = (businessInfo = {}, policies = null) => {
    const info = objectValue(businessInfo);
    const source = objectValue(policies);
    const returnsParts = renderPolicyParts(source.returns);
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
        (info.openingHours || info.businessHours)
            && `Business hours: ${info.openingHours || info.businessHours}`,
        info.additionalInfo && `Additional shop owner info: ${info.additionalInfo}`,
        ...Object.entries(objectValue(info.socialLinks))
            .filter(([, value]) => typeof value === 'string' && value.trim())
            .map(([key, value]) => `${key}: ${value.trim()}`),
        (info.returnPolicy || returnsParts.length)
            && `Return policy: ${info.returnPolicy || returnsParts.join('; ')}`,
        info.deliveryPolicy && `Delivery policy: ${info.deliveryPolicy}`,
        ...['exchange', 'refunds', 'warranty'].flatMap((kind) => {
            const parts = renderPolicyParts(source[kind]);
            return parts.length ? [`Business policy (${kind}): ${parts.join('; ')}`] : [];
        }),
    ].filter(Boolean).join('\n');
};

const buildFaqIndexText = (faq = {}) => [
    // question||category preference; keywords/notes are NEVER indexed text.
    (faq.question || faq.category) ? `Q: ${faq.question || faq.category}` : null,
    faq.template_bn && `A (BN): ${faq.template_bn}`,
    faq.template_en && `A (EN): ${faq.template_en}`,
].filter(Boolean).join('\n');

const assertRequiredSourceRelations = async (query) => {
    const rows = await readRows(query, SOURCE_QUERIES.requiredRelations, [SOURCE_TABLES]);
    const present = new Set(rows.map((row) => row.table_name));
    const missing = SOURCE_TABLES.filter((table) => !present.has(table));
    if (missing.length) {
        throw new Error(`missing PostgreSQL source relation(s): ${missing.join(', ')}`);
    }
    return true;
};

const getActiveShopRows = (query) => readRows(query, SOURCE_QUERIES.activeShops);

const collectShopSources = async (query, shopId, existingShop = null) => {
    const shop = existingShop || (await readRows(query, SOURCE_QUERIES.shopById, [shopId]))[0];
    const sources = [];

    const shopSettings = objectValue(shop?.settings);
    const businessInfo = shopSettings.businessInfo;
    const policies = shopSettings.policies;
    const businessText = buildBusinessInfoIndexText(objectValue(businessInfo), objectValue(policies));
    if (businessText.trim().length >= 5) {
        sources.push({
            kind: 'business_info',
            id: shopId,
            shopId,
            text: businessText,
            metadata: {
                type: 'business_info',
                documentId: `biz-${shopId}`,
                embeddingTitle: 'Business information',
            },
        });
    }

    const faqs = await readRows(query, SOURCE_QUERIES.activeFaqs, [shopId]);
    for (const faq of faqs) {
        const text = buildFaqIndexText(faq);
        if (text.trim().length < 5) continue;
        sources.push({
            kind: 'faq',
            id: faq.id,
            shopId,
            text,
            metadata: {
                type: 'faq',
                documentId: `faq-${faq.id}`,
                faq_id: faq.id,
                // sync_version rides into the point payload as faq_version so
                // the bulk path participates in the stale-clobber guard and
                // keeps the payload schema consistent with the incremental
                // write path (rag.service version guard compares it).
                faq_version: Number.isSafeInteger(faq.sync_version) ? faq.sync_version : 0,
                embeddingTitle: faq.question || faq.category || 'FAQ',
            },
        });
    }

    const products = await readRows(query, SOURCE_QUERIES.activeProducts, [shopId]);
    for (const product of products) {
        const text = buildEmbeddingText(product);
        if (text.trim().length < 5) continue;
        sources.push({
            kind: 'product',
            id: product.id,
            shopId,
            text,
            metadata: {
                type: 'product',
                documentId: `product:${product.id}`,
                product_id: product.id,
                product_name: product.name,
                embeddingTitle: product.name || 'Product',
                image_url: product.image_url || null,
                stock_key: `stock:${shopId}:${product.id}`,
            },
        });
    }

    // Custom document writes persist only metadata in shops.settings.documents;
    // their text is not reconstructible by the bulk reindex path. Do not use the
    // Qdrant collection name as a fallback PostgreSQL table.
    return sources;
};

const collectSourceStats = async (query) => {
    await assertRequiredSourceRelations(query);
    const shops = await getActiveShopRows(query);
    const sources = [];
    for (const shop of shops) {
        sources.push(...await collectShopSources(query, shop.id, shop));
    }
    if (!sources.length) throw new Error('no indexable PostgreSQL sources found');

    return {
        count: sources.length,
        shopIds: [...new Set(sources.map((source) => String(source.shopId)).filter(Boolean))],
        snippets: sources.map((source) => source.text).filter((text) => text && text.trim()),
        sourceRecords: sources.map((source) => ({
            sourceId: String(source.metadata?.documentId || source.id),
            sourceType: source.metadata?.type || source.kind,
            shopId: String(source.shopId),
            text: source.text,
        })),
    };
};

module.exports = {
    SOURCE_TABLES,
    SOURCE_COUNT_RULE,
    SOURCE_QUERIES,
    assertRequiredSourceRelations,
    getActiveShopRows,
    collectShopSources,
    collectSourceStats,
    buildBusinessInfoIndexText,
    buildFaqIndexText,
    // Shared policy rendering — the system prompt uses the SAME field
    // vocabulary as the index text (drift pinned by the contract test).
    renderPolicyParts,
};
