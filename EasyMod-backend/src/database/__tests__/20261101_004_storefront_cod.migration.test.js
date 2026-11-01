'use strict';

const migration = require('../migrations/20261101_004_storefront_cod');

describe('20261101_004_storefront_cod migration', () => {
    test('creates storefront selection storage and order-item variant snapshots idempotently', async () => {
        const query = jest.fn().mockResolvedValue([[], {}]);

        await migration.up({ query });

        const statements = query.mock.calls.map(([sql]) => sql).join('\n');
        expect(statements).toContain('CREATE TABLE IF NOT EXISTS storefronts');
        expect(statements).toContain('shop_id UUID NOT NULL UNIQUE REFERENCES shops(id)');
        expect(statements).toContain('CREATE TABLE IF NOT EXISTS storefront_products');
        expect(statements).toContain('UNIQUE (storefront_id, product_id)');
        expect(statements).toContain('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id UUID');
        expect(statements).toContain('REFERENCES product_variants(id) ON DELETE RESTRICT');
    });

    test('down migration removes only storefront artifacts and the variant snapshot column', async () => {
        const query = jest.fn().mockResolvedValue([[], {}]);

        await migration.down({ query });

        const statements = query.mock.calls.map(([sql]) => sql).join('\n');
        expect(statements).toContain('DROP TABLE IF EXISTS storefront_products');
        expect(statements).toContain('DROP TABLE IF EXISTS storefronts');
        expect(statements).toContain('ALTER TABLE order_items DROP COLUMN IF EXISTS variant_id');
        expect(statements).not.toContain('DROP TABLE IF EXISTS orders');
    });
});
