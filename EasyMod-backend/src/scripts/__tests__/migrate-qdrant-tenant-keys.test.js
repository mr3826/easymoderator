'use strict';

/**
 * W1 — pure planning core of the tenant-key migration script.
 * The script imports key math FROM rag.service, so a drift between the
 * runtime write path and the migration plan is structurally impossible.
 */

process.env.NODE_ENV = 'test';
process.env.EMBEDDING_PROVIDER = 'local';
delete process.env.QDRANT_PER_TENANT;

jest.mock('src/config/config', () => ({ env: 'test' }));

const { planKeyMigration, classifyMove } = require('../migrate-qdrant-tenant-keys');
const { toPointId, toScopedPointId, EMBEDDING_SPACE_MANIFEST_POINT_ID } = {
    ...require('../../modules/rag/rag.service'),
    ...require('../../modules/rag/embedding-space'),
};

const SHOP_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SHOP_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

const point = (id, payload) => ({ id, vector: [0.1], payload });

describe('planKeyMigration', () => {
    test('legacy shop-keyed point is planned as a move to the scoped id', () => {
        const plan = planKeyMigration([
            point(toPointId('faq-7'), { shopId: SHOP_A, documentId: 'faq-7', text: 'x' }),
        ]);
        expect(plan.moves).toEqual([{
            from: toPointId('faq-7'), to: toScopedPointId(SHOP_A, 'faq-7'), shopId: SHOP_A, documentId: 'faq-7',
        }]);
        expect(plan.staleLegacy).toHaveLength(0);
    });

    test('scoped point is compliant; manifest is untouched', () => {
        const plan = planKeyMigration([
            point(toScopedPointId(SHOP_A, 'faq-7'), { shopId: SHOP_A, documentId: 'faq-7' }),
            point(EMBEDDING_SPACE_MANIFEST_POINT_ID, { embedding_space_manifest: true, embedding_collection: 'knowledge_documents' }),
        ]);
        expect(plan.moves).toHaveLength(0);
        expect(plan.compliant).toHaveLength(2);
        expect(plan.unattributable).toHaveLength(0);
    });

    test('legacy leftover alongside an existing scoped copy is pruned, not moved', () => {
        const plan = planKeyMigration([
            point(toPointId('faq-7'), { shopId: SHOP_A, documentId: 'faq-7' }),
            point(toScopedPointId(SHOP_A, 'faq-7'), { shopId: SHOP_A, documentId: 'faq-7' }),
        ]);
        expect(plan.moves).toHaveLength(0);
        expect(plan.staleLegacy).toEqual([{
            from: toPointId('faq-7'), to: toScopedPointId(SHOP_A, 'faq-7'), shopId: SHOP_A, documentId: 'faq-7',
        }]);
    });

    test('restore collision: same legacy label is owned by whichever payload says — never assumed', () => {
        // In a real collision only ONE point survives at the legacy id. The
        // planner trusts the payload, so the surviving point's OWN shop gets
        // the move; the other shop must recover via reindex (documented).
        const plan = planKeyMigration([
            point(toPointId('faq-7'), { shopId: SHOP_B, documentId: 'faq-7' }),
        ]);
        expect(plan.moves[0].shopId).toBe(SHOP_B);
        expect(plan.moves[0].to).toBe(toScopedPointId(SHOP_B, 'faq-7'));
    });

    test('unattributable points are skipped, never re-keyed or deleted', () => {
        const plan = planKeyMigration([
            point('some-uuid-1', { text: 'no shop, no doc' }),
            point('some-uuid-2', { shopId: SHOP_A }),
            point('some-uuid-3', { documentId: 'faq-1' }),
        ]);
        expect(plan.moves).toHaveLength(0);
        expect(plan.staleLegacy).toHaveLength(0);
        expect(plan.unattributable).toHaveLength(3);
    });

    test('raw-UUID document ids already satisfy the scoped contract', () => {
        const docUuid = '11111111-2222-4333-8444-555555555555';
        const plan = planKeyMigration([point(docUuid, { shopId: SHOP_A, documentId: docUuid })]);
        expect(plan.compliant).toEqual([{ id: docUuid, shopId: SHOP_A }]);
        expect(plan.moves).toHaveLength(0);
    });
});

describe('classifyMove — F2 cross-batch target probe (A9 BLOCK)', () => {
    const move = {
        kind: 'move', from: toPointId('faq-7'), to: toScopedPointId(SHOP_A, 'faq-7'), shopId: SHOP_A, documentId: 'faq-7',
    };
    const stale = { ...move, kind: 'stale' };

    test('absent target → copy-then-delete (classic move)', () => {
        expect(classifyMove(move, null)).toBe('move');
        expect(classifyMove(move, undefined)).toBe('move');
    });

    test('same-shop occupant (newer scoped copy in ANOTHER scroll batch) → prune legacy only', () => {
        // The F2 hole: batch 1 holds only the legacy point, so the batch-local
        // planner schedules a move. The scoped copy actually exists in batch 2
        // with FRESHER content. The direct probe must reclassify to a prune —
        // never an upsertCopy that rolls the newer point back to older text.
        const batch1 = [point(move.from, { shopId: SHOP_A, documentId: 'faq-7', text: 'older' })];
        const batch2 = [point(move.to, { shopId: SHOP_A, documentId: 'faq-7', text: 'newer' })];
        const plan1 = planKeyMigration(batch1);
        expect(plan1.moves).toHaveLength(1); // planner is batch-local (proven hole)
        expect(classifyMove({ ...plan1.moves[0], kind: 'move' }, SHOP_A)).toBe('prune-stale');
        // batch2 is untouched by this decision: 'prune-stale' deletes only
        // plan1.moves[0].from.
        expect(batch2[0].payload.text).toBe('newer');
    });

    test('foreign occupant → touch neither point', () => {
        expect(classifyMove(move, SHOP_B)).toBe('skip-foreign');
        expect(classifyMove(stale, SHOP_B)).toBe('skip-foreign');
    });

    test('occupant without a shopId payload is treated as foreign', () => {
        expect(classifyMove(move, '')).toBe('skip-foreign');
    });

    test('planned stale entry whose occupant vanished mid-run still prunes (no resurrection)', () => {
        // Scoped copy is gone → the document was deleted; re-copying legacy
        // content would resurrect it. Deleting the (planner-verified, own-shop)
        // legacy is the only safe action.
        expect(classifyMove(stale, null)).toBe('prune-stale');
    });
});
