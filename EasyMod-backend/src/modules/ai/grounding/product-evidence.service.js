'use strict';

/**
 * Product evidence — turns retrieval output into VERIFIED PRODUCT ENTITIES.
 *
 * The production incident came from treating a SEARCH CANDIDATE as proof that a
 * product exists. product-search runs an OR-semantics tsquery, so "chiffon saree
 * ache?" happily returns every saree in the catalog; those rows were then handed
 * to the model under the header "use ONLY these facts", and the model concluded
 * the shop sells chiffon sarees.
 *
 * The rule here is conjunctive, not statistical: a candidate is VERIFIED only
 * when EVERY product-identifying term the customer supplied is present in that
 * product's structured catalog fields. "black saree" verifies against
 * "Premium Black Saree"; "chiffon saree" does not. There is no tuned similarity
 * threshold to drift, and the evidence records exactly which terms matched.
 *
 * Shop isolation: every row here comes from a query already scoped by shop_id
 * (product-search.service), and resolveProductMedia re-asserts ownership before
 * a URL can leave this module.
 */

const {
    ProductEvidenceStatus,
    FactState,
    MediaStatus,
    emptyEvidence,
    withSourceText,
} = require('./grounding.contract');
const { withEvidenceSnapshot } = require('../contracts/evidence.contract');
const { getOrigins } = require('../../../config/origins');

/**
 * Terms that express *intent*, not product identity. Removing them is what
 * makes conjunctive matching usable: "ei black saree ta ache?" identifies a
 * product by {black, saree}, not by {ei, ta, ache}. Anything left after this
 * filter is treated as a claim about the product and must be satisfied.
 */
const INTENT_STOPWORDS = new Set([
    // English question/intent words
    'a', 'an', 'the', 'is', 'are', 'do', 'does', 'you', 'your', 'we', 'i', 'me', 'my',
    'have', 'has', 'any', 'this', 'that', 'it', 'its', 'in', 'of', 'for', 'to', 'and',
    'or', 'with', 'what', 'which', 'how', 'much', 'many', 'price', 'cost', 'stock',
    'available', 'availability', 'buy', 'order', 'purchase', 'want', 'need', 'looking',
    'show', 'send', 'give', 'please', 'picture', 'pictures', 'photo', 'photos', 'pic',
    'pics', 'image', 'images', 'there', 'got', 'can', 'could', 'would', 'will', 'be',
    'tell', 'about', 'describe', 'detail', 'details', 'info', 'information', 'more',
    'ok', 'okay', 'yes', 'no', 'sure', 'again', 'check', 'try', 'really', 'still',
    'delivery', 'shipping', 'discount', 'offer', 'product', 'products', 'item', 'items',
    // Attribute NAMES. Asking "what colour is it?" names the question, not the
    // product — "panjabi er color ki?" identifies a panjabi, not a "color".
    // Attribute VALUES ("black", "cotton") stay identifying, so "red saree"
    // is still matched conjunctively.
    'color', 'colour', 'material', 'fabric', 'size', 'sizes', 'weight', 'length',
    // Banglish
    // 'er'/'ar'/'r' are genitive particles ("panjabi ER color") — grammar, not
    // identity. Left in, they made every possessive phrasing report NOT_FOUND
    // for a product the shop plainly sells.
    'er', 'ar', 'kapor', 'kapod', 'rong', 'rang', 'maap',
    'ache', 'achhe', 'ase', 'ashe', 'nai', 'nei', 'ki', 'kina', 'koto', 'kotto',
    'daam', 'dam', 'taka', 'takar', 'lagbe', 'nibo', 'niba', 'chai', 'dekhao',
    'dekhan', 'den', 'den', 'pabo', 'paoa', 'pawa', 'ei', 'eta', 'ota', 'ta', 'ti',
    'tar', 'amar', 'apnar', 'apni', 'ami', 'kore', 'koren', 'korbo', 'abar', 'plz',
    'chobi', 'chobita', 'sure', 'to', 'na', 'hobe', 'hoy', 'kemon', 'onek', 'kichu',
    // Bengali script
    'দাম', 'মূল্য', 'কত', 'টাকা', 'দেখান', 'দেখাও', 'আছে', 'নাই', 'নেই', 'কি', 'কী',
    'কিনব', 'কিনবো', 'লাগবে', 'চাই', 'অর্ডার', 'এই', 'এটা', 'ওটা', 'টা', 'টি',
    'আমার', 'আপনার', 'আপনি', 'আমি', 'ছবি', 'ছবিটা', 'দিন', 'দেন', 'করেন', 'আবার',
    'একটা', 'একটি', 'কোন', 'কোনো', 'হবে', 'হয়', 'এবং', 'ও', 'তো', 'না', 'জন্য',
    'পাব', 'পাবো', 'নিব', 'নিবো', 'স্টক', 'ডেলিভারি', 'ছাড়', 'অফার', 'প্রোডাক্ট',
    'রং', 'রঙ', 'কাপড়', 'সাইজ', 'মাপ', 'আসসালামু', 'আলাইকুম', 'সালাম', 'আপনাদের', 'আপনারা',
]);

/**
 * Bengali ⇄ English equivalences for the product nouns BD shops actually sell.
 * Without these, a Bengali-script query against an English-named catalog row
 * would fail conjunctive matching and report NOT_FOUND for a product the shop
 * really has — safe, but needlessly unhelpful. Deliberately small: only pairs
 * where the mapping is unambiguous.
 */
const TERM_EQUIVALENTS = new Map(Object.entries({
    'শাড়ি': 'saree', 'শাড়ী': 'saree', 'sari': 'saree', 'shari': 'saree',
    'পাঞ্জাবি': 'panjabi', 'punjabi': 'panjabi', 'পাঞ্জাবী': 'panjabi',
    'কুর্তি': 'kurti', 'কামিজ': 'kameez', 'সালোয়ার': 'salwar',
    'শার্ট': 'shirt', 'টিশার্ট': 'tshirt', 't-shirt': 'tshirt',
    'জামা': 'dress', 'ড্রেস': 'dress', 'ফ্রক': 'frock',
    'ব্যাগ': 'bag', 'জুতা': 'shoes', 'জুতো': 'shoes',
    'লাল': 'red', 'নীল': 'blue', 'কালো': 'black', 'সাদা': 'white',
    'সবুজ': 'green', 'হলুদ': 'yellow', 'গোলাপি': 'pink',
    'সুতি': 'cotton', 'সিল্ক': 'silk', 'শিফন': 'chiffon', 'জর্জেট': 'georgette',
    'মসলিন': 'muslin', 'জামদানি': 'jamdani',
}));

/**
 * Attribute vocabulary. Two jobs: decide which attribute the customer asked
 * about, and let the outbound gate detect an asserted value for an attribute
 * the catalog records as UNKNOWN.
 */
const ATTRIBUTE_VOCABULARY = Object.freeze({
    material: [
        'material', 'fabric', 'kapor', 'kapod', 'উপাদান', 'কাপড়', 'কাপড়',
        'chiffon', 'silk', 'cotton', 'georgette', 'muslin', 'jamdani', 'linen',
        'polyester', 'velvet', 'satin', 'denim', 'rayon', 'viscose', 'khadi',
        'organza', 'net', 'crepe', 'tissue', 'katan', 'half-silk', 'halfsilk',
        'শিফন', 'সিল্ক', 'সুতি', 'জর্জেট', 'মসলিন', 'জামদানি', 'কাতান',
    ],
    color: [
        'color', 'colour', 'rong', 'rang', 'রং', 'রঙ',
        'black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple',
        'orange', 'brown', 'grey', 'gray', 'maroon', 'navy', 'beige', 'golden',
        'কালো', 'সাদা', 'লাল', 'নীল', 'সবুজ', 'হলুদ', 'গোলাপি', 'খয়েরি',
    ],
    size: ['size', 'sizes', 'small', 'medium', 'large', 'xl', 'xxl', 'সাইজ', 'মাপ'],
    stock: ['stock', 'availability', 'available', 'in stock', 'quantity', 'ache', 'ase', 'আছে', 'পাওয়া যাবে', 'পাওয়া যাবে'],
});

const ATTRIBUTE_LABELS = Object.freeze({
    material: ['material', 'fabric', 'kapor', 'kapod', 'উপাদান', 'কাপড়', 'কাপড়'],
    color: ['color', 'colour', 'rong', 'rang', 'রং', 'রঙ'],
    size: ['size', 'sizes', 'সাইজ', 'মাপ'],
    stock: ['stock', 'availability', 'available', 'in stock', 'quantity'],
});

/** Does the customer's message request a product photo? */
const MEDIA_REQUEST_PATTERN =
    /\b(picture|pictures|photo|photos|pic|pics|image|images|chobi|chobita|snap)\b|ছবি|পিক/i;

// Product references are conversational convenience, not durable authority.
// They only identify which current catalog rows to re-read; mutable facts are
// fetched again on each turn. Expire the pointer after a day of inactivity.
const PRODUCT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

const isMediaRequest = (message) =>
    typeof message === 'string' && MEDIA_REQUEST_PATTERN.test(message);

/**
 * Bengali case suffixes and the English plural. "জামার দাম" inflects জামা, and
 * "sarees" pluralises saree; without stemming, conjunctive matching reports
 * NOT_FOUND for products the shop plainly sells. Safe direction to be generous
 * in: a stem still has to appear in the product's own structured fields.
 */
const BENGALI_SUFFIXES = ['গুলোর', 'গুলির', 'গুলো', 'গুলি', 'টার', 'টির', 'টা', 'টি', 'ের', 'কে', 'র', 'য়', 'ে'];

const termVariants = (term) => {
    const variants = new Set([term]);
    for (const suffix of BENGALI_SUFFIXES) {
        if (term.endsWith(suffix) && term.length - suffix.length >= 2) {
            variants.add(term.slice(0, -suffix.length));
        }
    }
    if (term.endsWith('s') && term.length >= 5) variants.add(term.slice(0, -1));
    return [...variants];
};

/**
 * Split a customer message into product-identifying terms.
 * Pure-numeric tokens are dropped: "1000 takar moddhe saree" is a budget, not a
 * product name, and treating it as an identifying claim would force NOT_FOUND
 * on a catalog that does contain sarees.
 */
const identifyingTerms = (message) => {
    if (!message || typeof message !== 'string') return [];
    const raw = message
        .toLowerCase()
        .replace(/[০-৯]/g, digit => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)))
        .replace(/\bw\s*(\d{2})\b/gi, ' size ')
        .replace(/[^\wঀ-৿\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

    const terms = [];
    for (const token of raw) {
        if (token.length < 2) continue;
        if (/^\d+$/.test(token)) continue;
        if (INTENT_STOPWORDS.has(token)) continue;
        // Canonicalise through the stem too, so "জামার" resolves to "dress".
        const canonical = termVariants(token)
            .map(v => TERM_EQUIVALENTS.get(v))
            .find(Boolean) || token;
        if (INTENT_STOPWORDS.has(canonical)) continue;
        if (!terms.includes(canonical)) terms.push(canonical);
    }
    return terms;
};

/**
 * The catalog text a term may be verified against.
 *
 * Structured fields only — descriptions are deliberately excluded. Marketing
 * prose ("drapes like chiffon") would verify "chiffon" against a product whose
 * recorded material is something else, which is precisely the class of claim
 * this module exists to prevent.
 */
const identityText = (product) => {
    const variantValues = Array.isArray(product.variants)
        ? product.variants.flatMap(v => [
            v?.size,
            v?.color,
            v?.value,
            v?.option_value,
            v?.option,
            String(v?.option_name || '').toLowerCase() === 'size' || String(v?.option_name || '').toLowerCase() === 'color'
                ? v?.option_value
                : null,
        ]).filter(Boolean)
        : [];
    return [
        product.name,
        product.name_bn,
        product.category,
        product.brand,
        ...(Array.isArray(product.aliases) ? product.aliases : []),
        ...(Array.isArray(product.tags) ? product.tags : []),
        ...variantValues,
    ].filter(Boolean).join(' ').toLowerCase();
};

/**
 * W3 FIX 3 (agent A5, from agent A8's blind merchant pass 2026-11-24):
 * quoting a row's full multi-word name is direct proof of what the customer
 * means. A8's turn ("amar Classic Blue Denim Jeans ta eku 32 size pabo? dam
 * koto ar COD ache? reply niye wait korbo") matched every product-descriptive
 * word of the real "Classic Blue Denim Jeans" row, but conversational noise
 * ('eku', 'cod', 'reply', 'niye', 'wait') counted as unmatched identity
 * claims under the conjunctive rule — so the row went to relatedProducts and
 * the deterministic NOT_FOUND tier wrote "I can't find this product in our
 * catalog, tell me its name" in the same message that then enumerated that
 * product at ৳1290. Promotion is deliberately narrow: word-aligned full
 * name (or name_bn/alias) in the message, and multi-word only — a single
 * word is a category ("chiffon saree ache?" must stay NOT_FOUND against a
 * row named "Saree"; the incident guard depends on it). Existence proven,
 * facts still rendered only from recorded fields.
 */
const normalisePhraseText = (value) => String(value || '')
    .toLowerCase()
    .replace(/[০-৯]/g, digit => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)))
    .replace(/[^\wঀ-৿\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const quotesRowName = (product, messageHaystack) => {
    const names = [
        product.name,
        product.name_bn,
        ...(Array.isArray(product.aliases) ? product.aliases : []),
    ];
    return names.some((name) => {
        const normalised = normalisePhraseText(name);
        if (!normalised || normalised.split(' ').length < 2) return false;
        return messageHaystack.includes(` ${normalised} `);
    });
};

/** Which identifying terms does this catalog row actually satisfy? */
const matchTerms = (product, terms) => {
    const haystack = identityText(product);
    // Equivalences run both ways: a Bengali query term was canonicalised to
    // English, so an English catalog row matches; an English query term must
    // still match a Bengali catalog row.
    const alternates = (term) => {
        const out = new Set(termVariants(term));
        for (const [bn, en] of TERM_EQUIVALENTS.entries()) {
            if (en === term) out.add(bn);
        }
        return [...out];
    };
    return terms.filter(term => alternates(term).some(t => haystack.includes(t)));
};

/**
 * Which attributes did the customer ask about?
 * Drives UNKNOWN reporting ("eta chiffon?" on a product with material = NULL).
 */
const askedAttributes = (message) => {
    if (!message || typeof message !== 'string') return [];
    const lower = message.toLowerCase().replace(/[০-৯]/g, digit => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)));
    const asksNumericSize = /\bw\s?\d{2}\b/i.test(lower) || /(?:সাইজ|মাপ)\s*\d{1,3}/i.test(lower);
    const asksPriceOrAvailability = /\b(?:price|cost|dam|daam|koto|taka|stock|available|availability|ache|ase|delivery|shipping|charge)\b|দাম|মূল্য|কত|টাকা|স্টক|ডেলিভারি|আছে|পাওয়া যাবে|পাওয়া যাবে/i.test(lower);
    const hasAvailabilityCue = /\b(?:stock|available|availability|in stock|quantity|ache|ase|stock e ache|stock e ase)\b|স্টক|আছে|পাওয়া যাবে|পাওয়া যাবে/i.test(lower);
    const hasAttributeQuestionCue = /\b(?:what|which|is|are|it|this|that|eta|eita|otar|tar|made|ki|kina)\b|কি|কী|এর/i.test(lower);
    return Object.entries(ATTRIBUTE_VOCABULARY)
        .filter(([attribute, words]) => {
            if (attribute === 'size' && asksNumericSize) return true;
            if (attribute === 'stock' && hasAvailabilityCue) return true;
            const labels = ATTRIBUTE_LABELS[attribute] || [];
            const values = words.filter(word => !labels.includes(word));
            const explicitName = labels.some(word => lower.includes(word));
            const valueQuestion = !asksPriceOrAvailability
                && hasAttributeQuestionCue
                && values.some(word => lower.includes(word));
            const singleValueQuestion = !asksPriceOrAvailability
                && /[?؟]\s*$/.test(lower)
                && identifyingTerms(message).length === 1
                && values.some(word => lower.includes(word));
            return explicitName || valueQuestion || singleValueQuestion;
        })
        .map(([attribute]) => attribute);
};

/**
 * Build the per-attribute fact table for a verified product.
 * A NULL catalog column becomes an explicit UNKNOWN rather than an omission —
 * omission is what the model read as "free to infer".
 */
const buildFacts = (product) => {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const activeVariants = variants.filter(v => v?.is_active !== false);
    const sizes = [...new Set(activeVariants.map(v =>
        v?.size || (String(v?.option_name || v?.option || '').toLowerCase() === 'size'
            ? (v?.option_value || v?.value)
            : null),
    ).filter(Boolean))];
    const colors = [...new Set(activeVariants.map(v =>
        v?.color || (String(v?.option_name || v?.option || '').toLowerCase() === 'color'
            ? (v?.option_value || v?.value)
            : null),
    ).filter(Boolean))];
    const known = (value) => ({ state: FactState.KNOWN, value });
    const unknown = () => ({ state: FactState.UNKNOWN, value: null });
    const uncertain = (value) => ({ state: FactState.UNCERTAIN, value: value || null });
    const parentStockValue = product.is_active === false
        ? 'DISCONTINUED'
        : product.in_stock === false
            || (product.track_quantity === true && Number(product.quantity) === 0)
            ? 'OUT_OF_STOCK'
            : 'IN_STOCK';

    return {
        name: known(product.name),
        price: Number.isFinite(product.price) ? known(product.price) : unknown(),
        // quantity decides stock ONLY where the merchant counts stock. Most BD
        // shops add products without ever setting a count, which leaves
        // quantity at 0 with track_quantity false — reading that as "sold out"
        // told real customers every in-stock product was unavailable.
        stock: known(parentStockValue),
        // An untracked count is not a count. Printing "Quantity: 0" into the
        // prompt is what the model was reasoning from.
        quantity: product.track_quantity === true && Number.isFinite(product.quantity)
            ? known(product.quantity)
            : unknown(),
        // ai_* columns are retrieval metadata and may come from image analysis.
        // They can help locate a candidate, but cannot prove merchant claims.
        material: product.ai_material ? uncertain(product.ai_material) : unknown(),
        color: colors.length
            ? known(colors.join(', '))
            : (product.ai_color ? uncertain(product.ai_color) : unknown()),
        size: sizes.length ? known(sizes.join(', ')) : unknown(),
        sizes: sizes.length ? known(sizes.join(', ')) : unknown(),
        variants: activeVariants.map(v => {
            const optionName = v?.option_name || v?.option || (v?.size ? 'Size' : v?.color ? 'Color' : null);
            const optionValue = v?.option_value || v?.value || v?.size || v?.color || null;
            const rawPrice = v?.price == null ? product.price : v.price;
            const price = rawPrice == null || rawPrice === '' ? NaN : Number(rawPrice);
            const quantity = v?.quantity == null || v?.quantity === '' ? NaN : Number(v.quantity);
            return {
                id: v?.id ? String(v.id) : null,
                optionName,
                optionValue,
                price: Number.isFinite(price) ? known(price) : unknown(),
                availability: Number.isFinite(quantity)
                    ? known(parentStockValue !== 'IN_STOCK' || quantity <= 0 ? 'OUT_OF_STOCK' : 'IN_STOCK')
                    : unknown(),
                imageUrl: productMediaUrl({ images: [v?.attributes?.image_url].filter(Boolean) }, product.shop_id || product.shopId),
            };
        }),
        brand: product.brand ? known(product.brand) : unknown(),
        category: product.category ? known(product.category) : unknown(),
    };
};

/**
 * Is this a URL we are willing to hand to Meta as a product image?
 * Absolute https only. A relative path, a data: URI or a plain http host is
 * either unreachable from Meta's fetcher or an injection surface, and a
 * product photo is never worth either risk.
 */
const isUsableMediaUrl = (url) => {
    if (typeof url !== 'string' || !url.trim()) return false;
    try {
        const parsed = new URL(url.trim());
        return parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

/**
 * Product media must be stored in the authenticated tenant's product-image
 * bucket. A URL copied from another shop's EasyModerator upload is not made
 * safe merely by storing it on this product row.
 */
const isTenantOwnedMediaUrl = (url, shopId) => {
    if (!shopId || !isUsableMediaUrl(url)) return false;
    try {
        const parsed = new URL(url.trim());
        if (parsed.username || parsed.password) return false;

        // A tenant-shaped path on an arbitrary HTTPS host is not proof that
        // EasyModerator owns the bytes. Only configured asset/API origins may
        // serve product uploads.
        const { api, publicAssets } = getOrigins();
        const trustedOrigins = new Set([api, publicAssets]
            .filter((origin) => {
                try {
                    return new URL(origin).protocol === 'https:';
                } catch {
                    return false;
                }
            }));
        if (!trustedOrigins.has(parsed.origin)) return false;

        const pathname = parsed.pathname;
        const expected = `/uploads/product-images/${encodeURIComponent(String(shopId))}/`;
        if (!pathname.startsWith('/uploads/')) return false;
        if (!pathname.startsWith(expected)) return false;
        const fileName = pathname.slice(expected.length);
        return Boolean(fileName)
            && !fileName.includes('/')
            && !fileName.includes('..')
            && !/%2f|%5c/i.test(fileName);
    } catch {
        return false;
    }
};

/** First tenant-owned image stored on THIS product row. */
const productMediaUrl = (product, shopId = product?.shop_id || product?.shopId) => {
    const candidates = [
        ...(Array.isArray(product.images) ? product.images : []),
        product.image_url,
    ];
    for (const candidate of candidates) {
        const url = typeof candidate === 'string' ? candidate : candidate?.url;
        if (isTenantOwnedMediaUrl(url, shopId)) return url.trim();
    }
    return null;
};

const toVerifiedProduct = (product, shopId, matched) => ({
    id: String(product.id),
    shopId: String(product.shop_id || product.shopId || shopId),
    name: product.name,
    nameBn: product.name_bn || null,
    price: product.price,
    facts: buildFacts(product),
    matchedTerms: matched,
    imageUrl: productMediaUrl(product, product.shop_id || product.shopId || shopId),
});

/**
 * Resolve authoritative product evidence for one customer turn.
 *
 * `candidates` are rows already fetched under this shop's scope. This function
 * performs no I/O — it is the pure decision layer, which is what makes the
 * VERIFIED/NOT_FOUND boundary directly testable.
 *
 * @param {object}   params
 * @param {string}   params.shopId
 * @param {string}   params.message      - the customer's message for this turn
 * @param {object[]} params.candidates   - shop-scoped rows from product-search
 * @param {boolean}  [params.retrievalFailed] - true when retrieval threw
 * @returns {import('./grounding.contract').GroundingEvidence}
 */
const resolveProductEvidence = ({ shopId, message, candidates = [], retrievalFailed = false }) => {
    const evidence = emptyEvidence(shopId);
    const terms = identifyingTerms(message);
    evidence.askedAttributes = askedAttributes(message);
    const mediaRequested = isMediaRequest(message);

    if (retrievalFailed) {
        // Truth is unknown. Never downgrade this to NOT_FOUND (which would let a
        // reply assert the shop does not sell something it may well sell) and
        // never to NONE (which would unlock free-form answering).
        evidence.productStatus = ProductEvidenceStatus.RETRIEVAL_FAILED;
        evidence.failure = 'product_retrieval_error';
        evidence.mediaStatus = mediaRequested ? MediaStatus.NO_PRODUCT : MediaStatus.NOT_REQUESTED;
        return withEvidenceSnapshot(evidence);
    }

    if (terms.length === 0) {
        // No product entity was named. Greetings, thanks, "abar check koren" on
        // its own — the reply carries no product claim to ground.
        evidence.productStatus = ProductEvidenceStatus.NONE;
        evidence.mediaStatus = mediaRequested ? MediaStatus.NO_PRODUCT : MediaStatus.NOT_REQUESTED;
        return withEvidenceSnapshot(evidence);
    }

    const messageHaystack = ` ${normalisePhraseText(message)} `;
    const verified = [];
    const related = [];
    for (const candidate of candidates) {
        if (!candidate || !candidate.id || !candidate.name) continue;
        const candidateShopId = candidate.shop_id || candidate.shopId;
        if (!candidateShopId || String(candidateShopId) !== String(shopId)) continue;
        const matched = matchTerms(candidate, terms);
        if (matched.length === terms.length || quotesRowName(candidate, messageHaystack)) {
            verified.push(toVerifiedProduct(candidate, shopId, matched));
        } else if (matched.length > 0) {
            related.push(toVerifiedProduct(candidate, shopId, matched));
        }
    }

    evidence.verifiedProducts = verified;
    evidence.relatedProducts = related;
    evidence.productStatus = verified.length
        ? ProductEvidenceStatus.VERIFIED
        : ProductEvidenceStatus.NOT_FOUND;
    evidence.unmatchedTerms = verified.length
        ? []
        : terms.filter(t => !related.some(r => r.matchedTerms.includes(t)));

    if (!mediaRequested) {
        evidence.mediaStatus = MediaStatus.NOT_REQUESTED;
    } else if (!verified.length) {
        evidence.mediaStatus = MediaStatus.NO_PRODUCT;
    } else if (verified.length > 1) {
        evidence.mediaStatus = MediaStatus.AMBIGUOUS;
    } else {
        const withMedia = verified.find(p => p.imageUrl);
        if (withMedia) {
            evidence.mediaStatus = MediaStatus.AVAILABLE;
            evidence.mediaUrl = withMedia.imageUrl;
            evidence.mediaProductId = withMedia.id;
            evidence.allowedUrls.push(withMedia.imageUrl);
        } else {
            evidence.mediaStatus = MediaStatus.UNAVAILABLE;
        }
    }

    return withEvidenceSnapshot(evidence);
};

/**
 * Is this turn a question about an attribute of the product already under
 * discussion, rather than a search for a new one?
 *
 * "eta chiffon?" names no product — the noun is in the previous turn. Treating
 * it as a search would answer "we don't sell that", which is both wrong and a
 * different claim from the truthful one ("we don't know this saree's material").
 */
const isAttributeOnlyQuery = (message) => {
    const attributes = askedAttributes(message);
    if (!attributes.length) return false;
    const attributeWords = new Set(
        attributes.flatMap(a => ATTRIBUTE_VOCABULARY[a]).map(w => w.toLowerCase()),
    );
    const terms = identifyingTerms(message);
    return terms.every(t => attributeWords.has(t));
};

/** Does this product's recorded value for `attribute` contain the asked term? */
const satisfiesAttributeTerms = (product, terms, attributes) =>
    attributes.every((attribute) => {
        const fact = product.facts[attribute];
        if (!fact || fact.state !== FactState.KNOWN) return false;
        const recorded = String(fact.value).toLowerCase();
        const askedForThis = terms.filter(t => (ATTRIBUTE_VOCABULARY[attribute] || []).includes(t));
        return askedForThis.length > 0 && askedForThis.every(t => recorded.includes(t));
    });

/**
 * Evidence for an attribute follow-up, grounded in the products this
 * conversation has already verified (carried on the previous AI message's
 * source_references — EasyModerator only ever writes real catalog IDs there).
 *
 * With no product in context we deliberately produce NONE: asking which product
 * they mean is the only honest answer, and it is what the caller then sends.
 */
const resolveContextualAttributeEvidence = ({ shopId, message, contextProducts = [], retrievalFailed = false }) => {
    const evidence = emptyEvidence(shopId);
    evidence.askedAttributes = askedAttributes(message);
    const terms = identifyingTerms(message);

    if (retrievalFailed) {
        evidence.productStatus = ProductEvidenceStatus.RETRIEVAL_FAILED;
        evidence.failure = 'product_retrieval_error';
        return withEvidenceSnapshot(evidence);
    }
    if (!contextProducts.length) return withEvidenceSnapshot(evidence); // NONE — ask which product

    evidence.verifiedProducts = contextProducts
        .filter(p => p && p.id && p.name && (p.shop_id || p.shopId)
            && String(p.shop_id || p.shopId) === String(shopId))
        .map(p => toVerifiedProduct(p, shopId, terms));
    if (!evidence.verifiedProducts.length) return withEvidenceSnapshot(evidence);
    evidence.productStatus = ProductEvidenceStatus.VERIFIED;

    // A photo may only accompany a confirmed "yes". If we cannot confirm the
    // attribute the customer named, sending the product's picture would present
    // it as the chiffon one they asked for.
    if (isMediaRequest(message)) {
        const match = evidence.verifiedProducts.find(p =>
            satisfiesAttributeTerms(p, terms, evidence.askedAttributes));
        if (!match) {
            evidence.mediaStatus = MediaStatus.NOT_REQUESTED;
        } else if (match.imageUrl) {
            evidence.mediaStatus = MediaStatus.AVAILABLE;
            evidence.mediaUrl = match.imageUrl;
            evidence.mediaProductId = match.id;
            evidence.allowedUrls.push(match.imageUrl);
        } else {
            evidence.mediaStatus = MediaStatus.UNAVAILABLE;
        }
    }

    return withEvidenceSnapshot(evidence);
};

/**
 * Compare the evidence used to draft a response with a fresh, shop-scoped read.
 * The caller runs this directly before provider delivery; any changed factual
 * field or missing/inactive product requires a new answer or human review.
 */
const revalidateEvidenceProducts = (evidence, liveProducts = []) => {
    const referenced = [
        ...(evidence?.verifiedProducts || []),
        ...(evidence?.relatedProducts || []),
    ];
    if (!referenced.length) return { valid: true, changedProductIds: [] };
    const liveById = new Map((liveProducts || [])
        .filter(product => product && product.id && (product.shop_id || product.shopId)
            && String(product.shop_id || product.shopId) === String(evidence.shopId))
        .map(product => [String(product.id), product]));
    const changedProductIds = [];
    for (const previous of referenced) {
        const currentRow = liveById.get(String(previous.id));
        if (!currentRow) {
            changedProductIds.push(String(previous.id));
            continue;
        }
        const current = toVerifiedProduct(currentRow, evidence.shopId, previous.matchedTerms || []);
        if (JSON.stringify(current) !== JSON.stringify(previous)) changedProductIds.push(String(previous.id));
    }
    return { valid: changedProductIds.length === 0, changedProductIds };
};

/** Product IDs this conversation has already grounded, newest turn first. */
const contextProductIds = (history = [], { now = Date.now(), ttlMs = PRODUCT_CONTEXT_TTL_MS } = {}) => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const turn = history[i] || {};
        if (turn.role === 'user' || turn.role === 'customer') continue;
        const references = turn.sourceReferences || turn.source_references || [];
        const ids = (Array.isArray(references) ? references : [])
            .filter(r => r && r.kind === 'product' && r.id && r.contextEligible !== false)
            .map(r => String(r.id));
        // The newest assistant turn is the active context boundary. A reply
        // with no product references clears an older selection; do not revive
        // a product mentioned several customer turns ago.
        if (!ids.length) return [];
        const createdAt = turn.createdAt || turn.created_at;
        if (createdAt != null) {
            const timestamp = new Date(createdAt).getTime();
            if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60 * 1000 || now - timestamp > ttlMs) {
                return [];
            }
        }
        return ids;
    }
    return [];
};

/**
 * Active customer-selected variants from the latest grounded assistant turn.
 * The presentation is only a pointer: callers must match the variant ID
 * against a fresh, tenant-scoped catalog read before using it.
 */
const contextSelectedVariants = (history = [], {
    shopId,
    now = Date.now(),
    ttlMs = PRODUCT_CONTEXT_TTL_MS,
    activeProductIds: suppliedActiveProductIds,
} = {}) => {
    if (!shopId) return {};
    const activeProductIds = new Set(Array.isArray(suppliedActiveProductIds)
        ? suppliedActiveProductIds
        : contextProductIds(history, { now, ttlMs }));
    if (!activeProductIds.size) return {};

    for (let i = history.length - 1; i >= 0; i -= 1) {
        const turn = history[i] || {};
        if (turn.role === 'user' || turn.role === 'customer') continue;
        const references = turn.sourceReferences || turn.source_references || [];
        const referencedIds = (Array.isArray(references) ? references : [])
            .filter(reference => reference && reference.kind === 'product' && reference.id)
            .map(reference => String(reference.id));
        if (!referencedIds.length) return {};

        const presentation = turn.productPresentation || turn.product_presentation;
        if (!presentation || String(presentation.shopId || '') !== String(shopId)) return {};
        const result = {};
        for (const product of presentation.products || []) {
            const id = String(product?.id || '');
            const selected = product?.selectedVariant;
            if (activeProductIds.has(id)
                && referencedIds.includes(id)
                && selected?.id
                && selected?.value
                && selected?.option) {
                result[id] = {
                    id: String(selected.id),
                    option: String(selected.option),
                    value: String(selected.value),
                };
            }
        }
        return result;
    }
    return {};
};

module.exports = {
    resolveProductEvidence,
    resolveContextualAttributeEvidence,
    isAttributeOnlyQuery,
    contextProductIds,
    contextSelectedVariants,
    satisfiesAttributeTerms,
    identifyingTerms,
    askedAttributes,
    isMediaRequest,
    PRODUCT_CONTEXT_TTL_MS,
    isUsableMediaUrl,
    isTenantOwnedMediaUrl,
    productMediaUrl,
    buildFacts,
    revalidateEvidenceProducts,
    withSourceText,
    ATTRIBUTE_VOCABULARY,
    ATTRIBUTE_LABELS,
};
