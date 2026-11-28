const { randomUUID } = require('node:crypto');
const productService = require('./product.service');
const productLinkService = require('./product-link.service');
const upsellService = require('./product-upsell.service');
const stockExceptionsService = require('./product-stock-exceptions.service');
const productOverviewService = require('./product-overview.service');
const { HTTP_STATUS } = require('../../constants/http-status');
const { publicBaseUrl } = require('../../utils/image-upload.service');
const { storeProductImage } = require('./product-media.service');

// Matches the "PNG, JPG up to 5MB each" copy the Add Product form shows.
const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Helper: Returns a standard validation error response for missing shop
 * @returns {Object} Standard error response object
 */
const getNoShopError = () => ({
    success: false,
    error: {
        code: 'VALIDATION_ERROR',
        message: 'No shop selected. Please login again.'
    }
});

/**
 * Helper: Returns a standard validation error response with custom message
 * @param {string} message - Custom error message
 * @returns {Object} Standard error response object
 */
const getValidationError = (message) => ({
    success: false,
    error: {
        code: 'VALIDATION_ERROR',
        message
    }
});

const getProductCreateRequestId = (req) => {
    const rawKey = typeof req.get === 'function'
        ? req.get('Idempotency-Key')
        : req.headers?.['idempotency-key'];
    const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (idempotencyKey.length > 128) return { error: 'Idempotency-Key must be 128 characters or fewer.' };
    return { requestId: idempotencyKey || req.id || req.requestId || randomUUID() };
};

/**
 * RESTful: Get products with pagination and filters
 */
const getProducts = async (req, res, next) => {
    try {
        const { userId, shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const options = req.query; // Already validated
        const result = await productService.listProducts(userId, shopId, options);

        res.status(HTTP_STATUS.OK).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/product/stock-exceptions (Phase 1 C2, doc 05 §2).
 * Bounded, honest stock-exception counts for the nav badge, the BusinessHealth
 * tile and the /products?stock=exceptions seed. Read failures flow to the
 * error handler (5xx) so clients map null — never a fake zero.
 */
const getStockExceptions = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const data = await stockExceptionsService.getStockExceptions({ shopId });

        res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

/** GET /api/product/overview — tenant-scoped catalog and stock summary. */
const getOverview = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const data = await productOverviewService.getOverview({ shopId });
        res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Get product by ID
 */
const getProductById = async (req, res, next) => {
    try {
        const { userId, shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { id } = req.params; // Already validated
        const product = await productService.getProductById(id, userId, shopId);

        res.status(HTTP_STATUS.OK).json({
            success: true,
            data: product
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Create product
 */
const createProductRest = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { requestId, error: requestIdError } = getProductCreateRequestId(req);
        if (requestIdError) return res.status(HTTP_STATUS.BAD_REQUEST).json(getValidationError(requestIdError));

        const product = await productService.createProduct(
            req.user.userId,
            shopId,
            req.body, // Already validated
            requestId,
        );

        res.status(HTTP_STATUS.CREATED).json({
            success: true,
            data: product
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Update product by ID
 */
const updateProductById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { id } = req.params; // Already validated
        const product = await productService.updateProduct(
            id,
            req.user.userId,
            shopId,
            req.body // Already validated
        );

        res.status(HTTP_STATUS.OK).json({
            success: true,
            data: product
        });
    } catch (error) {
        next(error);
    }
};

/**
 * RESTful: Delete a product by ID
 */
const deleteProductById = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { id } = req.params; // Already validated
        const result = await productService.deleteProduct(
            id,
            req.user.userId,
            shopId
        );

        res.status(HTTP_STATUS.OK).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * AI: Extract products from uploaded content
 */
const extractProducts = async (req, res, next) => {
    try {
        const { userId, shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const result = await productService.extractProductsFromContent(
            userId,
            shopId,
            req.body
        );

        res.status(HTTP_STATUS.OK).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Legacy: Create a new product (for backward compatibility)
 */
const createProduct = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { requestId, error: requestIdError } = getProductCreateRequestId(req);
        if (requestIdError) return res.status(HTTP_STATUS.BAD_REQUEST).json(getValidationError(requestIdError));

        const product = await productService.createProduct(
            req.user.userId,
            shopId,
            req.body, // Already validated
            requestId,
        );

        res.status(HTTP_STATUS.CREATED).json({
            success: true,
            data: product
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Legacy: Update a product (for backward compatibility)
 */
const updateProduct = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { productId, ...updateData } = req.body;
        const product = await productService.updateProduct(
            productId,
            req.user.userId,
            shopId,
            updateData
        );

        res.status(HTTP_STATUS.OK).json({
            success: true,
            data: product
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Legacy: Delete a product (for backward compatibility)
 */
const deleteProduct = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { productId } = req.body;
        const result = await productService.deleteProduct(
            productId,
            req.user.userId,
            shopId
        );

        res.status(HTTP_STATUS.OK).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * V2: Product search
 */
const searchProducts = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const result = await productService.searchProducts(
            req.user.userId,
            shopId,
            req.body
        );

        res.status(HTTP_STATUS.OK).json({
            products: result,
            total: result.length,
            page: 1
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Legacy: Get a single product (for backward compatibility)
 */
const getProduct = async (req, res, next) => {
    try {
        const { userId, shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { productId } = req.query;
        const product = await productService.getProductById(
            productId,
            userId,
            shopId
        );

        res.status(HTTP_STATUS.OK).json({
            success: true,
            data: product
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Legacy: List products (for backward compatibility)
 */
const listProducts = async (req, res, next) => {
    try {
        const { userId, shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const options = req.query;
        const result = await productService.listProducts(userId, shopId, options);

        res.status(HTTP_STATUS.OK).json({
            success: true,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Detect product mentions in AI response text and return product cards.
 * POST /products/detect-mentions
 * Body: { text }
 */
const detectMentions = async (req, res, next) => {
    try {
        const { text } = req.body;
        const shopId = req.user?.shopId;

        if (!text) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getValidationError('text is required'));
        }

        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getValidationError('shopId is required'));
        }

        const result = await productLinkService.enrichResponseWithProductCards(text, shopId);

        res.status(HTTP_STATUS.OK).json({
            success: true,
            productCards: result.productCards
        });
    } catch (error) {
        next(error);
    }
};

/**
 * B4: Bulk update products — price, status, is_active.
 * PATCH /products/bulk
 * Body: { productIds: [], updates: { price?, status?, is_active? } }
 */
const bulkUpdateProducts = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { productIds, updates } = req.body;
        const result = await productService.bulkUpdateProducts(shopId, productIds, updates || {});

        res.status(HTTP_STATUS.OK).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /products/:productId/upsells
 * Return co-purchase upsell recommendations for a single product.
 */
const getProductUpsells = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }
        const { productId } = req.params;
        const limit = parseInt(req.query.limit, 10) || 3;
        const data = await upsellService.getCopurchasedProducts(shopId, productId, limit);
        res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /products/upsells
 * Return upsell recommendations for a set of products (e.g. cart).
 * Body: { productIds: [] }
 */
const getUpsellsForCart = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }
        const { productIds = [] } = req.body;
        if (!Array.isArray(productIds)) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getValidationError('productIds must be an array'));
        }
        const limit = parseInt(req.query.limit, 10) || 3;
        const data = await upsellService.getUpsellRecommendations(shopId, productIds, limit);
        res.status(HTTP_STATUS.OK).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

/**
 * Store one product image and return its public URL.
 * POST /products/images
 * Body: { image: "data:image/png;base64,..." }
 *
 * Deliberately not scoped to a product id: the Add Product form uploads while
 * the merchant is still filling it in, before any product row exists. The
 * returned URL is what the client then sends as `images[]` / `image_url` on
 * create or update.
 *
 * Abandoned form uploads are counted against the tenant quota until the
 * periodic orphan sweep removes them.
 */
const uploadProductImage = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getNoShopError());
        }

        const { image } = req.body;
        if (!image) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json(getValidationError('image is required'));
        }

        const { publicPath } = await storeProductImage({
            dataUrl: image,
            shopId,
            maxBytes: PRODUCT_IMAGE_MAX_BYTES,
        });

        res.status(HTTP_STATUS.CREATED).json({
            success: true,
            data: { url: `${publicBaseUrl(req)}${publicPath}` },
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    // RESTful methods
    getProducts,
    getProductById,
    createProductRest,
    uploadProductImage,
    updateProductById,
    deleteProductById,
    extractProducts,
    detectMentions,
    bulkUpdateProducts,
    getProductUpsells,
    getUpsellsForCart,
    getStockExceptions,
    getOverview,
    // Legacy methods (for backward compatibility)
    createProduct,
    updateProduct,
    deleteProduct,
    getProduct,
    listProducts,
    searchProducts
};
