const { Product, ProductVariant, Category, Shop, UserShop } = require('../entities');
const crypto = require('crypto');
const { AppError } = require('../../utils/AppError');
const { sequelize } = require('../../utils/database/database-setup');
const { Op } = require('sequelize');
const subscriptionService = require('../subscription/subscription.service');
const { createLogger } = require('../../utils/structured-logger');
const { queueProductProcessing } = require('./product-ai.service');
const { embedProduct, removeProductEmbedding } = require('./product-embedding.service');
const { removeProductIndex: removeClipIndex } = require('./clip-client.service');
const {
    getProductMediaPaths,
    removeUnreferencedProductMedia,
} = require('./product-media.service');
const { HTTP_STATUS } = require('../../constants/http-status');

// Module-level logger for fire-and-forget side effects (embedding upserts).
// Without this, a throw inside the detached setImmediate vanished silently —
// leaving products un-embedded with no trace.
const moduleLogger = createLogger('ProductService');

// Fields that must always come from the authenticated request context
// (JWT shopId, route params, or Sequelize itself) and never from
// client-supplied body data. The Joi schemas for create/update intentionally
// end in `.unknown(true)` to stay lenient for the growing set of AI/import
// fields on this resource, which means a client can smuggle any of these
// through validation — e.g. a `shop_id` in the body would otherwise let a
// user of Shop A create or move a product into Shop B. Stripping them here,
// at the single choke point both the RESTful and legacy routes funnel
// through, closes that off regardless of what the validator allows.
const SERVER_OWNED_PRODUCT_FIELDS = ['shop_id', 'shopId', 'id', 'created_at', 'updated_at', 'createdAt', 'updatedAt'];

const stripServerOwnedFields = (data = {}) => {
    const sanitized = { ...data };
    for (const field of SERVER_OWNED_PRODUCT_FIELDS) {
        delete sanitized[field];
    }
    return sanitized;
};

// Atomic stock update utility
const updateProductStock = async (shopId, sku, delta, transaction = null) => {
    // Find product by shop and SKU
    const product = await Product.findOne({
        where: { shop_id: shopId, sku },
        transaction
    });
    if (!product) throw new AppError('Product not found', HTTP_STATUS.NOT_FOUND);
    // Use atomic increment/decrement
    await product.increment('quantity', { by: delta, transaction });
    return product.reload({ transaction });
};
// Cursor pagination for products
const getProductsCursor = async (shopId, cursor = null, limit = 10, filters = {}) => {
    const whereClause = { shop_id: shopId };
    // Apply filters (name, category, etc.)
    if (filters.search) {
        whereClause[Op.or] = [
            { name: { [Op.like]: `%${filters.search}%` } },
            { description: { [Op.like]: `%${filters.search}%` } },
            { sku: { [Op.like]: `%${filters.search}%` } }
        ];
    }
    if (filters.category_id) whereClause.category_id = filters.category_id;
    if (filters.is_active !== undefined) whereClause.is_active = filters.is_active;
    if (cursor) whereClause.id = { [Op.lt]: cursor };
    const products = await Product.findAll({
        where: whereClause,
        order: [['id', 'DESC']],
        limit
    });
    return products;
};

const MAX_EXTRACT_ROWS = 200;
const HEADER_ALIASES = {
    name: ['name', 'product', 'product_name', 'title', 'product_title'],
    sku: ['sku', 'code', 'product_code', 'item_code'],
    price: ['price', 'unit_price', 'selling_price', 'sale_price'],
    category: ['category', 'category_name'],
    description: ['description', 'desc', 'details'],
    tags: ['tags', 'keywords'],
    variants: ['variants', 'options'],
    quantity: ['quantity', 'qty', 'stock'],
    brand: ['brand'],
    weight: ['weight'],
    weight_unit: ['weight_unit', 'weight unit', 'unit']
};

const normalizeHeader = (value) => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const mapHeaderToField = (header) => {
    const normalized = normalizeHeader(header);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (aliases.some(alias => normalizeHeader(alias) === normalized)) {
            return field;
        }
    }
    return null;
};

const parseDelimitedLine = (line, delimiter) => {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    result.push(current.trim());
    return result;
};

const parseDelimited = (content, delimiter = ',') => {
    const lines = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return { headers: [], rows: [] };
    }

    const rawHeaders = parseDelimitedLine(lines[0], delimiter);
    const headers = rawHeaders.map(mapHeaderToField);
    const rows = lines.slice(1).map(line => parseDelimitedLine(line, delimiter));

    return { headers, rows };
};

const parseTags = (value) => {
    if (!value) return [];
    return value
        .split(/[,;|]/)
        .map(tag => tag.trim())
        .filter(Boolean);
};

const parseVariants = (value) => {
    if (!value) return [];
    return value
        .split(/[,;|]/)
        .map(variant => variant.trim())
        .filter(Boolean);
};

const parsePrice = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value).replace(/[^0-9.]/g, '');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
};

const calculateConfidence = (product) => {
    let score = 0.4;
    if (product.name) score += 0.2;
    if (product.price && product.price > 0) score += 0.2;
    if (product.sku) score += 0.1;
    if (product.category) score += 0.1;
    return Math.min(score, 0.99);
};

/**
 * Verify user has access to shop
 */
const verifyShopAccess = async (userId, shopId) => {
    const userShop = await UserShop.findOne({
        where: {
            user_id: userId,
            shop_id: shopId,
            is_active: true
        }
    });

    if (!userShop) {
        throw new AppError('You do not have access to this shop', HTTP_STATUS.FORBIDDEN);
    }

    return userShop;
};

/**
 * Create a new product
 * CRITICAL: Tracks usage for billing on successful creation
 */
const createProduct = async (userId, shopId, productData, requestId = null) => {
    const logger = createLogger(requestId, shopId, userId);

    // SECURITY: strip shop_id/id/timestamps from client input before they can
    // reach Product.create — see SERVER_OWNED_PRODUCT_FIELDS above.
    productData = stripServerOwnedFields(productData);

    // Verify shop access
    await verifyShopAccess(userId, shopId);

    // Handle track_quantity: if not tracking, clear quantity
    if (productData.track_quantity === false) {
        productData.quantity = 0;
    }

    // Verify category exists if provided
    if (productData.category_id) {
        const category = await Category.findOne({
            where: {
                id: productData.category_id,
                shop_id: shopId
            }
        });

        if (!category) {
            throw new AppError('Category not found', HTTP_STATUS.NOT_FOUND);
        }
    }

    const transaction = await sequelize.transaction();
    let committed = false;
    const newMediaPaths = getProductMediaPaths(productData.images, productData.image_url, shopId);
    
    try {
        // Create product within transaction.
        // shop_id is spread last so it always wins over any stray client value
        // that survives stripServerOwnedFields above (defense in depth).
        const product = await Product.create({
            ...productData,
            shop_id: shopId
        }, { transaction });

        // Commit transaction - NOW product is persisted
        await transaction.commit();
        committed = true;

        // ATOMIC: Track usage ONLY after successful DB commit
        // Uses transaction-safe idempotent tracking with request_id
        // Usage increments ONLY on successful database persistence
        try {
            const usageResult = await subscriptionService.trackUsage(
                shopId,
                'products',
                1,
                requestId, // Request-scoped idempotency key - prevents double counting
                {
                    resourceId: product.id,
                    productName: product.name,
                    sku: product.sku
                }
            );
            
            logger.logUsage('product_created', shopId, userId, {
                productId: product.id,
                productName: product.name,
                sku: product.sku,
                transactionId: usageResult.transactionId,
                isRetry: usageResult.isRetry
            });
        } catch (usageError) {
            // CRITICAL errors: usage_limit_exceeded, validation errors
            if (usageError.code === 'USAGE_LIMIT_EXCEEDED') {
                logger.error('Usage limit exceeded on product', usageError, { severity: 'critical' });
                throw usageError;
            }
            
            // Non-critical errors: transient tracking issues don't fail product
            logger.error('Failed to track product usage', usageError, {
                productId: product.id,
                severity: 'warning'
            });
        }

        // Queue async AI image processing (fire-and-forget, non-blocking)
        queueProductProcessing(product.id, shopId);

        // Fetch product with category
        return await getProductById(product.id, userId, shopId);
    } catch (error) {
        try { await transaction.rollback(); } catch (_) { /* already committed */ }
        if (!committed && newMediaPaths.length > 0) {
            await removeUnreferencedProductMedia({ shopId, images: newMediaPaths });
        }
        throw error;
    }
};

/**
 * Update a product
 */
const updateProduct = async (productId, userId, shopId, updateData) => {
    // SECURITY: strip shop_id/id/timestamps from client input before they can
    // reach product.update — otherwise a client could move a product it owns
    // into a different shop, or overwrite its primary key, by including
    // shop_id/id in the PATCH body. See SERVER_OWNED_PRODUCT_FIELDS above.
    updateData = stripServerOwnedFields(updateData);

    // Verify shop access
    await verifyShopAccess(userId, shopId);

    // Find product
    const product = await Product.findOne({
        where: {
            id: productId,
            shop_id: shopId
        }
    });

    if (!product) {
        throw new AppError('Product not found', HTTP_STATUS.NOT_FOUND);
    }

    // Handle track_quantity: if not tracking, clear quantity
    if (updateData.track_quantity === false) {
        updateData.quantity = 0;
    }

    // Verify category exists if being updated
    if (updateData.category_id) {
        const category = await Category.findOne({
            where: {
                id: updateData.category_id,
                shop_id: shopId
            }
        });

        if (!category) {
            throw new AppError('Category not found', HTTP_STATUS.NOT_FOUND);
        }
    }

    // Phase 1 D4: stock-change audit instrumentation needs the pre-update
    // snapshot; captured here, used only AFTER the update persists.
    const previousStockSnapshot = {
        quantity: product.quantity,
        track_quantity: product.track_quantity,
    };

    const previousMediaPaths = getProductMediaPaths(product.images, product.image_url, shopId);
    const nextMediaPaths = getProductMediaPaths(
        updateData.images !== undefined ? updateData.images : product.images,
        updateData.image_url !== undefined ? updateData.image_url : product.image_url,
        shopId
    );

    // Update product. If persistence fails, any newly uploaded but now
    // unreferenced local media is removed immediately; the nightly sweep is
    // the retry path for filesystem failures.
    try {
        await product.update(updateData);
    } catch (error) {
        if (nextMediaPaths.length > 0) {
            await removeUnreferencedProductMedia({ shopId, images: nextMediaPaths });
        }
        throw error;
    }

    // Phase 1 D4 (doc 05 §4): ADDITIVE best-effort audit when this update
    // touched stock (quantity/track_quantity or a variants blob). Mirrors the
    // mobile vocabulary (PRODUCT_STOCK_UPDATED on resource 'product').
    // Observability only — an audit failure NEVER changes the update outcome
    // (required:false + try/catch; the update has already persisted here).
    const stockFieldsChanged = ['quantity', 'track_quantity', 'product_variants', 'variants']
        .some((key) => Object.prototype.hasOwnProperty.call(updateData, key));
    if (stockFieldsChanged) {
        try {
            const AuditService = require('../audit/audit.service');
            await AuditService.logOperation({
                userId,
                shopId,
                action: 'PRODUCT_STOCK_UPDATED',
                resourceType: 'product',
                resourceId: product.id,
                metadata: {
                    source: 'WEB',
                    sku: product.sku ?? null,
                    previous_quantity: previousStockSnapshot.quantity ?? null,
                    next_quantity: product.quantity ?? null,
                    previous_track_quantity: previousStockSnapshot.track_quantity ?? null,
                    next_track_quantity: product.track_quantity ?? null,
                },
            }, { required: false }).catch(() => {});
        } catch (_) { /* audit is best-effort; the update already succeeded */ }
    }

    const removedMediaPaths = previousMediaPaths.filter((item) => !nextMediaPaths.includes(item));
    if (removedMediaPaths.length > 0) {
        setImmediate(() => removeUnreferencedProductMedia({
            shopId,
            images: removedMediaPaths,
        }).catch((err) => moduleLogger.error('Product media cleanup after update failed', err, { shopId, productId })));
    }

    const imagesChanged = updateData.images !== undefined || updateData.image_url !== undefined;
    if (imagesChanged) {
        // Images changed: re-run full vision pipeline (extracts ai_* attributes + re-embeds)
        queueProductProcessing(productId, shopId);
    } else {
        // Text/price/category/tag changes: re-embed immediately so vector store stays current
        setImmediate(() => embedProduct(productId, shopId).catch(
            (err) => moduleLogger.error('Re-embed after update threw', err, { productId, shopId })
        ));
    }

    // Fetch updated product with category
    return await getProductById(productId, userId, shopId);
};

/**
 * Delete a product
 */
const deleteProduct = async (productId, userId, shopId) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    // Find product
    const product = await Product.findOne({
        where: {
            id: productId,
            shop_id: shopId
        }
    });

    if (!product) {
        throw new AppError('Product not found', HTTP_STATUS.NOT_FOUND);
    }

    const mediaPaths = getProductMediaPaths(product.images, product.image_url, shopId);

    // Delete product
    await product.destroy();

    if (mediaPaths.length > 0) {
        await removeUnreferencedProductMedia({ shopId, images: mediaPaths });
    }

    // Remove from vector store and CLIP cache (fire-and-forget)
    setImmediate(() => removeProductEmbedding(productId, shopId));
    setImmediate(() => removeClipIndex(productId, shopId));

    return { message: 'Product deleted successfully' };
};

/**
 * Get a single product by ID
 */
const getProductById = async (productId, userId, shopId) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    const product = await Product.findOne({
        where: {
            id: productId,
            shop_id: shopId
        },
        // Bug #5: include relational variants instead of relying on JSON blob
        include: [
            {
                model: ProductVariant,
                as: 'product_variants',
                where: { is_active: true },
                required: false,
                order: [['created_at', 'ASC']]
            }
        ]
    });

    if (!product) {
        throw new AppError('Product not found', HTTP_STATUS.NOT_FOUND);
    }

    const productData = product.toJSON ? product.toJSON() : product;
    return productData;
};

/**
 * List all products for a shop with filters
 */
const listProducts = async (userId, shopId, filters = {}) => {
    // Verify shop access
    await verifyShopAccess(userId, shopId);

    // Build where clause
    const whereClause = {
        shop_id: shopId
    };

    // Add search filter (search in name, description, and SKU)
    if (filters.search) {
        whereClause[Op.or] = [
            { name: { [Op.like]: `%${filters.search}%` } },
            { description: { [Op.like]: `%${filters.search}%` } },
            { sku: { [Op.like]: `%${filters.search}%` } }
        ];
    }

    // Add category filter
    if (filters.category_id) {
        whereClause.category_id = filters.category_id;
    }

    // Add status filter
    if (filters.is_active !== undefined) {
        whereClause.is_active = filters.is_active;
    }

    // Add price range filter
    if (filters.min_price !== undefined || filters.max_price !== undefined) {
        whereClause.price = {};

        if (filters.min_price !== undefined) {
            whereClause.price[Op.gte] = filters.min_price;
        }

        if (filters.max_price !== undefined) {
            whereClause.price[Op.lte] = filters.max_price;
        }
    }

    // Get all products with filters
    // Bug #5: also include relational variants
    const products = await Product.findAll({
        where: whereClause,
        include: [
            {
                model: Category,
                as: 'category_ref',
                attributes: ['id', 'name']
            },
            {
                model: ProductVariant,
                as: 'product_variants',
                where: { is_active: true },
                required: false
            }
        ],
        order: [
            ['created_at', 'DESC']
        ]
    });

    // Map products to include category name and status string
    const mappedProducts = products.map(product => {
        const productData = product.toJSON();
        return {
            ...productData,
            category: productData.category_ref?.name || null,
            status: productData.is_active ? 'active' : 'inactive'
        };
    });

    return mappedProducts;
};

/**
 * V2: Search products with filters
 */
const searchProducts = async (userId, shopId, payload = {}) => {
    await verifyShopAccess(userId, shopId);

    const whereClause = {
        shop_id: shopId
    };

    if (payload.query) {
        whereClause[Op.or] = [
            { name: { [Op.iLike]: `%${payload.query}%` } },
            { description: { [Op.iLike]: `%${payload.query}%` } },
            { category: { [Op.iLike]: `%${payload.query}%` } }
        ];
    }

    if (payload.filters) {
        const { category, min_price, max_price, in_stock } = payload.filters;
        if (category) {
            whereClause.category = category;
        }
        if (in_stock !== undefined) {
            whereClause.in_stock = in_stock;
        }
        if (min_price !== undefined || max_price !== undefined) {
            whereClause.price = {};
            if (min_price !== undefined) {
                whereClause.price[Op.gte] = min_price;
            }
            if (max_price !== undefined) {
                whereClause.price[Op.lte] = max_price;
            }
        }
    }

    const limit = Number(payload.limit || 10);

    const products = await Product.findAll({
        where: whereClause,
        order: [['created_at', 'DESC']],
        limit
    });

    return products;
};

/**
 * Detects the delimiter based on filename and content type
 * @param {string} filename - Name of the uploaded file
 * @param {string} contentType - MIME type of the content
 * @returns {string} The detected delimiter (tab or comma)
 */
const detectDelimiter = (filename, contentType) => {
    const lowerName = filename.toLowerCase();
    const isTsv = lowerName.endsWith('.tsv') || contentType === 'text/tab-separated-values';
    return isTsv ? '\t' : ',';
};

/**
 * Validates that required columns are present in the headers
 * @param {string[]} headers - Array of column headers
 * @throws {AppError} If required columns are missing
 */
const validateRequiredColumns = (headers) => {
    const mappedFields = headers.filter(Boolean);

    if (!mappedFields.includes('name')) {
        throw new AppError(
            'CSV is missing a required "name" column. Accepted aliases: name, product, product_name, title.',
            HTTP_STATUS.BAD_REQUEST
        );
    }

    if (!mappedFields.includes('price')) {
        throw new AppError(
            'CSV is missing a required "price" column. Accepted aliases: price, unit_price, selling_price, sale_price.',
            HTTP_STATUS.BAD_REQUEST
        );
    }
};

/**
 * Creates an empty product object with default values
 * @returns {Object} Empty product object
 */
const createEmptyProduct = () => ({
    id: crypto.randomUUID(),
    name: null,
    sku: null,
    price: null,
    category: null,
    description: null,
    tags: [],
    variants: [],
    quantity: null,
    brand: null,
    weight: null,
    weight_unit: null
});

/**
 * Applies a single field value to a product object
 * @param {Object} product - Product object to update
 * @param {string} field - Field name
 * @param {*} value - Field value
 */
const applyFieldValue = (product, field, value) => {
    if (value === undefined || value === null || value === '') return;

    const fieldParsers = {
        tags: parseTags,
        variants: parseVariants,
        price: parsePrice,
        weight: parsePrice,
        quantity: (v) => Number.parseInt(String(v), 10),
        weight_unit: (v) => String(v).trim().toLowerCase(),
        default: (v) => String(v).trim()
    };

    const parser = fieldParsers[field] || fieldParsers.default;
    product[field] = parser(value);
};

/**
 * Validates a single product row
 * @param {Object} product - Product to validate
 * @param {number} rowIndex - Row index for error reporting
 * @returns {Object|null} Error object if invalid, null if valid
 */
const validateProductRow = (product, rowIndex) => {
    if (!product.name) {
        return { row: rowIndex, error: 'Missing product name' };
    }

    if (product.price !== null && (product.price < 0 || !Number.isFinite(product.price))) {
        return { row: rowIndex, error: `Invalid price "${product.price}" — must be a positive number` };
    }

    return null;
};

/**
 * Builds a product object from a row of data
 * @param {string[]} row - Row data array
 * @param {string[]} headers - Column headers
 * @returns {Object} Built product object
 */
const buildProductFromRow = (row, headers) => {
    const product = createEmptyProduct();

    headers.forEach((field, index) => {
        if (!field) return;
        applyFieldValue(product, field, row[index]);
    });

    return product;
};

/**
 * Creates a processed product with metadata
 * @param {Object} product - Base product object
 * @returns {Object} Product with metadata
 */
const createProcessedProduct = (product) => ({
    ...product,
    status: 'pending',
    ai_generated: true,
    confidence: calculateConfidence(product),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
});

/**
 * Extract products from uploaded content without persisting
 * Refactored to reduce complexity - orchestration only
 */
const extractProductsFromContent = async (userId, shopId, payload) => {
    await verifyShopAccess(userId, shopId);

    const { content, filename = '', content_type = '' } = payload;
    const delimiter = detectDelimiter(filename, content_type);

    if (!content) {
        throw new AppError('Unsupported or empty content for extraction.', HTTP_STATUS.BAD_REQUEST);
    }

    const { headers, rows } = parseDelimited(content, delimiter);
    if (headers.length === 0 || rows.length === 0) {
        throw new AppError('No tabular data found in the uploaded file.', HTTP_STATUS.BAD_REQUEST);
    }

    validateRequiredColumns(headers);

    const products = [];
    let skipped = 0;
    const rowErrors = [];
    const limitedRows = rows.slice(0, MAX_EXTRACT_ROWS);

    for (const row of limitedRows) {
        const rowIndex = limitedRows.indexOf(row) + 2; // +1 header, +1 for 1-based display
        const product = buildProductFromRow(row, headers);

        const error = validateProductRow(product, rowIndex);
        if (error) {
            skipped += 1;
            rowErrors.push(error);
            continue;
        }

        products.push(createProcessedProduct(product));
    }

    return {
        products,
        stats: {
            total: rows.length,
            parsed: products.length,
            skipped,
            rowErrors: rowErrors.length > 0 ? rowErrors : undefined
        }
    };
};

/**
 * B4: Bulk update products — price, status, is_active.
 * Only updates products belonging to the given shopId.
 *
 * @param {string} shopId
 * @param {string[]} productIds
 * @param {object} updates - may contain: price, status, is_active
 * @returns {{ updated: number }}
 */
const bulkUpdateProducts = async (shopId, productIds, updates) => {
    if (!Array.isArray(productIds) || productIds.length === 0) {
        throw new AppError('productIds must be a non-empty array', HTTP_STATUS.BAD_REQUEST);
    }

    const ALLOWED_FIELDS = ['price', 'status', 'is_active'];
    const safeUpdates = {};
    for (const field of ALLOWED_FIELDS) {
        if (updates[field] !== undefined) {
            safeUpdates[field] = updates[field];
        }
    }

    if (Object.keys(safeUpdates).length === 0) {
        throw new AppError('No valid update fields provided. Allowed: price, status, is_active', HTTP_STATUS.BAD_REQUEST);
    }

    const [updatedCount] = await Product.update(safeUpdates, {
        where: {
            id: { [Op.in]: productIds },
            shop_id: shopId
        }
    });

    // Re-embed affected products so vector store reflects updated name/price/status
    if (updatedCount > 0) {
        setImmediate(async () => {
            for (const productId of productIds) {
                await embedProduct(productId, shopId).catch(
                    (err) => moduleLogger.error('Bulk re-embed threw', err, { productId, shopId })
                );
            }
        });
    }

    return { updated: updatedCount };
};

module.exports = {
    createProduct,
    updateProduct,
    deleteProduct,
    getProductById,
    listProducts,
    searchProducts,
    verifyShopAccess,
    extractProductsFromContent,
    bulkUpdateProducts
};
