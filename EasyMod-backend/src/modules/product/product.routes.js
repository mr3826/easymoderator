const express = require('express');
const productController = require('./product.controller');
const productValidator = require('./product.validator');
const { validate } = require('../helpers');
const { authenticate } = require('../../middleware/auth.middleware');

const router = express.Router();

// All product routes require authentication
router.use(authenticate);

// RESTful routes
router.get('/', validate(productValidator.getProducts), productController.getProducts);
router.post('/ai-extract', validate(productValidator.aiExtract), productController.extractProducts);
router.post('/search', productController.searchProducts);
router.post('/detect-mentions', productController.detectMentions);
// B4: Bulk update products — must be before /:id to avoid param capture
router.patch('/bulk', productController.bulkUpdateProducts);

// Image upload — must be before /:id to avoid param capture
router.post('/images', productController.uploadProductImage);

// Upsell routes — must be before /:id to avoid param capture
// POST /products/upsells — recommendations for a cart/set of products
router.post('/upsells', productController.getUpsellsForCart);
// GET /products/:productId/upsells — recommendations for a single product
router.get('/:productId/upsells', productController.getProductUpsells);

// Phase 1 C2: stock exceptions (doc 05 §2) — must be before /:id to avoid
// param capture. Same guard chain as the siblings (router-level authenticate;
// the global authenticated rate limiter applies; tenant scoping is the FIRST
// predicate inside the service).
router.get('/stock-exceptions', productController.getStockExceptions);

router.get('/:id', validate(productValidator.getProductById), productController.getProductById);
router.post('/', validate(productValidator.createProduct), productController.createProductRest);
router.patch('/:id', validate(productValidator.updateProduct), productController.updateProductById);
router.delete('/:id', validate(productValidator.deleteProduct), productController.deleteProductById);

// Legacy routes (for backward compatibility)
router.get('/list', validate(productValidator.getProducts), productController.listProducts);
router.get('/get', validate(productValidator.legacyGet), productController.getProduct);
router.post('/create', validate(productValidator.createProduct), productController.createProduct);
router.post('/update', validate(productValidator.legacyUpdate), productController.updateProduct);
router.post('/delete', validate(productValidator.legacyDelete), productController.deleteProduct);

module.exports = router;
