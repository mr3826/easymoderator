'use strict';

process.env.NODE_ENV = 'test';

// knowledge.service pulls the data/cache layer at IMPORT time; stub it so the
// drift comparison can load both builders in one process (the suite below
// only calls the pure text builders).
jest.mock('src/utils/database/database-setup', () => ({
    sequelize: { define: jest.fn(() => ({})), query: jest.fn() },
}));
jest.mock('src/modules/entities', () => ({
    Shop: {}, UserShop: {}, FaqResponse: {}, BanglishDictionary: {},
}));
jest.mock('src/modules/analytics/knowledge-gap.entity', () => ({}));
jest.mock('src/modules/shop/shop.service', () => ({
    getShopAiSettings: jest.fn(async () => ({})),
    updateShopSettingsPreservingRtoConsent: jest.fn(),
}));
jest.mock('src/modules/rag/rag.service', () => ({
    ingestData: jest.fn(), deletePoint: jest.fn(), queryData: jest.fn(), scrollShopPointsByType: jest.fn(),
}));
jest.mock('src/utils/cache.service', () => ({
    get: jest.fn(async () => null),
    set: jest.fn(async () => {}),
    getForShop: jest.fn(async () => null),
    setForShop: jest.fn(async () => {}),
    deleteForShop: jest.fn(async () => {}),
    incrementForShop: jest.fn(async () => 1),
}));
jest.mock('src/utils/shop-settings-cache', () => ({
    MERCHANT_KNOWLEDGE_CACHE_KEY: 'knowledge:summary',
    AI_KNOWLEDGE_CACHE_KEY: 'knowledge:ai-summary',
    invalidateShopSettingsCaches: jest.fn(async () => {}),
}));

const contract = require('src/modules/knowledge/index-source.contract');
const {
    SOURCE_TABLES,
    SOURCE_COUNT_RULE,
    SOURCE_QUERIES,
    assertRequiredSourceRelations,
    collectSourceStats,
    collectShopSources,
    buildBusinessInfoIndexText: contractBusinessText,
    buildFaqIndexText: contractFaqText,
} = contract;
const knowledgeService = require('src/modules/knowledge/knowledge.service');

const rowsFor = (rows) => jest.fn(async () => ({ rows }));

describe('Qdrant reindex PostgreSQL source contract', () => {
    it('keeps the Qdrant collection identifier out of the PostgreSQL source contract', () => {
        expect(SOURCE_TABLES).toEqual(['shops', 'faq_responses', 'products']);
        expect(SOURCE_TABLES).not.toContain('knowledge_documents');
        expect(Object.values(SOURCE_QUERIES).join(' ')).not.toMatch(/knowledge_documents/i);
    });

    it('defines the source-count rule once for reindex and proof consumers', () => {
        expect(SOURCE_COUNT_RULE).toContain('business-info');
        expect(SOURCE_COUNT_RULE).toContain('active FAQ');
        expect(SOURCE_COUNT_RULE).toContain('active product');
        expect(SOURCE_QUERIES.activeProducts).toContain('LIMIT 200');
    });

    it('rejects missing required relations instead of silently treating them as empty', async () => {
        const query = rowsFor([{ table_name: 'shops' }, { table_name: 'faq_responses' }]);

        await expect(assertRequiredSourceRelations(query)).rejects.toThrow(
            'missing PostgreSQL source relation(s): products',
        );
    });

    it('rejects a zero-source database instead of accepting an empty proof baseline', async () => {
        const query = jest.fn(async (sql) => {
            const text = String(sql);
            if (text.includes('information_schema.tables')) {
                return { rows: SOURCE_TABLES.map((table_name) => ({ table_name })) };
            }
            if (text.includes('FROM shops')) return { rows: [] };
            throw new Error(`unexpected query: ${text}`);
        });

        await expect(collectSourceStats(query)).rejects.toThrow('no indexable PostgreSQL sources found');
    });

    it('counts the same non-empty business, FAQ, and product sources selected by reindex', async () => {
        const query = jest.fn(async (sql) => {
            const text = String(sql);
            if (text.includes('information_schema.tables')) {
                return { rows: SOURCE_TABLES.map((table_name) => ({ table_name })) };
            }
            if (text.includes('FROM shops')) {
                return { rows: [{ id: 'shop-1', settings: { businessInfo: { shopName: 'Rina Fashion' } } }] };
            }
            if (text.includes('FROM faq_responses')) {
                return { rows: [{ id: 7, shop_id: 'shop-1', category: 'COD', template_en: 'Cash on delivery' }] };
            }
            if (text.includes('FROM products')) {
                return { rows: [{ id: 'product-1', shop_id: 'shop-1', name: 'Cotton shirt', variants: [], tags: [] }] };
            }
            throw new Error(`unexpected query: ${text}`);
        });

        await expect(collectSourceStats(query)).resolves.toMatchObject({
            count: 3,
            shopIds: ['shop-1'],
        });
    });

    // ── 20261126_001 lifecycle extensions (A5) ──────────────────────────────

    it('selects FAQ sources published-only with the is_active mirror and carries sync_version', () => {
        const sql = SOURCE_QUERIES.activeFaqs;
        expect(sql).toContain("status = 'published'");
        expect(sql).toContain('is_active = true');
        expect(sql).toContain('question');
        expect(sql).toContain('sync_version');
        // Private merchant columns are NOT selected at all — the bulk path
        // can never index text it does not read.
        expect(sql).not.toContain('keywords');
        expect(sql).not.toContain('internal_notes');
    });

    it('emits faq_version point metadata from the row sync_version', async () => {
        const query = jest.fn(async (sql) => {
            const text = String(sql);
            if (text.includes('FROM shops')) return { rows: [{ id: 'shop-1', settings: {} }] };
            if (text.includes('FROM faq_responses')) {
                return {
                    rows: [{
                        id: 7, shop_id: 'shop-1', question: 'Real question?', category: 'Real question?',
                        template_en: 'A', template_bn: null, sync_version: 3,
                    }],
                };
            }
            if (text.includes('FROM products')) return { rows: [] };
            throw new Error(`unexpected query: ${text}`);
        });

        const sources = await collectShopSources(query, 'shop-1', { id: 'shop-1', settings: {} });
        const faqSource = sources.find((s) => s.kind === 'faq');
        expect(faqSource.metadata).toMatchObject({
            type: 'faq',
            documentId: 'faq-7',
            faq_id: 7,
            faq_version: 3,
            embeddingTitle: 'Real question?',
        });
        expect(faqSource.text).toBe('Q: Real question?\nA (EN): A');
    });

    it('resolves mirror-drifted rows to the fresh category in the bulk path too (A9 invariant)', async () => {
        const query = jest.fn(async (sql) => {
            const text = String(sql);
            if (text.includes('FROM shops')) return { rows: [{ id: 'shop-1', settings: {} }] };
            if (text.includes('FROM faq_responses')) {
                return {
                    rows: [{
                        id: 8, shop_id: 'shop-1', question: 'STALE question?', category: 'FRESH from old image',
                        template_en: 'A', template_bn: null, sync_version: 1,
                    }],
                };
            }
            if (text.includes('FROM products')) return { rows: [] };
            throw new Error(`unexpected query: ${text}`);
        });

        const sources = await collectShopSources(query, 'shop-1', { id: 'shop-1', settings: {} });
        const faqSource = sources.find((s) => s.kind === 'faq');
        expect(faqSource.text).toBe('Q: FRESH from old image\nA (EN): A');
        expect(faqSource.metadata.embeddingTitle).toBe('FRESH from old image');
    });

    // The incremental write path (knowledge.service) and the bulk reindex
    // (index-source.contract) MUST produce byte-identical embedding text for
    // the same input — otherwise the two paths grow two different embedding
    // spaces for one collection. This is the drift guard A5 promised A6.
    describe('builder lockstep (drift guard)', () => {
        const faqFixtures = [
            { name: 'mirrored row uses the question', row: { question: 'Real?', category: 'Real?', template_en: 'A' } },
            { name: 'drifted row uses the fresh category (A9 invariant)', row: { question: 'STALE?', category: 'FRESH from old image', template_en: 'A' } },
            { name: 'legacy row without question falls back to category', row: { category: 'COD', template_bn: 'ক্যাশ অন ডেলিভারি' } },
            { name: 'private columns are ignored', row: { question: 'Q', category: 'Q', template_en: 'A', template_bn: 'B', keywords: ['kw-secret'], internal_notes: 'note-secret' } },
            { name: 'empty row', row: {} },
        ];
        const businessFixtures = [
            {
                name: 'full identity + composed description + all policies',
                info: {
                    shopName: 'Rina', nameEn: 'Rina EN', tagline: 'Best fits', additionalInfo: 'Unboxing video needed',
                    email: 'care@rina.test', city: 'Dhaka', address: '123 Main St', phone: '01700',
                    openingHours: '10am-8pm', socialLinks: { facebook: 'https://fb.com/rina', instagram: '' },
                },
                policies: {
                    returns: { stance: 'offered', period_days: 7, details: 'unused only', exclusions: 'innerwear' },
                    exchange: { stance: 'conditional', period_days: 3 },
                    refunds: { stance: 'not_offered', details: 'no refunds' },
                    warranty: { stance: 'offered', duration: '6 months', coverage: 'manufacturing defects', coverage_exclusions: 'physical damage' },
                },
            },
            { name: 'returnPolicy precedence slot', info: { shopName: 'R', returnPolicy: 'explicit statement' }, policies: { returns: { stance: 'offered' } } },
            { name: 'policies absent → no policy lines', info: { shopName: 'R' }, policies: null },
            { name: 'empty object', info: {}, policies: {} },
            { name: 'businessHours alias', info: { shopName: 'R', businessHours: 'Fri 2-6pm' }, policies: {} },
        ];

        it.each(faqFixtures.map((f) => [f.name, f.row]))(
            'buildFaqIndexText copies agree byte-for-byte: %s',
            (_name, row) => {
                expect(knowledgeService.buildFaqIndexText(row)).toBe(contract.buildFaqIndexText(row));
            },
        );

        it.each(businessFixtures.map((f) => [f.name, f.info, f.policies]))(
            'buildBusinessInfoIndexText copies agree byte-for-byte: %s',
            (_name, info, policies) => {
                expect(knowledgeService.buildBusinessInfoIndexText(info, policies)).toBe(
                    contractBusinessText(info, policies),
                );
            },
        );

        it('mirror-invariant question resolution + policies text + description composition hold in BOTH copies', () => {
            // New writes: question === category → the question is the label.
            const mirrored = { question: 'Real question?', category: 'Real question?', template_en: 'Yes', keywords: ['kw-secret'], internal_notes: 'note-secret' };
            // Rollback-window drift: both present, different → fresh category wins.
            const drifted = { question: 'STALE q', category: 'FRESH from old image', template_en: 'Yes' };
            for (const build of [contractFaqText, knowledgeService.buildFaqIndexText]) {
                const text = build(mirrored);
                expect(text).toContain('Q: Real question?');
                expect(text).not.toContain('kw-secret');
                expect(text).not.toContain('note-secret');
                expect(build(drifted)).toContain('Q: FRESH from old image');
            }

            const info = { shopName: 'Rina', nameEn: 'Rina EN', tagline: 'Best fits', additionalInfo: 'Long note' };
            const policies = { returns: { stance: 'offered', period_days: 7 } };
            for (const build of [contractBusinessText, knowledgeService.buildBusinessInfoIndexText]) {
                const text = build(info, policies);
                const lines = text.split('\n');
                expect(lines[0]).toBe('Shop name: Rina');
                expect(lines[1]).toBe('English shop name: Rina EN');
                expect(text).toContain('Description: Best fits | Long note');
                expect(text).toContain('Return policy: stance: offered; window: 7 days');
            }
        });

        it('shared policy vocabulary renders identically (renderPolicyParts is the single source)', () => {
            const policy = {
                stance: 'conditional', period_days: 30, details: ' sealed ', exclusions: null,
                process: 'original method', duration: '1 year', coverage: 'parts+labor', coverage_exclusions: '  ',
            };
            expect(contract.renderPolicyParts(policy)).toEqual([
                'stance: conditional', 'window: 30 days', 'conditions: sealed',
                'process: original method', 'duration: 1 year', 'coverage: parts+labor',
            ]);
        });
    });
});
