'use strict';

/**
 * Regression tests for the knowledge auto-index job and its shared source
 * contract. The Qdrant collection name must never become a PostgreSQL source
 * table, and missing source relations must fail before any ingest attempt.
 */

process.env.NODE_ENV = 'test';

jest.mock('src/utils/structured-logger', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockIngest = jest.fn(() => Promise.resolve({ success: true }));
// Stateful point store for the reconcile-prune wiring: scrollShopPointsByType
// reports what the fake collection holds; deletePoint removes from it, so
// idempotency ("second run prunes nothing") is proven against real state.
let pointStore = [];
const mockScroll = jest.fn(async () => pointStore.map((p) => ({ ...p })));
const mockDelete = jest.fn(async (idOrDocumentId) => {
    pointStore = pointStore.filter(
        (p) => p.documentId !== idOrDocumentId && String(p.id) !== String(idOrDocumentId),
    );
});
jest.mock('src/modules/rag/rag.service', () => ({
    ingestData: (...a) => mockIngest(...a),
    scrollShopPointsByType: (...a) => mockScroll(...a),
    deletePoint: (...a) => mockDelete(...a),
}));

const mockEmbedProduct = jest.fn(() => Promise.resolve(true));
jest.mock('src/modules/product/product-embedding.service', () => ({ embedProduct: (...a) => mockEmbedProduct(...a) }));

const mockQuery = jest.fn();
jest.mock('src/utils/database/database-setup', () => ({ sequelize: { query: (...a) => mockQuery(...a) } }));

const sourceRelations = ['shops', 'faq_responses', 'products'];
let shopRow;
let faqRows;
let productRows;
let availableRelations;

const installSourceQueryMock = () => {
    mockQuery.mockImplementation((sql) => {
        const text = String(sql);
        if (text.includes('information_schema.tables')) {
            return Promise.resolve([availableRelations.map((table_name) => ({ table_name }))]);
        }
        if (text.includes('FROM shops') && text.includes('WHERE id = $1')) {
            return Promise.resolve([[shopRow].filter(Boolean)]);
        }
        if (text.includes('FROM shops')) return Promise.resolve([[shopRow].filter(Boolean)]);
        if (text.includes('FROM faq_responses')) return Promise.resolve([faqRows]);
        if (text.includes('FROM products')) return Promise.resolve([productRows]);
        throw new Error(`unexpected source SQL: ${text}`);
    });
};

const { indexShop } = require('src/modules/knowledge/auto-index.job');

describe('auto-index.job — shared PostgreSQL source contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        shopRow = null;
        faqRows = [];
        productRows = [];
        availableRelations = [...sourceRelations];
        pointStore = [];
        mockIngest.mockResolvedValue({ success: true });
        mockEmbedProduct.mockResolvedValue(true);
        mockScroll.mockImplementation(async () => pointStore.map((p) => ({ ...p })));
        mockDelete.mockImplementation(async (idOrDocumentId) => {
            pointStore = pointStore.filter(
                (p) => p.documentId !== idOrDocumentId && String(p.id) !== String(idOrDocumentId),
            );
        });
        installSourceQueryMock();
    });

    it('embeds FAQ category plus bilingual templates through the shared source selection', async () => {
        faqRows = [
            { id: 7, shop_id: 'shop-1', category: 'ডেলিভারি চার্জ', template_bn: 'ঢাকায় ৬০৳', template_en: 'Dhaka 60 BDT' },
        ];

        const res = await indexShop('shop-1');

        expect(res).toMatchObject({ errors: 0, indexed: 1, sourceCount: 1 });
        const { text, metadata } = mockIngest.mock.calls[0][0];
        expect(text).toContain('Q: ডেলিভারি চার্জ');
        expect(text).toContain('A (BN): ঢাকায় ৬০৳');
        expect(text).toContain('A (EN): Dhaka 60 BDT');
        expect(text).not.toContain('undefined');
        expect(metadata).toMatchObject({ type: 'faq', shopId: 'shop-1' });
    });

    it('does not query the Qdrant collection name as a PostgreSQL table', async () => {
        await indexShop('shop-1');

        const sqls = mockQuery.mock.calls.map((call) => String(call[0]));
        expect(sqls.some((sql) => /FROM\s+knowledge_documents\b/i.test(sql))).toBe(false);
        expect(sqls.some((sql) => /FROM\s+shop_knowledge_documents\b/i.test(sql))).toBe(false);
        expect(sqls.some((sql) => /FROM\s+(shops|faq_responses|products)\b/i.test(sql))).toBe(true);
    });

    it('fails closed when a required source relation is missing', async () => {
        availableRelations = ['shops', 'faq_responses'];

        await expect(indexShop('shop-1')).rejects.toThrow(
            'missing PostgreSQL source relation(s): products',
        );
        expect(mockIngest).not.toHaveBeenCalled();
        expect(mockEmbedProduct).not.toHaveBeenCalled();
    });

    it('counts a swallowed ingest failure as an error, not a silent success', async () => {
        faqRows = [
            { id: 1, shop_id: 'shop-1', category: 'COD', template_bn: 'ক্যাশ অন ডেলিভারি', template_en: 'Cash on delivery' },
        ];
        mockIngest.mockResolvedValueOnce({ success: false, message: 'RAG service unavailable' });

        const res = await indexShop('shop-1');

        expect(res).toMatchObject({ indexed: 0, errors: 1, sourceCount: 1 });
    });

    it('indexes additional owner business info and openingHours from the same shop source row', async () => {
        shopRow = {
            id: 'shop-1',
            settings: {
                businessInfo: {
                    shopName: 'Rina Fashion',
                    openingHours: '10am-8pm',
                    additionalInfo: 'Exchange requires an unboxing video.',
                    socialLinks: { website: 'https://rina.example' },
                },
            },
        };

        const res = await indexShop('shop-1');

        expect(res).toMatchObject({ errors: 0, indexed: 1, sourceCount: 1 });
        const { text, metadata } = mockIngest.mock.calls[0][0];
        expect(text).toContain('Business hours: 10am-8pm');
        expect(text).toContain('Additional shop owner info: Exchange requires an unboxing video.');
        expect(text).toContain('website: https://rina.example');
        expect(metadata).toMatchObject({ type: 'business_info', shopId: 'shop-1' });
    });

    // ── reconcile-prune wiring (20261126_001 lifecycle) ───────────────────────

    it('prunes FAQ points with no eligible row and keeps fresh ones', async () => {
        faqRows = [{ id: 7, shop_id: 'shop-1', question: 'Q', category: 'Q', template_en: 'A', sync_version: 2 }];
        pointStore = [
            { id: 'p-keep', documentId: 'faq-7', faqVersion: 2 },
            { id: 'p-orphan', documentId: 'faq-99', faqVersion: 1 },
        ];

        const res = await indexShop('shop-1');

        expect(res).toMatchObject({ pruned: 1, errors: 0 });
        expect(mockDelete).toHaveBeenCalledWith('faq-99', 'shop-1');
        expect(mockDelete).not.toHaveBeenCalledWith('faq-7', 'shop-1');
    });

    it('prunes a stale payload version (faq_version < row sync_version) and is idempotent on repeat', async () => {
        faqRows = [{ id: 7, shop_id: 'shop-1', question: 'Q', category: 'Q', template_en: 'A', sync_version: 3 }];
        pointStore = [{ id: 'p1', documentId: 'faq-7', faqVersion: 1 }];

        const first = await indexShop('shop-1');
        expect(first.pruned).toBe(1);
        // The row's re-ingest above landed the current version, so a second
        // run over the converged store prunes nothing.
        pointStore = [{ id: 'p1', documentId: 'faq-7', faqVersion: 3 }];
        const second = await indexShop('shop-1');
        expect(second).toMatchObject({ pruned: 0, errors: 0 });
    });

    it('keeps migrated legacy points untouched when the row has not moved past version 0', async () => {
        faqRows = [{ id: 7, shop_id: 'shop-1', question: 'Q', category: 'Q', template_en: 'A', sync_version: 0 }];
        pointStore = [{ id: 'p1', documentId: 'faq-7', faqVersion: null }]; // pre-migration point

        const res = await indexShop('shop-1');

        expect(res).toMatchObject({ pruned: 0, errors: 0 });
        expect(mockDelete).not.toHaveBeenCalled();
    });

    it('scopes the prune to faq-type points of the calling shop; unlabelled faq points go by raw id', async () => {
        faqRows = [{ id: 7, shop_id: 'shop-1', question: 'Q', category: 'Q', template_en: 'A', sync_version: 1 }];
        pointStore = [
            { id: 'p-fresh', documentId: 'faq-7', faqVersion: 1 }, // eligible + current
            { id: 'p-unlabelled', documentId: null, faqVersion: null }, // no row can match
        ];

        const res = await indexShop('shop-1');

        // The scroll is asked for faq points of THIS shop only — product and
        // business_info vectors have separate lifecycles and are never sent
        // here. deletePoint re-verifies payload ownership on every removal.
        expect(mockScroll).toHaveBeenCalledWith('shop-1', 'faq');
        expect(res).toMatchObject({ pruned: 1, errors: 0 });
        expect(mockDelete).toHaveBeenCalledWith('p-unlabelled', 'shop-1');
        expect(mockDelete).not.toHaveBeenCalledWith('faq-7', 'shop-1');
    });

    it('a missing collection is honest emptiness for the prune, not a job error', async () => {
        faqRows = [{ id: 7, shop_id: 'shop-1', question: 'Q', category: 'Q', template_en: 'A', sync_version: 1 }];
        mockScroll.mockRejectedValueOnce(Object.assign(
            new Error('Qdrant collection is unavailable'),
            { code: 'EMBEDDING_COLLECTION_UNAVAILABLE' },
        ));

        const res = await indexShop('shop-1');

        expect(res).toMatchObject({ pruned: 0, errors: 0 });
    });

    it('a prune delete failure is counted, not silent', async () => {
        faqRows = [];
        pointStore = [{ id: 'p-orphan', documentId: 'faq-99', faqVersion: 1 }];
        mockDelete.mockRejectedValueOnce(new Error('Qdrant HTTP 503'));

        const res = await indexShop('shop-1');

        expect(res).toMatchObject({ pruned: 0, errors: 1 });
    });
});
