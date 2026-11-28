'use strict';

const { buildEmbeddingText } = require('../product-embedding-text');

describe('product embedding text variant normalization', () => {
    it('formats grouped options without stringifying objects as catalog facts', () => {
        const text = buildEmbeddingText({
            name: 'Classic Shirt',
            variants: [
                { name: 'Color', options: ['Blue', { label: 'Invalid object option' }] },
                { Size: ['S', 'M', { value: 'Invalid object option' }] },
                { name: 'Empty group', options: [] },
            ],
            tags: ['cotton', { name: 'invalid tag object' }],
            ai_attributes: { style: { value: 'invalid style object' } },
        });

        expect(text).toContain('variants: Color: Blue; Size: S, M');
        expect(text).not.toContain('sizes:');
        expect(text).not.toContain('[object Object]');
        expect(text).not.toContain('Invalid object option');
        expect(text).not.toContain('invalid tag object');
        expect(text).not.toContain('invalid style object');
    });

    it('preserves legacy string variants as size text without admitting object entries', () => {
        const text = buildEmbeddingText({
            name: 'Legacy Item',
            variants: ['Small', 'Large', { option_name: 'Size', option_value: 'Bogus' }],
        });

        expect(text).toContain('sizes: Small, Large');
        expect(text).not.toContain('Bogus');
        expect(text).not.toContain('[object Object]');
    });
});
