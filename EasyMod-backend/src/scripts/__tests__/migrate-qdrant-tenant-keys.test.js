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

const { planKeyMigration } = require('../migrate-qdrant-tenant-keys');
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
