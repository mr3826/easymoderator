const { DataTypes } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');

/**
 * FAQ knowledge item (Business & FAQ Settings redesign, A5).
 *
 * Sequelize underscored traps — do NOT "fix" these without re-reading them:
 *   1. Attribute names below are ALREADY snake_case and match the physical
 *      columns exactly; `underscored: true` only affects camelCase names.
 *   2. `timestamps: true` + `updatedAt: false` keeps Sequelize managing
 *      created_at ONLY. updated_at is a NORMAL attribute that WRITERS bump
 *      explicitly (knowledge.service). Never enable `updatedAt` here:
 *      FaqResponse.increment('use_count') and instance saves would then
 *      silently rewrite the merchant-visible edit timestamp on every FAQ
 *      hit, and honest "—" rendering for NULL would be impossible.
 *   3. `category` is kept and mirrored to `question` by every new writer so
 *      old-image readers stay correct during any rollback window. `status`
 *      ⇔ `is_active` mirror: published ⇔ true (knowledge.service
 *      mirrorIsActive/faqEligibleForKnowledge).
 */
const FaqResponse = sequelize.define('FaqResponse', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    shop_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: 'shops',
            key: 'id'
        },
        onDelete: 'CASCADE'
    },
    // Legacy question-text column; mirrors `question` on all new writes so
    // every existing is_active/category reader keeps working unchanged.
    category: {
        type: DataTypes.STRING(100),
        allowNull: false
    },
    // Authoritative merchant question text (20261126_001).
    question: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // Optional label — NEVER used as question text, never backfilled.
    category_tag: {
        type: DataTypes.STRING(60),
        allowNull: true
    },
    // Lifecycle: draft|review|published|disabled|archived. Only 'published'
    // is eligible for knowledge retrieval/vectors (faqEligibleForKnowledge).
    status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'published'
    },
    template_bn: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    template_en: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    variables: {
        type: DataTypes.JSON,
        defaultValue: []
    },
    // Merchant search keywords. NEVER projected into customer-facing AI
    // surfaces (index text, getKnowledgeForAI, system prompt, searchFaq
    // answer surface) — pinned by knowledge tests.
    keywords: {
        type: DataTypes.JSON,
        allowNull: true
    },
    // Private merchant notes. Never customer-facing — same exclusion list.
    internal_notes: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    priority: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    use_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    // Honest last-edit timestamp; writers bump explicitly. NULL renders as
    // "—" and must never be fabricated from created_at.
    updated_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    // Saved-vs-synchronized lifecycle (20261126_001): pending|synced|failed|pruned.
    sync_status: {
        type: DataTypes.STRING(12),
        allowNull: false,
        defaultValue: 'pending'
    },
    // Monotonic save counter carried into the Qdrant payload (faq_version).
    sync_version: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    synced_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'faq_responses',
    underscored: true,
    timestamps: true,
    updatedAt: false
});

module.exports = FaqResponse;
