'use strict';

module.exports = {
    name: '20261101_004_storefront_cod',

    up: async (sequelize) => {
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS storefronts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                shop_id UUID NOT NULL UNIQUE REFERENCES shops(id) ON DELETE CASCADE,
                slug VARCHAR(80) NOT NULL UNIQUE,
                title VARCHAR(160) NOT NULL,
                description TEXT,
                logo_url TEXT,
                settings JSONB NOT NULL DEFAULT '{"delivery_fee":0}'::jsonb,
                is_published BOOLEAN NOT NULL DEFAULT FALSE,
                published_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS storefront_products (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                storefront_id UUID NOT NULL REFERENCES storefronts(id) ON DELETE CASCADE,
                product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                variant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                position INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (storefront_id, product_id)
            );
        `);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_storefront_products_position ON storefront_products(storefront_id, position);`);
        await sequelize.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE RESTRICT;`);
        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_order_items_variant ON order_items(variant_id) WHERE variant_id IS NOT NULL;`);
    },

    down: async (sequelize) => {
        await sequelize.query(`DROP INDEX IF EXISTS idx_order_items_variant;`);
        await sequelize.query(`ALTER TABLE order_items DROP COLUMN IF EXISTS variant_id;`);
        await sequelize.query(`DROP TABLE IF EXISTS storefront_products;`);
        await sequelize.query(`DROP TABLE IF EXISTS storefronts;`);
    },
};
