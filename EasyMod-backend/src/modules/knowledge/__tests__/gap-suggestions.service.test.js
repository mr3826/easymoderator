'use strict';

/**
 * P+05 gap-suggestion lifecycle: deterministic grouping, dismissal cursor,
 * publish-through-existing-authority, shop scoping. No model calls anywhere.
 */

process.env.NODE_ENV = 'test';

jest.mock('../../../utils/database/database-setup', () => ({
    sequelize: { define: jest.fn(() => ({})) },
}));
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));

const mockFindOne = jest.fn();
const mockFindAll = jest.fn();
const mockCount = jest.fn();
const mockCreate = jest.fn();
jest.mock('../../knowledge/gap-suggestion.entity', () => ({
    findOne: (...a) => mockFindOne(...a),
    findAll: (...a) => mockFindAll(...a),
    create: (...a) => mockCreate(...a),
}));
jest.mock('../../entities', () => ({
    KnowledgeGap: { findAll: jest.fn(), count: (...a) => mockCount(...a) },
}));
jest.mock('../../knowledge/knowledge.service', () => ({
    createFaq: jest.fn(async (userId, shopId, faq) => ({ id: 4210, ...faq })),
}));

const { KnowledgeGap } = require('../../entities');
const gaps = require('../../knowledge/gap-suggestions.service');
const knowledgeService = require('../../knowledge/knowledge.service');

const gapRows = (rows) => rows.map((r, i) => ({
    id: r.id ?? i + 1,
    question: r.q,
    created_at: r.at || new Date('2026-10-24T08:00:00Z'),
}));

beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockResolvedValue(null);
    mockFindAll.mockResolvedValue([]);
    mockCount.mockResolvedValue(0);
    mockCreate.mockResolvedValue({ id: 'sug-1' });
});

describe('normalize + domain classification (deterministic)', () => {
    test('normalizes case, punctuation and spacing', () => {
        expect(gaps.normalizeQuestion('  Exchange??   Korte PARBO? ')).toBe('exchange korte parbo');
    });
    test.each([
        ['bkash number din', 'PAYMENT'],
        ['delivery charge koto', 'DELIVERY'],
        ['size 3 paba', 'PRODUCT'],
        ['exchange korte parbo', 'POLICY'],
        ['hello there', 'OTHER'],
    ])('routes "%s" to authoritative domain %s', (q, domain) => {
        expect(gaps.classifyDomain(gaps.normalizeQuestion(q))).toBe(domain);
    });
});

describe('computeForShop grouping', () => {
    test('creates a suggestion only for recurring groups (>= threshold), stores no raw ids beyond display sample', async () => {
        KnowledgeGap.findAll.mockResolvedValue(gapRows([
            { q: 'exchange korte parbo?' }, { q: 'Exchange korte parbo' }, { q: 'EXCHANGE  korte parbo !!' },
            { q: 'color change?' }, { q: 'color change' }, // only 2 -> below threshold
        ]));

        const res = await gaps.computeForShop('shop-1');
        expect(res.created).toBe(1);
        const created = mockCreate.mock.calls[0][0];
        expect(created.norm_question).toBe('exchange korte parbo');
        expect(created.evidence_count).toBe(3);
        expect(created.owner_domain).toBe('POLICY');
        expect(created.shop_id).toBe('shop-1');
    });

    test('updates the live row instead of duplicating', async () => {
        const live = { evidence_count: 3, evidence_cursor: 9, norm_question: 'x', update: jest.fn().mockResolvedValue(undefined) };
        mockFindOne.mockImplementation(async ({ where }) => (where.status ? live : null));
        KnowledgeGap.findAll.mockResolvedValue(gapRows([{ id: 1, q: 'x' }, { id: 2, q: 'x' }, { id: 3, q: 'x' }, { id: 12, q: 'x' }]));

        const res = await gaps.computeForShop('shop-1');
        expect(res.created).toBe(0);
        expect(live.update).toHaveBeenCalledWith(expect.objectContaining({ evidence_count: 4, evidence_cursor: 12 }));
    });

    test('dismissed group does NOT reappear without new evidence past the cursor', async () => {
        KnowledgeGap.findAll.mockResolvedValue(gapRows([{ id: 3, q: 'x' }, { id: 4, q: 'x' }, { id: 5, q: 'x' }]));
        const dismissed = { status: 'DISMISSED', norm_question: 'x', evidence_cursor: '5', update: jest.fn() };
        mockFindOne.mockImplementation(async ({ where }) => {
            if (where.status === 'DISMISSED') return dismissed;
            return null;
        });

        const res = await gaps.computeForShop('shop-1');
        expect(res.reopened).toBe(0);
        expect(dismissed.update).not.toHaveBeenCalled();
    });

    test('unrelated NEW questions elsewhere must NOT re-open a dismissed suggestion', async () => {
        KnowledgeGap.findAll.mockResolvedValue(gapRows([
            { id: 3, q: 'x' }, { id: 4, q: 'x' }, { id: 5, q: 'x' }, { id: 6, q: 'x' }, // 1 new past cursor 5
            { id: 7, q: 'y' }, { id: 8, q: 'y' }, { id: 9, q: 'y' },                    // new OTHER question
        ]));
        const dismissed = { status: 'DISMISSED', norm_question: 'x', evidence_cursor: '5', update: jest.fn() };
        mockFindOne.mockImplementation(async ({ where }) => (
            where.status === 'DISMISSED' && where.norm_question === 'x' ? dismissed : null
        ));

        const res = await gaps.computeForShop('shop-1');
        expect(res.reopened).toBe(0);
        expect(dismissed.update).not.toHaveBeenCalled();
        expect(res.created).toBe(1); // 'y' is a legitimately new recurring question
    });

    test('dismissed group re-opens only with >= threshold NEW rows FOR THE SAME QUESTION', async () => {
        KnowledgeGap.findAll.mockResolvedValue(gapRows([
            { id: 9, q: 'x' }, { id: 10, q: 'x' }, { id: 11, q: 'x' },
        ]));
        const dismissed = {
            status: 'DISMISSED', norm_question: 'x', evidence_cursor: '6',
            update: jest.fn().mockResolvedValue(undefined),
        };
        mockFindOne.mockImplementation(async ({ where }) => (where.status === 'DISMISSED' ? dismissed : null));

        const res = await gaps.computeForShop('shop-1');
        expect(res.reopened).toBe(1);
        expect(dismissed.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'OPEN' }));
    });
});

describe('merchant actions', () => {
    test('dismiss records the current evidence cursor (reason code stored)', async () => {
        const row = { norm_question: 'x', evidence_cursor: 0, update: jest.fn().mockResolvedValue(undefined) };
        mockFindOne.mockImplementation(async ({ where }) => (where.status && where.id ? row : null));
        KnowledgeGap.findAll.mockResolvedValue(gapRows([{ id: 77, q: 'x' }, { id: 78, q: 'x' }, { id: 79, q: 'x' }]));

        const ok = await gaps.dismiss('shop-1', 'sug-1', 'ALREADY_ANSWERED', 'user-1');
        expect(ok).toBe(true);
        expect(row.update).toHaveBeenCalledWith(expect.objectContaining({
            status: 'DISMISSED', dismissed_reason: 'ALREADY_ANSWERED', evidence_cursor: 79,
        }));
    });

    test('publishAnswer creates the FAQ via the EXISTING knowledge authority and links it', async () => {
        const row = { norm_question: 'x', status: 'OPEN', update: jest.fn().mockResolvedValue(undefined) };
        mockFindOne.mockResolvedValue(row);

        const faq = await gaps.publishAnswer('shop-1', 'user-1', 'sug-1', {
            question: 'Exchange policy?', answer: '7-day exchange on unused items.',
        });

        // A5 contract: publishing goes through the status machine explicitly —
        // 'published' is the only retrieval-eligible state. The legacy
        // is_active parameter is GONE from the call (service-owned mirror).
        const callArg = knowledgeService.createFaq.mock.calls[0][2];
        expect(knowledgeService.createFaq).toHaveBeenCalledWith('user-1', 'shop-1', expect.objectContaining({
            question: 'Exchange policy?', status: 'published',
        }));
        expect(callArg).not.toHaveProperty('is_active');
        expect(faq.id).toBe(4210);
        expect(row.update).toHaveBeenCalledWith(expect.objectContaining({
            status: 'PUBLISHED', resolved_faq_id: 4210,
        }));
    });

    test('listForShop routes structured domains to their authoritative settings, not FAQ prose', async () => {
        mockFindAll.mockResolvedValue([
            { id: 'a', display_question: 'bkash number?', owner_domain: 'PAYMENT', status: 'OPEN', evidence_count: 4, first_seen_at: new Date(), last_seen_at: new Date(), resolved_faq_id: null, published_at: null },
            { id: 'b', display_question: 'exchange?', owner_domain: 'POLICY', status: 'OPEN', evidence_count: 5, first_seen_at: new Date(), last_seen_at: new Date(), resolved_faq_id: null, published_at: null },
        ]);
        const rows = await gaps.listForShop('shop-1');
        expect(rows[0].authoritative_action).toBe('open_payment_settings');
        expect(rows[1].authoritative_action).toBe('author_faq');
    });
});
