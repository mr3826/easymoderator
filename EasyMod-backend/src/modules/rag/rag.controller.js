const ragService = require('./rag.service');
const { AppError } = require('../../utils/AppError');

const getAuthenticatedShopId = (req) => {
    const shopId = req.user?.shopId;
    if (!shopId) {
        throw new AppError('No shop selected. Please login again.', 400);
    }
    return shopId;
};

/**
 * Ingest data into RAG system
 */
const ingestData = async (req, res, next) => {
    try {
        const {
            data,
            content_type: contentType,
            collection_id: collectionId,
            metadata = {}
        } = req.body;
        const shopId = getAuthenticatedShopId(req);

        const result = await ragService.ingestData({
            text: data,
            metadata: {
                ...metadata,
                shopId,
                ...(contentType ? { contentType } : {}),
                ...(collectionId ? { collectionId } : {})
            }
        });

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Query RAG system
 */
const queryData = async (req, res, next) => {
    try {
        const shopId = getAuthenticatedShopId(req);
        const { query, limit, filters } = req.body;
        const result = await ragService.queryData({
            query,
            limit,
            filters,
            shopId
        });

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    ingestData,
    queryData
};
