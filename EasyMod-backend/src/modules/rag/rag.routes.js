const express = require('express');
const ragController = require('./rag.controller');
const { authenticate } = require('../../middleware/auth.middleware');
const { verifyShopAccess } = require('../../middleware/shop-access.middleware');
const { ingestDataValidator, queryDataValidator } = require('./rag.validator');
const validate = require('../../middleware/validate.middleware');

const router = express.Router();

// RAG stores merchant-domain data. Growth OS authentication alone is not merchant
// authorization, so require the JWT-selected shop membership before validation
// or any controller can reach the vector store.
router.use(authenticate);
router.use(verifyShopAccess);

// POST /rag/ingest - Ingest data into RAG system
router.post('/ingest', validate(ingestDataValidator), ragController.ingestData);

// POST /rag/query - Query RAG system
router.post('/query', validate(queryDataValidator), ragController.queryData);

module.exports = router;
