'use strict';

const { buildFacts } = require('../product-evidence.service');
const { FactState } = require('../grounding.contract');

describe('product evidence variant authority', () => {
    const baseProduct = {
        id: 'product-a',
        name: 'Classic Shirt',
        price: 10,
        quantity: 0,
        track_quantity: false,
        is_active: true,
        in_stock: true,
    };

    it('does not turn legacy strings or editor option groups into live variant facts', () => {
        const facts = buildFacts({
            ...baseProduct,
            variants: [
                'Large',
                { name: 'Color', options: ['Blue', 'Red'] },
                { Size: ['S', 'M'] },
            ],
        });

        expect(facts.size).toEqual({ state: FactState.UNKNOWN, value: null });
        expect(facts.sizes).toEqual({ state: FactState.UNKNOWN, value: null });
        expect(facts.variants).toEqual([]);
        expect(JSON.stringify(facts)).not.toContain('[object Object]');
        expect(JSON.stringify(facts)).not.toContain('Large');
        expect(JSON.stringify(facts)).not.toContain('Blue');
    });

    it('uses relational variant quantities when parent stock disagrees', () => {
        const facts = buildFacts({
            ...baseProduct,
            track_quantity: true,
            quantity: 0,
            in_stock: false,
            product_variants: [{
                id: 'variant-a',
                option_name: 'Size',
                option_value: 'M',
                price: 12,
                quantity: 4,
                is_active: true,
            }],
            variants: ['legacy-only'],
        });

        expect(facts.size).toEqual({ state: FactState.KNOWN, value: 'M' });
        expect(facts.variants).toHaveLength(1);
        expect(facts.variants[0]).toMatchObject({
            id: 'variant-a',
            optionName: 'Size',
            optionValue: 'M',
            availability: { state: FactState.KNOWN, value: 'IN_STOCK' },
        });
        expect(facts.stock).toEqual({ state: FactState.KNOWN, value: 'IN_STOCK' });
        expect(facts.quantity).toEqual({ state: FactState.KNOWN, value: 4 });
        expect(JSON.stringify(facts)).not.toContain('[object Object]');
    });

    it('does not report parent quantity as available when active relational variants are empty', () => {
        const facts = buildFacts({
            ...baseProduct,
            track_quantity: true,
            quantity: 20,
            in_stock: true,
            product_variants: [{
                id: 'variant-a',
                option_name: 'Size',
                option_value: 'M',
                quantity: 0,
                is_active: true,
            }],
        });

        expect(facts.stock).toEqual({ state: FactState.KNOWN, value: 'OUT_OF_STOCK' });
        expect(facts.quantity).toEqual({ state: FactState.KNOWN, value: 0 });
        expect(facts.variants[0].availability).toEqual({ state: FactState.KNOWN, value: 'OUT_OF_STOCK' });
    });
});
