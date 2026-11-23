/**
 * Product Search Service
 *
 * Searches products using AI-extracted attributes and returns LIVE product
 * data from the DB. This is the grounding layer — ensures the chatbot
 * never hallucinates stale prices, stock, or sizes.
 *
 * Called by: intent-router when customer sends a product image.
 */

const { sequelize } = require('../../utils/database/database-setup');
const { QueryTypes } = require('sequelize');

const PRODUCT_VARIANT_LATERAL_JOIN = `
    LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
            'id', v.id,
            'option_name', v.option_name,
            'option_value', v.option_value,
            'price', v.price,
            'quantity', v.quantity,
            'is_active', v.is_active,
            'attributes', v.attributes
        ) ORDER BY v.option_name, v.option_value) AS product_variants
        FROM product_variants v
        WHERE v.product_id = p.id AND v.is_active = true
    ) product_variant_records ON TRUE`;

/**
 * Builds full-text search query from all available signals
 * @param {Object} params - Search parameters
 * @returns {string} Sanitized tsquery string
 */
const buildSearchQuery = ({ query, category, color, material, tags = [] }) => {
    const searchTerms = [query, category, color, material, ...(tags || [])].filter(Boolean);
    return searchTerms
        .map(t => t.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF\s]/g, '').trim())
        .filter(Boolean)
        .join(' | ');  // OR semantics — match any term
};

/**
 * Checks if search has meaningful attributes
 * @param {string} tsQuery - Built search query
 * @param {string} category - Category filter
 * @param {string} color - Color filter
 * @returns {boolean} True if search has no useful attributes
 */
const hasNoSearchAttributes = (tsQuery, category, color) => !tsQuery && !category && !color;

/**
 * Builds SQL query replacements object
 * @param {Object} params - Search parameters
 * @param {string} tsQuery - Built search query
 * @returns {Object} Query replacements
 */
const buildQueryReplacements = ({ shopId, category, color, material, limit }, tsQuery) => ({
    shopId,
    category: category || '',
    color: color || '',
    material: material || '',
    categoryWild: `%${category || ''}%`,
    colorWild: `%${color || ''}%`,
    materialWild: `%${material || ''}%`,
    tsQuery,
    tsQuerySafe: sanitizeTsQuery(tsQuery),
    limit
});

/**
 * Gets the search SQL query string
 * @returns {string} SQL query
 */
const getSearchSql = () => `
    SELECT
        p.id,
        p.shop_id,
        p.name,
        p.name_bn,
        p.category,
        p.price,
        p.compare_at_price,
        p.quantity,
        p.track_quantity,
        p.in_stock,
        p.is_active,
        p.variants,
        p.images,
        p.image_url,
        p.tags,
        p.aliases,
        p.brand,
        p.description,
        p.ai_description,
        p.ai_tags,
        p.ai_category,
        p.ai_color_primary,
        p.ai_material,
        p.ai_attributes,
        product_variant_records.product_variants,
        -- relevance score
        (
            CASE WHEN p.ai_category ILIKE :category THEN 4 ELSE 0 END +
            CASE WHEN p.ai_color_primary ILIKE :color THEN 3 ELSE 0 END +
            CASE WHEN p.ai_material ILIKE :material THEN 2 ELSE 0 END +
            CASE WHEN :tsQuery != '' THEN
                ts_rank(
                    to_tsvector('english',
                        coalesce(p.name,'') || ' ' ||
                        coalesce(p.name_bn,'') || ' ' ||
                        coalesce(p.ai_search_text,'') || ' ' ||
                        coalesce(p.ai_category,'') || ' ' ||
                        coalesce(p.ai_color_primary,'') || ' ' ||
                        coalesce(p.ai_material,'') || ' ' ||
                        coalesce(p.category,'')
                    ),
                    to_tsquery('english', :tsQuerySafe)
                ) * 10
            ELSE 0 END
        ) AS relevance
    FROM products p
    ${PRODUCT_VARIANT_LATERAL_JOIN}
    WHERE
        p.shop_id = :shopId
        AND p.deleted_at IS NULL
        AND p.is_active = true
        AND (
            -- Each attribute filter MUST be gated on the attribute being present.
            -- An absent filter becomes the wildcard '%%' (see buildQueryReplacements),
            -- and 'anything' ILIKE '%%' is TRUE — so an ungated clause turned this
            -- WHERE into a tautology and every free-text query matched the whole
            -- catalogue. The chatbot then injected 5 arbitrary products as
            -- "RELEVANT SHOP PRODUCTS ... use ONLY these facts", which is exactly
            -- the wrong-price hallucination the grounding block exists to prevent.
            (:category != '' AND p.ai_category ILIKE :categoryWild)
            OR (:color != '' AND p.ai_color_primary ILIKE :colorWild)
            OR (:material != '' AND p.ai_material ILIKE :materialWild)
            OR (:category != '' AND p.category ILIKE :categoryWild)
            OR (
                :tsQuery != '' AND
                to_tsvector('english',
                    coalesce(p.name,'') || ' ' ||
                    coalesce(p.name_bn,'') || ' ' ||
                    coalesce(p.ai_search_text,'') || ' ' ||
                    coalesce(p.ai_category,'') || ' ' ||
                    coalesce(p.ai_color_primary,'') || ' ' ||
                    coalesce(p.ai_material,'') || ' ' ||
                    coalesce(p.category,'')
                ) @@ to_tsquery('english', :tsQuerySafe)
            )
        )
    ORDER BY relevance DESC, p.quantity DESC, p.created_at DESC
    LIMIT :limit
`;

/**
 * Search products for a shop using vision-extracted attributes.
 * Refactored to reduce complexity - orchestration only.
 *
 * @param {object} params
 * @param {string} params.shopId
 * @param {string} [params.category]      - e.g. "saree"
 * @param {string} [params.color]         - e.g. "blue"
 * @param {string} [params.material]      - e.g. "cotton"
 * @param {string} [params.query]         - free-text search query
 * @param {string[]} [params.tags]        - extracted tags
 * @param {number} [params.limit]         - max results (default 5)
 * @returns {Promise<ProductResult[]>}
 */
const searchByAttributes = async (params) => {
    const { shopId, category, color, limit = 5, throwOnError = false } = params;

    const tsQuery = buildSearchQuery(params);

    if (hasNoSearchAttributes(tsQuery, category, color)) {
        return fallbackSearch(shopId, limit, { throwOnError });
    }

    const results = await sequelize.query(
        getSearchSql(),
        {
            replacements: buildQueryReplacements(params, tsQuery),
            type: QueryTypes.SELECT
        }
    ).catch(err => {
        console.error('[ProductSearch] Query error:', err.message);
        if (throwOnError) throw err;
        return [];
    });

    return results.map(formatProduct);
};

/**
 * Get a specific product by ID with live data (for order session validation).
 */
const getProductLive = async (productId, shopId) => {
    const results = await sequelize.query(`
        SELECT p.id, p.shop_id, p.name, p.name_bn, p.price, p.compare_at_price,
               p.quantity, p.track_quantity, p.in_stock, p.is_active, p.variants,
               p.images, p.image_url, p.category, p.aliases, p.ai_category,
               product_variant_records.product_variants
        FROM products p
        ${PRODUCT_VARIANT_LATERAL_JOIN}
        WHERE p.id = :productId AND p.shop_id = :shopId AND p.deleted_at IS NULL
        LIMIT 1
    `, {
        replacements: { productId, shopId },
        type: QueryTypes.SELECT
    });
    return results[0] ? formatProduct(results[0]) : null;
};

const toFiniteNumber = (value) => {
    // null / undefined / empty string are ABSENT (invalid) counts, distinct from a
    // real 0 (sold out). Only a genuine finite number is a valid quantity.
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

/**
 * Resolve a selected variant (by variant id, or size/color option value) inside
 * a live product row. Returns:
 *   { status: 'none' }            — no variant requested → use product level
 *   { status: 'matched', variant }— the requested variant found
 *   { status: 'missing' }         — a variant was requested but the product has
 *                                   no variant data to satisfy it (never guess)
 */
const resolveSelectedVariant = (product, selector) => {
    if (!selector) return { status: 'none' };
    const { variantId, size, color } = selector;
    if (!variantId && !size && !color) return { status: 'none' };
    const variants = Array.isArray(product.variants) ? product.variants : [];
    if (!variants.length) return { status: 'missing' };

    if (variantId) {
        const byId = variants.find((v) => v && v.id != null && String(v.id) === String(variantId));
        if (byId) return { status: 'matched', variant: byId };
        return { status: 'missing' };
    }
    const wanted = [size, color]
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim().toLowerCase());
    const byValue = variants.find((v) => {
        if (!v) return false;
        const value = typeof v.option_value === 'string' ? v.option_value.trim().toLowerCase() : '';
        return value && wanted.includes(value);
    });
    return byValue ? { status: 'matched', variant: byValue } : { status: 'missing' };
};

/**
 * Validate stock for a product before ordering.
 *
 * D-P2-02 (variant authority): when a specific variant is selected (by id or by
 * size/color) the gate is that VARIANT's own finite quantity — the field the
 * grounding layer already prints as per-size availability. Product-level stock is
 * consulted ONLY when no variant is selected. A selected variant that is missing,
 * inactive, or has invalid/insufficient/stale stock fails CLOSED; there is no
 * silent substitution of product-level availability for an out-of-stock size.
 *
 * Returns { available, reason, product?, selectedVariant?, quantity? }.
 */
const checkStock = async (productId, shopId, requestedQty = 1, variantSelector = null) => {
    const product = await getProductLive(productId, shopId);
    if (!product) return { available: false, reason: 'Product not found' };
    if (!product.is_active) return { available: false, reason: 'Product is no longer available' };
    if (!product.in_stock) return { available: false, reason: 'Product is out of stock' };

    const selection = resolveSelectedVariant(product, variantSelector);
    if (selection.status === 'missing') {
        // A concrete option was requested but the live product cannot honour it
        // (unknown / cross-shop / stale-claimed variant id). Do not fall back to
        // product-level stock — that would order a size we never verified.
        return { available: false, reason: 'The selected option is not available for this product', variant_missing: true };
    }

    if (selection.status === 'matched') {
        const variant = selection.variant;
        if (variant.is_active === false) {
            return { available: false, reason: 'The selected option is no longer available', selectedVariant: variant };
        }
        if (product.track_quantity) {
            const vQty = toFiniteNumber(variant.quantity);
            if (vQty === null) {
                // Tracked product with an unresolvable variant quantity → fail closed.
                return { available: false, reason: 'Stock for the selected option is unavailable', selectedVariant: variant, invalid_variant_stock: true };
            }
            if (vQty < requestedQty) {
                return { available: false, reason: `Only ${vQty} unit(s) left in stock`, quantity: vQty, selectedVariant: variant };
            }
            return { available: true, reason: null, product, selectedVariant: variant, quantity: vQty };
        }
        // Not tracked at product level: product.in_stock already gated above.
        return { available: true, reason: null, product, selectedVariant: variant };
    }

    // No variant selected → preserve the original product-level semantics.
    if (product.track_quantity && product.quantity < requestedQty) {
        // Expose the live count so callers can localise "only N left" without re-querying.
        return { available: false, reason: `Only ${product.quantity} unit(s) left in stock`, quantity: product.quantity };
    }
    return { available: true, reason: null, product };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fallbackSearch = async (shopId, limit, { throwOnError = false } = {}) => {
    const results = await sequelize.query(`
        SELECT p.id, p.shop_id, p.name, p.name_bn, p.price, p.compare_at_price,
               p.quantity, p.track_quantity, p.in_stock, p.is_active, p.variants, p.images, p.image_url,
               p.tags, p.aliases, p.brand, p.description, p.ai_description, p.ai_tags,
               p.category, p.ai_category, p.ai_color_primary, p.ai_material, p.ai_attributes,
               product_variant_records.product_variants
        FROM products p
        ${PRODUCT_VARIANT_LATERAL_JOIN}
        WHERE p.shop_id = :shopId AND p.deleted_at IS NULL AND p.is_active = true
        ORDER BY p.quantity DESC, p.created_at DESC
        LIMIT :limit
    `, { replacements: { shopId, limit }, type: QueryTypes.SELECT }).catch(err => {
        console.error('[ProductSearch] Fallback query error:', err.message);
        if (throwOnError) throw err;
        return [];
    });
    return results.map(formatProduct);
};

const formatProduct = (row) => {
    const relationalVariants = parseJson(row.product_variants, []);
    const legacyVariants = parseJson(row.variants, []);
    const price = row.price == null || row.price === '' ? null : Number.parseFloat(row.price);
    return ({
    id:               row.id,
    shop_id:          row.shop_id || null,
    name:             row.name,
    name_bn:          row.name_bn || null,
    category:         row.category || null,
    price:            Number.isFinite(price) ? price : null,
    compare_at_price: row.compare_at_price ? parseFloat(row.compare_at_price) : null,
    quantity:         row.quantity || 0,
    // Only meaningful when the merchant actually counts stock. Defaults to
    // false: a caller that did not select the column must not be allowed to
    // read quantity 0 as "sold out" for a shop that never tracked quantity.
    track_quantity:   row.track_quantity === true,
    in_stock:         row.in_stock !== false,
    is_active:        row.is_active !== false,
    variants:         Array.isArray(relationalVariants) && relationalVariants.length
        ? relationalVariants
        : legacyVariants,
    images:           parseJson(row.images, []),
    image_url:        row.image_url || null,
    tags:             parseJson(row.tags, []),
    aliases:          parseJson(row.aliases, []),
    brand:            row.brand || null,
    description:      row.description || null,
    // AI fields (search-only — do NOT expose prices/stock from here)
    ai_description:   row.ai_description || null,
    ai_tags:          parseJson(row.ai_tags, []),
    ai_color:         row.ai_color_primary || null,
    ai_material:      row.ai_material || null,
    ai_attributes:    parseJson(row.ai_attributes, {})
    });
};

const parseJson = (val, fallback) => {
    if (!val) return fallback;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return fallback; }
};

/**
 * Sanitize a tsquery string to prevent syntax errors.
 * Converts free text to a safe OR tsquery.
 */
const sanitizeTsQuery = (q) => {
    if (!q) return '';
    // Split on spaces/pipes, sanitize each word, join with |
    const words = q.split(/[\s|]+/)
        .map(w => w.replace(/[^a-z0-9\u0980-\u09FF]/g, '').trim())
        .filter(w => w.length >= 2);
    if (!words.length) return '';
    return words.join(' | ');
};

/**
 * Fetch live product records by a list of IDs.
 * Used by the RAG tier to convert vector-store hits (product_id metadata)
 * into full DB records with current price, stock, and variants.
 *
 * @param {string[]} productIds
 * @param {string} shopId
 * @returns {Promise<ProductResult[]>}
 */
const getProductsByIds = async (productIds, shopId, { throwOnError = false } = {}) => {
    if (!productIds.length) return [];
    const results = await sequelize.query(`
        SELECT
            p.id, p.shop_id, p.name, p.name_bn, p.category, p.price, p.compare_at_price,
            p.quantity, p.track_quantity, p.in_stock, p.is_active, p.variants, p.images, p.image_url,
            p.tags, p.aliases, p.brand, p.description, p.ai_description, p.ai_tags,
            p.ai_category, p.ai_color_primary, p.ai_material, p.ai_attributes,
            product_variant_records.product_variants
        FROM products p
        ${PRODUCT_VARIANT_LATERAL_JOIN}
        WHERE p.shop_id = :shopId
          AND p.id IN (:productIds)
          AND p.deleted_at IS NULL
          AND p.is_active = true
        LIMIT 10
    `, {
        replacements: { shopId, productIds },
        type: QueryTypes.SELECT
    }).catch(err => {
        console.error('[ProductSearch] getProductsByIds error:', err.message);
        if (throwOnError) throw err;
        return [];
    });
    return results.map(formatProduct);
};

/**
 * Find products a customer can actually order from a free-text message.
 *
 * Unlike searchByAttributes (which falls back to dumping the whole catalog when
 * the message has no usable search terms), this NEVER falls back — it returns an
 * empty list when the message produced no real full-text query. That distinction
 * matters for the order-capture flow: we must only auto-start an order session
 * when we can confidently identify the product the customer named. Linking an
 * arbitrary fallback product to an order would be worse than asking which item.
 *
 * @param {object} params
 * @param {string} params.shopId
 * @param {string} params.query    - raw customer message
 * @param {number} [params.limit]  - max results (default 5)
 * @returns {Promise<{ products: ProductResult[], wasFallback: boolean }>}
 */
const searchForOrder = async ({ shopId, query, limit = 5 }) => {
    const tsQuery = buildSearchQuery({ query });
    if (hasNoSearchAttributes(tsQuery, null, null)) {
        // No real product terms in the message → don't guess a product.
        return { products: [], wasFallback: true };
    }

    const results = await sequelize.query(
        getSearchSql(),
        {
            replacements: buildQueryReplacements({ shopId, limit }, tsQuery),
            type: QueryTypes.SELECT
        }
    ).catch(err => {
        console.error('[ProductSearch] searchForOrder query error:', err.message);
        return [];
    });

    return { products: results.map(formatProduct), wasFallback: false };
};

module.exports = {
    searchByAttributes,
    searchForOrder,
    getProductsByIds,
    getProductLive,
    checkStock
};
