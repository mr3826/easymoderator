'use strict';

const mockUserShop = { findOne: jest.fn() };
const mockRagService = { ingestData: jest.fn(), deletePoint: jest.fn(), queryData: jest.fn() };
const mockUpdateShopSettings = jest.fn();
let currentSettings;

jest.mock('../../entities', () => ({ Shop: {}, UserShop: mockUserShop, FaqResponse: {}, BanglishDictionary: {} }));
jest.mock('../../analytics/knowledge-gap.entity', () => ({}));
jest.mock('../../rag/rag.service', () => mockRagService);
jest.mock('../../shop/shop.service', () => ({
    updateShopSettingsPreservingRtoConsent: (...args) => mockUpdateShopSettings(...args),
}));
jest.mock('../../../utils/cache.service', () => ({}));
jest.mock('../../../utils/shop-settings-cache', () => ({
    MERCHANT_KNOWLEDGE_CACHE_KEY: 'knowledge:summary',
    AI_KNOWLEDGE_CACHE_KEY: 'knowledge:ai-summary',
    invalidateShopSettingsCaches: jest.fn(),
}));

const { createDocument } = require('../knowledge.service');

describe('knowledge RAG log redaction', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        currentSettings = { documents: [] };
        mockUserShop.findOne.mockResolvedValue({ id: 'user-shop-1', shop_id: 'shop-1' });
        mockUpdateShopSettings.mockImplementation(async (_shopId, patchBuilder) => {
            currentSettings = { ...currentSettings, ...patchBuilder(currentSettings) };
        });
    });

    afterEach(() => jest.restoreAllMocks());

    test('logs and stores only a safe error code when document ingestion fails', async () => {
        const sensitiveError = Object.assign(
            new Error('RAG response had Rahim 01711111111 at Mirpur with transcript and request body'),
            { code: 'UPSTREAM_TIMEOUT' },
        );
        mockRagService.ingestData.mockRejectedValueOnce(sensitiveError);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const document = await createDocument('user-1', 'shop-1', {
            name: 'supporting document',
            contentType: 'text/plain',
            size: 30,
            source: 'merchant',
            text: 'Private customer message is never logged.',
        });
        await new Promise(setImmediate);

        expect(warn).toHaveBeenCalledWith('RAG document ingest failed', {
            documentId: document.id,
            errorCode: 'UPSTREAM_TIMEOUT',
        });
        const logs = JSON.stringify(warn.mock.calls);
        expect(logs).not.toContain('01711111111');
        expect(logs).not.toContain('Mirpur');
        expect(logs).not.toContain('transcript');
        expect(logs).not.toContain('request body');
        expect(mockUpdateShopSettings).toHaveBeenLastCalledWith('shop-1', expect.any(Function));
        expect(currentSettings.documents[0]).toMatchObject({
            id: document.id,
            status: 'failed',
            error: 'UPSTREAM_TIMEOUT',
        });
    });
});
