'use strict';

/**
 * Qdrant tenant-key migration (W1 hardening follow-through)
 * ---------------------------------------------------------
 * Converts legacy point ids (uuidv5(documentId)) to tenant-scoped ids
 * (uuidv5("shop:<shopId>:<documentId>")) IN PLACE, one point at a time:
 * copy the vector+payload to the scoped id, verify it landed, then delete
 * the legacy id — only ever for points whose payload shopId proves ownership.
 *
 * It NEVER drops, recreates, or renames a collection, so the embedding-space
 * manifest binding (and therefore the live read path) is untouched. Points
 * already keyed with the scoped scheme are skipped, making the run idempotent
 * and safe to repeat.
 *
 * Dry-run is the DEFAULT. --apply is required to write.
 *
 * Usage (on the droplet, inside the api/worker container, one collection at a
 * time — production currently uses the shared collection, per-tenant mode
 * would pass each knowledge_documents_<shop> collection separately):
 *
 *   node src/scripts/migrate-qdrant-tenant-keys.js --collection=knowledge_documents
 *   node src/scripts/migrate-qdrant-tenant-keys.js --collection=knowledge_documents --shop=<id> --apply
 *
 * Requires: QDRANT_URL (+ QDRANT_API_KEY when set). Exit 0 on success, 1 on
 * bootstrap/execution failure.
 */

const {
    toPointId,
    toScopedPointId,
} = require('../modules/rag/rag.service');

const MANIFEST_FIELD = 'embedding_space_manifest';

function parseArg(name) {
    const prefix = `--${name}=`;
    const arg = process.argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length).trim() : null;
}

const isManifestPoint = (point) => point?.payload?.[MANIFEST_FIELD] === true;
const pointText = (point) => String(point?.payload?.text ?? point?.payload?.content ?? '')
    .replace(/[^A-Za-z0-9_. -]/g, '')
    .slice(0, 48);

/**
 * Pure classification over a batch of points — unit-tested without network.
 * Only content points with BOTH shopId and documentId are eligible; a point
 * with its id already equal to the scoped key is compliant; the legacy-keyed
 * one needs a move; if the scoped slot is already occupied (the owner shop
 * re-ingested under the new code), the legacy point is a stale duplicate and
 * only needs deletion after verification.
 */
function planKeyMigration(points) {
    const byId = new Map(points.filter(Boolean).map((p) => [String(p.id), p]));
    const plan = { moves: [], staleLegacy: [], compliant: [], unattributable: [], foreignSkipped: [] };

    for (const point of points.filter(Boolean)) {
        if (isManifestPoint(point)) { plan.compliant.push({ id: String(point.id), reason: 'manifest' }); continue; }
        const shopId = point.payload?.shopId;
        const documentId = point.payload?.documentId;
        if (!shopId || !documentId) {
            // Never re-key a point we cannot attribute to a tenant — that is
            // exactly the guess-work the W1 defect was about.
            plan.unattributable.push({ id: String(point.id), hasShopId: Boolean(shopId), hasDocumentId: Boolean(documentId) });
            continue;
        }
        let desired = '';
        try {
            desired = String(toScopedPointId(shopId, documentId));
        } catch (_) {
            plan.unattributable.push({ id: String(point.id), reason: 'invalid-shop' });
            continue;
        }
        const current = String(point.id);
        if (current === desired) {
            plan.compliant.push({ id: current, shopId });
            continue;
        }
        if (current === String(toPointId(documentId))) {
            // Legacy key. If the owner already has a scoped point, this is the
            // leftover; otherwise it must be moved.
            if (byId.has(desired)) plan.staleLegacy.push({ from: current, to: desired, shopId, documentId });
            else plan.moves.push({ from: current, to: desired, shopId, documentId });
            continue;
        }
        // An id that is neither the legacy nor the scoped key of its own
        // document (e.g. random id from a docId-less legacy write): leave it.
        plan.foreignSkipped.push({ id: current, shopId, documentId });
    }
    return plan;
}

/**
 * F2 (A9 adversarial review): the batch-local planner cannot see a scoped
 * point that lives in ANOTHER scroll batch, so plan.moves may name a target
 * that is already occupied by a NEWER copy of the same shop. The executor must
 * probe the target id directly and classify before writing:
 *   'move'         — target absent → copy legacy → verify → delete legacy.
 *   'prune-stale'  — target occupied by the SAME shop (newer scoped copy in
 *                    another batch, or the planned stale-duplicate case) →
 *                    delete only the legacy; NEVER overwrite the fresher
 *                    scoped point with older content. For a planned 'stale'
 *                    entry whose occupant has since vanished, deleting the
 *                    legacy is still right: re-copying would resurrect a
 *                    deleted document.
 *   'skip-foreign' — target occupied by a DIFFERENT shop → touch neither.
 * Pure so it is unit-testable without a network.
 */
function classifyMove(item, occupantShopId) {
    if (occupantShopId === null || occupantShopId === undefined) {
        return item.kind === 'stale' ? 'prune-stale' : 'move';
    }
    if (String(occupantShopId) === String(item.shopId)) return 'prune-stale';
    return 'skip-foreign';
}

// ── Execution (only reached from main; import is side-effect free) ───────────

const buildQdrantClient = () => {
    const { normalizeQdrantUrl } = require('../config/url-normalizer');
    const qdrantUrl = process.env.QDRANT_URL ? normalizeQdrantUrl(process.env.QDRANT_URL) : 'http://localhost:6333';
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.QDRANT_API_KEY) headers['api-key'] = process.env.QDRANT_API_KEY;
    const call = async (suffix, init = {}) => {
        const response = await fetch(`${qdrantUrl}/collections/${encodeURIComponent(state.collection)}${suffix}`, {
            ...init,
            headers: { ...headers, ...(init.headers || {}) },
        });
        if (!response.ok) throw new Error(`Qdrant HTTP ${response.status} for ${suffix}`);
        return response.json();
    };
    return { qdrantUrl, call };
};

const state = {
    collection: '',
    shop: null,
    apply: false,
};

async function* scrollPoints(call, batchSize = 64) {
    let offset = null;
    do {
        const body = {
            limit: batchSize,
            with_payload: true,
            with_vector: true,
        };
        if (offset) body.offset = offset;
        const result = await call('/points/scroll', { method: 'POST', body: JSON.stringify(body) });
        const points = result?.result?.points || [];
        if (points.length) yield points;
        offset = result?.result?.next_page_offset ?? null;
    } while (offset);
}

const upsertCopy = async (call, point, toId) => call('/points?wait=true', {
    method: 'PUT',
    body: JSON.stringify({ points: [{ id: toId, vector: point.vector, payload: point.payload }] }),
});

const removeLegacy = async (call, ids) => call('/points/delete?wait=true', {
    method: 'POST',
    body: JSON.stringify({ points: ids }),
});

const retrieveExists = async (call, id) => {
    const result = await call('/points', { method: 'POST', body: JSON.stringify({ ids: [id], with_payload: false, with_vector: false }) });
    return (result?.result || []).length > 0;
};

/** Owner (payload shopId) of the point at `id`, or null when absent. A point
 *  that exists WITHOUT a shopId payload returns '' — treated as foreign. */
const retrievePointOwner = async (call, id) => {
    const result = await call('/points', {
        method: 'POST',
        body: JSON.stringify({ ids: [id], with_payload: ['shopId'], with_vector: false }),
    });
    const point = (result?.result || [])[0];
    return point ? String(point.payload?.shopId ?? '') : null;
};

async function main() {
    const requestedCollection = parseArg('collection') || process.env.QDRANT_COLLECTION || 'knowledge_documents';
    state.collection = requestedCollection;
    state.shop = parseArg('shop');
    state.apply = process.argv.includes('--apply');

    const { qdrantUrl, call } = buildQdrantClient();
    console.log('── Qdrant tenant-key migration (W1) ─────────────');
    console.log(`  collection: ${state.collection}`);
    console.log(`  scope:      ${state.shop ? `shop ${state.shop}` : 'all shops in collection'}`);
    console.log(`  mode:       ${state.apply ? 'APPLY (writes point ops only)' : 'DRY-RUN (no writes)'} — never drops/recreates collections`);
    console.log(`  qdrantUrl:  ${qdrantUrl}`);
    console.log('─────────────────────────────────────────────────');

    const totals = { moves: 0, stale: 0, compliant: 0, unattributable: 0, foreignSkipped: 0, executed: 0 };

    for await (const batch of scrollPoints(call)) {
        const scoped = state.shop
            ? batch.filter((point) => String(point?.payload?.shopId ?? '') === String(state.shop))
            : batch;
        const plan = planKeyMigration(scoped);
        totals.moves += plan.moves.length;
        totals.stale += plan.staleLegacy.length;
        totals.compliant += plan.compliant.length;
        totals.unattributable += plan.unattributable.length;
        totals.foreignSkipped += plan.foreignSkipped.length;

        for (const item of plan.unattributable) {
            console.warn(`  UNATTRIBUTABLE id=${item.id} shop=${item.hasShopId} doc=${item.hasDocumentId ?? item.reason} — left for manual review`);
        }
        for (const item of plan.foreignSkipped) {
            console.warn(`  SKIPPED (non-standard id) id=${item.id} shop=${item.shopId} doc=${item.documentId}`);
        }

        if (!state.apply) continue;

        const byId = new Map(scoped.map((point) => [String(point.id), point]));
        // F2: never trust the batch-local view for the TARGET side. Probe the
        // occupant of every planned `to` id right before writing.
        const pending = [
            ...plan.moves.map((item) => ({ ...item, kind: 'move' })),
            ...plan.staleLegacy.map((item) => ({ ...item, kind: 'stale' })),
        ];
        for (const item of pending) {
            const occupant = await retrievePointOwner(call, item.to);
            const action = classifyMove(item, occupant);
            if (action === 'skip-foreign') {
                console.warn(`  SKIPPED foreign occupant at ${item.to} (shop ${occupant}); legacy ${item.from} left untouched`);
                totals.foreignSkipped += 1;
                continue;
            }
            if (action === 'prune-stale') {
                // A newer same-shop copy holds the target — drop ONLY the
                // (shop-owned, planner-verified) legacy point. No overwrite.
                await removeLegacy(call, [item.from]);
                totals.executed += 1;
                console.log(`  PRUNED stale legacy ${item.from} (shop ${item.shopId}, doc ${item.documentId})`);
                continue;
            }
            const source = byId.get(item.from);
            if (!source) continue; // vanished mid-run; nothing to copy
            await upsertCopy(call, source, item.to);
            if (!(await retrieveExists(call, item.to))) {
                throw new Error(`verification failed: scoped point ${item.to} did not land; legacy ${item.from} kept`);
            }
            await removeLegacy(call, [item.from]);
            totals.executed += 1;
            console.log(`  MOVED ${item.kind} key ${pointText(source)}: ${item.from} -> ${item.to}`);
        }
    }

    console.log('─────────────────────────────────────────────────');
    console.log(`  to-move:      ${totals.moves}`);
    console.log(`  stale legacy: ${totals.stale}`);
    console.log(`  compliant:    ${totals.compliant}`);
    console.log(`  unattributed: ${totals.unattributable}`);
    console.log(`  skipped:      ${totals.foreignSkipped}`);
    if (state.apply) console.log(`  executed:   ${totals.executed}`);
    console.log(`  ${state.apply ? 'Migration applied.' : 'Dry-run only — re-run with --apply to write.'}`);
    console.log('─────────────────────────────────────────────────');
    return 0;
}

if (require.main === module) {
    require('module-alias/register');
    require('dotenv').config();
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            const summary = String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 240);
            console.error(`❌ Tenant-key migration failed: ${summary}`);
            process.exit(1);
        });
}

module.exports = { planKeyMigration, classifyMove, isManifestPoint };
