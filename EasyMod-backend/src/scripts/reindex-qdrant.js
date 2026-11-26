'use strict';

/**
 * Qdrant reindex CLI
 * ------------------
 * Rebuilds the Qdrant vector store from the current database state by running
 * the knowledge auto-index job (business info + FAQs + products) for every
 * active shop, or a single shop with --shop=<id>.
 *
 * Why this exists: the auto-index job (src/modules/knowledge/auto-index.job.js)
 * had no entry point, so after standardizing on Qdrant (Pinecone removed
 * 2026-05-31) there was no way to (re)populate the collection. This gives ops
 * a single idempotent command.
 *
 * Idempotent: every document is upserted under a deterministic id
 * (faq-<id>, product-<id>, biz-<shopId>), so re-running overwrites rather
 * than duplicating. FAQ vectors additionally RECONCILE: after the upserts the
 * job prunes this shop's faq points whose faq-<id> row is no longer eligible
 * (deleted/deactivated/unpublished) or whose payload faq_version trails the
 * row sync_version (20261126_001 lifecycle; failure-counted, never silent).
 *
 * Usage (on the droplet, inside the api/worker container):
 *   npm run reindex:qdrant -- --collection=<new-name>             # all active shops into an isolated collection
 *   npm run reindex:qdrant -- --collection=<new-name> --shop=<id> # one shop into an isolated collection
 *
 * Production requires an explicit --collection target. This prevents an
 * operator from accidentally reindexing the active collection in place during
 * an embedding-provider migration. The source collection remains untouched;
 * switch QDRANT_COLLECTION only after validating the target collection.
 *
 * Requires (production): DATABASE_URL, QDRANT_URL, QDRANT_API_KEY,
 * QDRANT_COLLECTION, and an embedding key (GOOGLE_GEMINI_API_KEY / GEMINI_API_KEY).
 * Exit code: 0 on success, 1 if any ingestion errored or bootstrap failed.
 */

require('module-alias/register');
require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

function parseArg(name) {
    const prefix = `--${name}=`;
    const arg = process.argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length).trim() : null;
}

const requestedCollection = parseArg('collection');
const configuredCollection = process.env.QDRANT_COLLECTION || 'knowledge_documents';
let sequelize = null;
let run = null;
let indexShop = null;
let reindexStage = 'bootstrap';

if (env === 'production' && !requestedCollection) {
    throw new Error(
        'Production reindex requires an explicit --collection=<new-name> target; '
        + 'refusing to reindex the active collection in place.',
    );
}

if (requestedCollection && requestedCollection === configuredCollection) {
    throw new Error(
        `Refusing to reindex active collection "${configuredCollection}" in place; `
        + 'provide a separate migration collection.',
    );
}

if (requestedCollection) process.env.QDRANT_COLLECTION = requestedCollection;

// Force file-based SQLite in development only (mirrors seed-admin.js).
if (!process.env.DATABASE_URL && env !== 'production') {
    process.env.DATABASE_URL = 'sqlite:./database.sqlite';
}

function parseShopArg() {
    return parseArg('shop');
}

const safeErrorType = (error) => String(error?.name || error?.constructor?.name || 'Error')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 80) || 'Error';

const sanitizeErrorSummary = (error) => String(error?.message || error || 'unknown error')
    .replace(/["']?postgres(?:ql)?:\/\/[^\s"'`]+["']?/gi, '[database-url]')
    .replace(/["']?https?:\/\/[^\s"'`]+["']?/gi, '[url]')
    .replace(/([?&](?:key|token|api[-_]?key|apikey)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|AIza)[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240) || 'unknown error';

const emitReindexFailure = (error) => {
    console.error(`REINDEX_STAGE=${reindexStage}`);
    console.error(`REINDEX_ERROR_TYPE=${safeErrorType(error)}`);
    console.error(`REINDEX_ERROR_SUMMARY=${sanitizeErrorSummary(error)}`);
};

const closeDatabase = async () => {
    if (sequelize) await sequelize.close().catch(() => {});
};

async function main() {
    const shopId = parseShopArg();

    // Keep bootstrap inside main so module/configuration failures are emitted
    // through the sanitized diagnostic contract below.
    reindexStage = 'bootstrap';
    require('../modules/entities');
    ({ sequelize } = require('../utils/database/database-setup'));
    ({ run, indexShop } = require('../modules/knowledge/auto-index.job'));

    console.log('── Qdrant reindex ───────────────────────────────');
    console.log(`  env:        ${env}`);
    console.log(`  qdrantUrl:  ${process.env.QDRANT_URL ? 'configured' : 'default'}`);
    console.log(`  collection: ${process.env.QDRANT_COLLECTION || 'knowledge_documents (default)'}`);
    if (requestedCollection) console.log(`  source:     ${configuredCollection}`);
    console.log(`  perTenant:  ${process.env.QDRANT_PER_TENANT === 'true'}`);
    console.log(`  scope:      ${shopId ? `single shop ${shopId}` : 'all active shops'}`);
    console.log('─────────────────────────────────────────────────');

    if (!process.env.QDRANT_URL) {
        console.warn('⚠️  QDRANT_URL is not set — defaulting to http://localhost:6333. '
            + 'Set it to the production Qdrant before running against prod.');
    }
    if (!process.env.GOOGLE_GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
        console.warn('⚠️  No embedding key found (GOOGLE_GEMINI_API_KEY / GEMINI_API_KEY). '
            + 'Embeddings will fail and every document will be skipped.');
    }

    reindexStage = 'database';
    try {
        await sequelize.authenticate();
    } catch (dbErr) {
        const detail = dbErr.original ? `${dbErr.original.code || ''} ${dbErr.original.message || ''}`.trim() : '';
        throw new Error(`database connection failed: ${dbErr.message || detail || 'unknown error'}${detail ? ` (${detail})` : ''}`);
    }

    reindexStage = 'index';
    const started = Date.now();
    let result;
    if (shopId) {
        const { indexed, errors, pruned } = await indexShop(shopId);
        result = { shops: 1, documents: indexed, errors, pruned: pruned || 0 };
    } else {
        result = await run();
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log('─────────────────────────────────────────────────');
    console.log(`  shops:     ${result.shops}`);
    console.log(`  indexed:   ${result.documents} documents`);
    console.log(`  pruned:    ${result.pruned || 0} stale/orphan FAQ vectors`);
    console.log(`  errors:    ${result.errors}`);
    console.log(`  duration:  ${secs}s`);
    console.log('─────────────────────────────────────────────────');

    if (result.errors > 0) {
        const error = new Error(`reindex reported ${result.errors} ingestion errors`);
        error.name = 'ReindexIngestionError';
        emitReindexFailure(error);
        return 1;
    }

    return 0;
}

if (require.main === module) {
    main()
        .then(async (code) => {
            await closeDatabase();
            console.log(code === 0 ? '✅ Reindex complete.' : '⚠️  Reindex finished with errors (see above).');
            process.exit(code);
        })
        .catch(async (err) => {
            emitReindexFailure(err);
            console.error(`❌ Reindex failed: ${sanitizeErrorSummary(err)}`);
            await closeDatabase();
            process.exit(1);
        });
}

module.exports = {
    emitReindexFailure,
    safeErrorType,
    sanitizeErrorSummary,
};
