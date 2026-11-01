'use strict';

async function ensureAddonCodeConstraint(sequelize) {
    if (sequelize.getDialect?.() !== 'postgres') return;
    await sequelize.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'shop_addons_code_check' AND conrelid = 'shop_addons'::regclass
            ) THEN
                ALTER TABLE shop_addons ADD CONSTRAINT shop_addons_code_check
                    CHECK (addon_code IN ('ADS_STUDIO', 'STOREFRONT'));
            END IF;
        END;
        $$;
    `);
}

module.exports = {
    name: '20261101_001_founder_pilot_addons',

    async up(sequelize) {
        await sequelize.query(`
            ALTER TABLE shop_pilot_features
                ADD COLUMN IF NOT EXISTS ads_studio BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS storefront BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS ai_reply_shadow_meter BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS ai_reply_shadow_meter_enabled_at TIMESTAMPTZ;
        `);

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS shop_addons (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
                addon_code VARCHAR(40) NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT FALSE,
                enabled_by UUID REFERENCES users(id) ON DELETE SET NULL,
                enabled_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT shop_addons_code_check
                    CHECK (addon_code IN ('ADS_STUDIO', 'STOREFRONT'))
            );
        `);
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_addons_shop_code
                ON shop_addons(shop_id, addon_code);
        `);
        await ensureAddonCodeConstraint(sequelize);
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_shop_addons_shop_enabled
                ON shop_addons(shop_id, enabled, addon_code);
        `);
    },

    async down(sequelize) {
        await sequelize.query('DROP TABLE IF EXISTS shop_addons;');
        await sequelize.query(`
            ALTER TABLE shop_pilot_features
                DROP COLUMN IF EXISTS ads_studio,
                DROP COLUMN IF EXISTS storefront,
                DROP COLUMN IF EXISTS ai_reply_shadow_meter,
                DROP COLUMN IF EXISTS ai_reply_shadow_meter_enabled_at;
        `);
    },
};
