# MIGRATION_PLAN — Channel Automation Redesign

Authority: [ADR-0013](../../adr/0013-channel-automation-ownership.md) §10. Expand-and-contract; **expand phase only** in this mission. No production execution (mission rule; deploy is a separate human-gated action).

## Principles

1. Preserve existing merchant behavior: every existing channel inherits (NULL overrides) → byte-identical runtime behavior. No backfill, no data transformation, no row writes.
2. Nothing enables AUTO: new shops/channels default MANUAL/inherit; stop flag defaults FALSE.
3. Rollback-safe: old code ignores the new columns; a stopped shop stays MANUAL under old code (stop writes MANUAL through the existing business setting).
4. Old API clients cannot clobber new state: overrides live in a different table/endpoint than business defaults; top-level legacy mode keys remain forbidden.
5. Idempotent DDL (`IF NOT EXISTS` / `IF EXISTS`), explicit `down`, runner contract `{name, up, down}` (`src/database/migrate.js`, lexicographic order, advisory lock, transactional).

## Files (numbering at baseline 8d477288; renumber to execution date if later — must sort after `20261114_003_commercial_model_cutover.js`)

### `EasyMod-backend/src/database/migrations/20261114_004_channel_automation_overrides.js`

```sql
-- up
ALTER TABLE meta_channel_settings ADD COLUMN IF NOT EXISTS overrides JSONB NULL;
COMMENT ON COLUMN meta_channel_settings.overrides IS
  'Explicit per-channel automation overrides (automation_mode, confidence_threshold, greeting). NULL or absent key = inherit business default. Narrow-only: effective mode = most-restrictive(business, override). Legacy automation_mode/ai_auto_reply/confidence_threshold_send/suggest columns remain non-authoritative.';
-- down
ALTER TABLE meta_channel_settings DROP COLUMN IF EXISTS overrides;
```

### `EasyMod-backend/src/database/migrations/20261114_005_shop_ai_emergency_stop.js`

```sql
-- up
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS ai_emergency_stop BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_emergency_stop_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS ai_emergency_stop_by UUID NULL,
  ADD COLUMN IF NOT EXISTS ai_emergency_stop_source TEXT NULL,
  ADD COLUMN IF NOT EXISTS ai_emergency_stop_prior_mode TEXT NULL;
COMMENT ON COLUMN shops.ai_emergency_stop IS
  'Business-wide AI emergency stop. True = no automatic AI sends on any channel; bypass-proof. Engage also sets settings.ai.automation_mode=MANUAL (rollback belt). Resume clears flag only; mode stays MANUAL.';
-- down
ALTER TABLE shops
  DROP COLUMN IF EXISTS ai_emergency_stop,
  DROP COLUMN IF EXISTS ai_emergency_stop_at,
  DROP COLUMN IF EXISTS ai_emergency_stop_by,
  DROP COLUMN IF EXISTS ai_emergency_stop_source,
  DROP COLUMN IF EXISTS ai_emergency_stop_prior_mode;
```

Entity updates in the same workstream: `meta-channel-settings.entity.js` (+ `overrides` JSONB; fix `business_hours` comment to document both accepted shapes + timezone), `shop.entity.js` (+ 5 columns). No index needed (overrides read with the row; stop read with the Shop row).

## Verification (local, disposable stacks — never production)

1. Unit migration tests (mocked sequelize SQL-shape assertions, precedent `meta-compliance.migration.test.js`): idempotency, up/down statements, defaults.
2. `npm run test:backend:migration-dryrun` — prod-shaped seeded rehearsal: full chain up, invariants, down/up round-trip schema identity, loud refusal on duplicates.
3. Post-up verification queries (dry-run output must show):
```sql
SELECT count(*) FROM meta_channel_settings WHERE overrides IS NOT NULL;      -- expect 0
SELECT count(*) FROM shops WHERE ai_emergency_stop;                          -- expect 0
SELECT automation_mode, ai_auto_reply, confidence_threshold_send, confidence_threshold_suggest
  FROM meta_channel_settings LIMIT 5;                                        -- unchanged legacy values
SELECT settings->'ai'->>'automation_mode' FROM shops LIMIT 5;                -- unchanged business modes
```
4. Existing-row hours shape audit (read-only, informs the hours defect-fix note):
```sql
SELECT channel_id, jsonb_typeof(business_hours) AS t, business_hours
  FROM meta_channel_settings WHERE business_hours IS NOT NULL;
```
5. `npm run migrate` + `npm run schema:audit` in the integration stack (CI integration job does this automatically).

## Rollback

- Code rollback: old code ignores `overrides` + stop columns; business mode remains the authority → previous behavior. Stopped shops remain MANUAL (belt).
- Schema rollback: `npm run migrate:down` twice (drops stop columns, then overrides). Additive-only; no data loss beyond the new columns' contents (overrides are merchant choices made after rollout; document in release notes).
- No irreversible transform exists anywhere in this plan.

## Deferred contract phase (future mission, NOT here)

- Drop legacy `meta_channel_settings.automation_mode`, `ai_auto_reply` (storage-only since 20260902_001).
- Drop or repurpose dead `confidence_threshold_send/suggest` after API deprecation window.
- Remove dead business settings keys (`max_auto_order_value`, `ask_email`, `required_fields`) only with an explicit product decision.
- `shops.business_hours` duplicate-store removal; `shops.config_version` dead column cleanup.
