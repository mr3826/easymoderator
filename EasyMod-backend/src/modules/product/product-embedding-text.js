'use strict';

/**
 * Build the canonical product document used by both incremental embedding and
 * the deterministic Qdrant reindex source contract.
 */
const textValue = (value) => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
};

const textValues = (values) => (Array.isArray(values) ? values : [])
    .map(textValue)
    .filter(Boolean);

const describeVariants = (variants) => {
    const legacyStrings = [];
    const groups = [];
    for (const variant of Array.isArray(variants) ? variants : []) {
        if (typeof variant === 'string') {
            const value = textValue(variant);
            if (value) legacyStrings.push(value);
            continue;
        }
        if (!variant || typeof variant !== 'object' || Array.isArray(variant)) continue;

        if (typeof variant.name === 'string' && Array.isArray(variant.options)) {
            const name = textValue(variant.name);
            const options = textValues(variant.options);
            if (name && options.length) groups.push(`${name}: ${options.join(', ')}`);
            continue;
        }

        for (const [name, options] of Object.entries(variant)) {
            const values = textValues(options);
            if (name && values.length) groups.push(`${name}: ${values.join(', ')}`);
        }
    }
    return {
        legacyStrings,
        groups,
    };
};

const buildEmbeddingText = (product = {}) => {
    const parts = [
        textValue(product.name),
        textValue(product.name_bn),
    ];

    const variants = describeVariants(product.variants);
    if (variants.legacyStrings.length) parts.push(`sizes: ${variants.legacyStrings.join(', ')}`);
    if (variants.groups.length) parts.push(`variants: ${variants.groups.join('; ')}`);

    const category = textValue(product.category);
    const aiCategory = textValue(product.ai_category);
    if (category) parts.push(`category: ${category}`);
    if (aiCategory && aiCategory !== category) {
        parts.push(aiCategory);
    }

    const primaryColor = textValue(product.ai_color_primary);
    const material = textValue(product.ai_material);
    const style = textValue(product.ai_attributes?.style);
    if (primaryColor) parts.push(primaryColor);
    if (material) parts.push(material);
    if (style) parts.push(style);

    const tags = [...textValues(product.tags), ...textValues(product.ai_tags)];
    if (tags.length) parts.push(tags.join(' '));

    const description = textValue(product.description);
    const aiDescription = textValue(product.ai_description);
    if (description) parts.push(description);
    if (aiDescription && aiDescription !== description) {
        parts.push(aiDescription);
    }

    const sku = textValue(product.sku);
    if (sku) parts.push(`SKU: ${sku}`);

    return parts.filter(Boolean).join(' | ');
};

module.exports = { buildEmbeddingText };
