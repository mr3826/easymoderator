'use strict';

/**
 * 20261126_001 — FAQ question lifecycle (Business & FAQ Settings redesign, A5).
 *
 * Adds the question/status/sync columns to `faq_responses` so a FAQ can be a
 * first-class versioned knowledge item instead of a category string:
 *
 *   - `question` holds the merchant's question text authoritatively. Until
 *     this migration, the question lived ONLY in `category` (the P03/D3 bug
 *     class: a stray category tag could overwrite it). Backfill copies
 *     category verbatim — nothing is invented, and `category_tag` (the proper
 *     label home) is deliberately NOT backfilled because historical data does
 *     not prove what the merchant's tag was.
 *   - `status` (draft|review|published|disabled|archived) is the lifecycle
 *     machine. `is_active` STAYS and is kept in sync by every new writer
 *     (published⇔true) so existing `is_active:true` readers — intent-router
 *     Stage 1/2/3 re-resolution, getRelevantFaqs, searchFaq, message-worker
 *     pre-send revalidation, the reindex source contract — remain correct on
 *     old and new images alike. Backfill maps is_active verbatim:
 *     CASE WHEN is_active THEN 'published' ELSE 'disabled' END.
 *   - `keywords` / `internal_notes` are merchant-facing enrichment. They are
 *     NEVER projected into customer-facing AI surfaces (index text,
 *     getKnowledgeForAI, system prompt, searchFaq answer surface) — pinned by
 *     knowledge tests.
 *   - `updated_at` is the honest last-edit timestamp (writers bump
 *     explicitly; NULL displays as "—", never a fabricated created_at).
 *   - `sync_status` / `sync_version` / `synced_at` carry the saved-vs-
 *     synchronized contract: saves set 'pending' and bump sync_version; the
 *     async Qdrant sync settles to 'synced' or 'failed' (retryable via
 *     POST /api/knowledge/faqs/:id/resync). 'pruned' is reserved for
 *     reconcile-driven removal. sync_version is also written into the Qdrant
 *     point payload (faq_version) so a stale async sync can never clobber
 *     newer content.
 *
 * ALL columns are nullable or defaulted, so the OLD production image keeps
 * working during any rollback window (additive-only paired-promotion rule).
 * Every DDL statement is IF NOT EXISTS; every backfill is guarded by a WHERE
 * clause, so re-running the up is a no-op. down drops only what up added and
 * never touches `category`/`is_active` ⇒ fully reversible.
 */
module.exports = {
    name: '20261126_001_faq_question_lifecycle',

    up: async (sequelize) => {
        await sequelize.query(`
            ALTER TABLE faq_responses
              ADD COLUMN IF NOT EXISTS question        TEXT          NULL,
              ADD COLUMN IF NOT EXISTS category_tag    VARCHAR(60)   NULL,
              ADD COLUMN IF NOT EXISTS status          VARCHAR(16)   NOT NULL DEFAULT 'published',
              ADD COLUMN IF NOT EXISTS keywords        JSON          NULL,
              ADD COLUMN IF NOT EXISTS internal_notes  TEXT          NULL,
              ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ   NULL,
              ADD COLUMN IF NOT EXISTS sync_status     VARCHAR(12)   NOT NULL DEFAULT 'pending',
              ADD COLUMN IF NOT EXISTS sync_version    INTEGER       NOT NULL DEFAULT 0,
              ADD COLUMN IF NOT EXISTS synced_at       TIMESTAMPTZ   NULL;
        `);

        // Guarded backfill 1: the question copy. Only rows that have never
        // received a question keep copying; a re-run matches nothing.
        await sequelize.query(`
            UPDATE faq_responses
               SET question = category
             WHERE question IS NULL;
        `);

        // Guarded backfill 2: status CASE mapping from is_active. The column
        // default produced 'published' for every row; inactive rows become
        // 'disabled'. Rows already flipped by a new writer (archived etc.)
        // never match the guard, so this is idempotent and never invents a
        // historical category_tag or timestamps.
        await sequelize.query(`
            UPDATE faq_responses
               SET status = 'disabled'
             WHERE is_active = FALSE
               AND status = 'published';
        `);

        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_faq_shop_status ON faq_responses(shop_id, status);`
        );

        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.question IS
              'Authoritative merchant question text (Business & FAQ redesign). category keeps mirroring it for old readers; a category update must never overwrite this column.';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.category_tag IS
              'Optional label for the FAQ (VARCHAR(60)). Never backfilled — historical rows did not have a separate tag. Never used as the question text.';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.status IS
              'Lifecycle: draft|review|published|disabled|archived. Only published is eligible for knowledge retrieval/vectors. is_active stays and is mirrored by new writers (published⇔true).';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.keywords IS
              'JSON array of search keywords (merchant-facing). Excluded from every customer-facing AI projection (index text, getKnowledgeForAI, system prompt, searchFaq answer surface).';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.internal_notes IS
              'Private merchant notes. Never projected to customers or AI — neither into index text, prompts, nor answer surfaces.';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.updated_at IS
              'Honest last-edit timestamp; writers bump explicitly. NULL renders as "—" and must never be fabricated from created_at.';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.sync_status IS
              'pending|synced|failed|pruned. A save commits the row first and sets pending; the async Qdrant sync settles to synced or failed (visible, retryable via resync).';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.sync_version IS
              'Monotonic content/save counter. Each save increments it; the Qdrant point payload faq_version carries it so a stale async sync is refused instead of clobbering newer content. Sync writes use a sync_version CAS so old completions cannot mark newer saves settled.';
        `);
        await sequelize.query(`
            COMMENT ON COLUMN faq_responses.synced_at IS
              'When the vector point last reflected this row (success or removal). NULL = never synced.';
        `);
    },

    down: async (sequelize) => {
        // Real partial down: drop only what up() added. category, is_active,
        // template_*, use_count and created_at are untouched ⇒ data fully
        // reversible and old/new readers keep their existing columns.
        await sequelize.query(`DROP INDEX IF EXISTS idx_faq_shop_status;`);
        await sequelize.query(`
            ALTER TABLE faq_responses
              DROP COLUMN IF EXISTS question,
              DROP COLUMN IF EXISTS category_tag,
              DROP COLUMN IF EXISTS status,
              DROP COLUMN IF EXISTS keywords,
              DROP COLUMN IF EXISTS internal_notes,
              DROP COLUMN IF EXISTS updated_at,
              DROP COLUMN IF EXISTS sync_status,
              DROP COLUMN IF EXISTS sync_version,
              DROP COLUMN IF EXISTS synced_at;
        `);
    },
};
