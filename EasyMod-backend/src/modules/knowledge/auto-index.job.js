'use strict';

/**
 * Knowledge Auto-Index Job
 *
 * Watches for knowledge base changes and re-indexes into the vector DB (Qdrant).
 * Should run daily or be triggered after knowledge base updates.
 *
 * Indexed sources (all non-analytics):
 *   - Shop business info (name, description, address, hours, policies)
 *   - Product catalogue (name, description, price, variants)
 *   - FAQ responses
 *   - Delivery info (zones, timing, courier details)
 *   - Payment methods (available options, instructions)
 *   - Custom knowledge documents are not part of the deterministic bulk
 *     reindex contract because their request text is not persisted in Postgres.
 *
 * Analytics (order counts, revenue, etc.) are NOT indexed — they're fetched live from DB.
 */

const { ingestData, scrollShopPointsByType, deletePoint } = require('../rag/rag.service');
const { createLogger } = require('../../utils/structured-logger');
const { sequelize } = require('../../utils/database/database-setup');
const {
    assertRequiredSourceRelations,
    getActiveShopRows,
    collectShopSources,
    SOURCE_QUERIES,
} = require('./index-source.contract');

const logger = createLogger('KnowledgeAutoIndex');

const queryRows = async (sql, bind = []) => {
    const [rows] = await sequelize.query(sql, { bind });
    return { rows };
};

const readSourceRows = async (sql, bind = []) => {
    const result = await sequelize.query(sql, { bind });
    if (Array.isArray(result)) return result[0] || [];
    if (Array.isArray(result?.rows)) return result.rows;
    return [];
};

/**
 * Reconcile-prune for ONE shop (20261126_001 lifecycle): after the published
 * upserts, delete this shop's FAQ vector points whose `faq-<id>` documentId no
 * longer maps to an eligible row (deleted, archived, disabled, draft, review,
 * or deactivated by the old image in the rollback window), OR whose stored
 * payload faq_version trails the row's sync_version (stale content must not
 * survive the reindex — sync_status only ever settles via a real sync, so a
 * point left behind by a swallowed failure would otherwise outlive the truth).
 *
 * Guarantees:
 *  - tenant-scoped: the scroll filters on payload shopId === this shop and
 *    deletePoint re-verifies ownership before removing anything;
 *  - NEVER touches non-faq points (scroll is restricted to type:'faq';
 *    business_info/product points have their own lifecycle);
 *  - idempotent: a second run over a converged store prunes nothing;
 *  - failure-counted, never silent: per-point delete failures land in errors.
 *
 * @returns {Promise<{pruned: number, errors: number}>}
 */
const reconcilePrune = async (shopId) => {
    let eligibleRows;
    try {
        eligibleRows = await readSourceRows(SOURCE_QUERIES.activeFaqs, [shopId]);
    } catch (err) {
        logger.warn('Prune eligibility read failed', { shopId, err: err.message });
        return { pruned: 0, errors: 1 };
    }
    const eligibleVersionByDocumentId = new Map(
        eligibleRows.map((row) => [`faq-${row.id}`, Number(row.sync_version) || 0]),
    );

    let points;
    try {
        points = await scrollShopPointsByType(shopId, 'faq');
    } catch (err) {
        // A missing collection means there are no points to reconcile either —
        // fresh shops must not log prune errors on every run.
        if (err?.code === 'EMBEDDING_COLLECTION_UNAVAILABLE'
            || err?.name === 'EmbeddingCollectionUnavailableError') {
            return { pruned: 0, errors: 0 };
        }
        logger.warn('Prune scroll failed', { shopId, err: err.message });
        return { pruned: 0, errors: 1 };
    }

    let pruned = 0;
    let errors = 0;
    for (const point of points) {
        const documentId = point.documentId === null || point.documentId === undefined
            ? null
            : String(point.documentId);
        const rowVersion = documentId !== null ? eligibleVersionByDocumentId.get(documentId) : undefined;
        const orphan = rowVersion === undefined;
        const stale = !orphan && (point.faqVersion === null ? rowVersion > 0 : point.faqVersion < rowVersion);
        if (!orphan && !stale) continue;
        try {
            // Delete by documentId when known (removes legacy + scoped keys);
            // fall back to the raw point id for unlabelled points — deletePoint
            // verifies payload ownership either way, so no foreign tenant data
            // can be touched.
            await deletePoint(documentId ?? point.id, shopId);
            pruned += 1;
        } catch (err) {
            logger.warn('Prune delete failed', {
                shopId, documentId: documentId ?? String(point.id), err: err.message,
            });
            errors += 1;
        }
    }
    return { pruned, errors };
};

/**
 * Re-index all knowledge for a single shop, then reconcile-prune stale/orphan
 * FAQ vector points for that shop (see reconcilePrune).
 * @param {string} shopId
 * @returns {{ indexed: number, errors: number, sourceCount: number, pruned: number }}
 */
const indexShop = async (shopId, { existingShop = null, skipRelationCheck = false } = {}) => {
    if (!skipRelationCheck) await assertRequiredSourceRelations(queryRows);
    let indexed = 0;
    let errors = 0;
    let pruned = 0;
    let sources = [];

    const ingest = async (text, metadata) => {
        if (!text || text.trim().length < 5) return;
        try {
            // ingestData swallows vector-store failures and returns { success:false }
            // (so an incremental FAQ/product write never breaks on a Qdrant blip).
            // For a reindex we must treat that as an error, not a silent success.
            const res = await ingestData({ text, metadata: { shopId, ...metadata } });
            if (res && res.success) {
                indexed++;
                // Honest settling (A9): migrated rows start sync_status='pending'
                // with sync_version=0 and nothing else ever settles them. A
                // successful batch ingest of the CURRENT row text is genuine
                // indexing evidence, so settle via the same version CAS the
                // single-write path uses. Best-effort: never breaks the batch.
                if (metadata.type === 'faq' && metadata.documentId) {
                    const faqId = String(metadata.documentId).replace(/^faq-/, '');
                    if (faqId) {
                        try {
                            const { settleFaqSync } = require('./knowledge.service');
                            await settleFaqSync(faqId, Number(metadata.faq_version) || 0, { sync_status: 'synced', synced_at: new Date() });
                        } catch (_) {
                            // Row stays pending and is retried next cycle.
                        }
                    }
                }
            } else {
                logger.warn('Ingestion reported failure', { shopId, docType: metadata.type, reason: res && res.message });
                errors++;
            }
        } catch (err) {
            logger.warn('Ingestion failed', { shopId, docType: metadata.type, err: err.message });
            errors++;
        }
    };

    try {
        sources = await collectShopSources(queryRows, shopId, existingShop);
        const { embedProduct } = require('../product/product-embedding.service');
        for (const source of sources) {
            if (source.kind === 'product') {
                try {
                    const ok = await embedProduct(source.id, shopId);
                    if (ok) { indexed++; } else { errors++; }
                } catch (err) {
                    logger.warn('Product embedding failed', { shopId, productId: source.id, err: err.message });
                    errors++;
                }
                continue;
            }
            await ingest(source.text, source.metadata);
        }

        // Reconcile AFTER the upserts: eligible-but-stale points are re-
        // ingested above (same scoped documentId, current faq_version), so
        // anything still trailing here failed to refresh and must be removed
        // rather than left serving stale content; orphans go too.
        const reconciliation = await reconcilePrune(shopId);
        pruned += reconciliation.pruned;
        errors += reconciliation.errors;

        logger.info('Shop knowledge indexed', { shopId, indexed, errors, pruned: reconciliation.pruned });
    } catch (err) {
        logger.error('Shop index failed', { shopId, err: err.message });
        errors++;
    }

    return { indexed, errors, sourceCount: sources?.length || 0, pruned };
};

/**
 * Re-index knowledge for all active shops.
 */
const run = async () => {
    logger.info('Starting knowledge auto-index job');

    await assertRequiredSourceRelations(queryRows);
    const shops = await getActiveShopRows(queryRows);

    let total = 0;
    let totalErrors = 0;
    let totalSources = 0;
    let totalPruned = 0;

    for (const shop of shops) {
        const { indexed, errors, sourceCount, pruned } = await indexShop(shop.id, {
            existingShop: shop,
            skipRelationCheck: true,
        });
        total += indexed;
        totalErrors += errors;
        totalSources += sourceCount;
        totalPruned += pruned || 0;
    }

    if (totalSources === 0) throw new Error('no indexable PostgreSQL sources found');

    logger.info('Knowledge auto-index complete', {
        shops: shops.length, documents: total, errors: totalErrors, pruned: totalPruned,
    });
    return { shops: shops.length, documents: total, errors: totalErrors, pruned: totalPruned };
};

module.exports = { run, indexShop, reconcilePrune };
