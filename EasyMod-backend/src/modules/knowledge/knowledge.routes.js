const express = require('express');
const knowledgeController = require('./knowledge.controller');
const knowledgeValidator = require('./knowledge.validator');
const { validate } = require('../helpers');
const { authenticate } = require('../../middleware/auth.middleware');
const { requirePlatformAdmin } = require('../../middleware/platform-admin.middleware');
const { requireOwner } = require('../../middleware/shop-permission.middleware');

const router = express.Router();

router.use(authenticate);

router.get('/', validate(knowledgeValidator.getKnowledge), knowledgeController.getKnowledge);
// Business info is managed via PUT /shop/business-info — keeping GET /knowledge/ as the read endpoint.
router.put('/branding', validate(knowledgeValidator.updateBrandingRules), knowledgeController.updateBrandingRules);
router.post('/faq/search', knowledgeController.searchFaq);
router.get('/shop-settings/:shopId/policies', knowledgeController.getPolicies);
router.post('/language/normalize', knowledgeController.normalizeLanguage);
// Writing to the shared Banglish dictionary is restricted to admins to prevent poisoning.
router.post('/language/cache-learning', requirePlatformAdmin(), knowledgeController.cacheLanguageLearning);
router.post('/query', knowledgeController.queryKnowledge);

router.get('/faqs', knowledgeController.listFaqs);
router.post('/faqs', validate(knowledgeValidator.createFaq), knowledgeController.createFaq);
router.patch('/faqs/:id', validate(knowledgeValidator.updateFaq), knowledgeController.updateFaq);
// Lifecycle transitions (A5 contract). Hard delete stays owner-only and
// removes the vector point; resync is owner-only (operational action).
// archive/restore are member-level like content edits.
router.post('/faqs/:id/archive', validate(knowledgeValidator.faqId), knowledgeController.archiveFaq);
router.post('/faqs/:id/restore', validate(knowledgeValidator.faqId), knowledgeController.restoreFaq);
router.post('/faqs/:id/resync', validate(knowledgeValidator.faqId), requireOwner, knowledgeController.resyncFaq);
router.delete('/faqs/:id', validate(knowledgeValidator.deleteFaq), requireOwner, knowledgeController.deleteFaq);

router.get('/gaps', knowledgeController.listGaps);

// Pilot+ P+05 — knowledge gap suggestions (platform-flag gated, default off).
const gapController = require('./gap-suggestions.controller');
router.get('/gap-suggestions', gapController.requireSuggestionsEnabled, gapController.list);
router.post('/gap-suggestions/:id/review', gapController.requireSuggestionsEnabled, gapController.review);
router.post('/gap-suggestions/:id/dismiss', gapController.requireSuggestionsEnabled, gapController.dismiss);
router.post('/gap-suggestions/:id/publish', gapController.requireSuggestionsEnabled, gapController.publish);

router.get('/documents', knowledgeController.listDocuments);
router.post('/documents', validate(knowledgeValidator.createDocument), knowledgeController.createDocument);
router.delete('/documents/:id', validate(knowledgeValidator.deleteDocument), knowledgeController.deleteDocument);

module.exports = router;
