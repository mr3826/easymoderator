const knowledgeService = require('./knowledge.service');

const getKnowledge = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.getKnowledge(userId, shopId);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const updateBusinessInfo = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.updateBusinessInfo(userId, shopId, req.body);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const updateBrandingRules = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.updateBrandingRules(userId, shopId, req.body || {});
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const listFaqs = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.listFaqs(userId, shopId);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const createFaq = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.createFaq(userId, shopId, req.body);
        res.status(201).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const updateFaq = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.updateFaq(userId, shopId, req.params.id, req.body);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const deleteFaq = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.deleteFaq(userId, shopId, req.params.id);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

// ── FAQ lifecycle endpoints (20261126_001) ────────────────────────────────────
// Every response serializes the fresh row: sync_status 'pending' means
// SAVED — the UI must not present it as synchronized (settled states arrive
// via the next list read).

const archiveFaq = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.archiveFaq(userId, shopId, req.params.id);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const restoreFaq = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.restoreFaq(userId, shopId, req.params.id);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const resyncFaq = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.resyncFaq(userId, shopId, req.params.id);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const listGaps = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.listGaps(userId, shopId);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const listDocuments = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.listDocuments(userId, shopId);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const createDocument = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.createDocument(userId, shopId, req.body);
        res.status(201).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const deleteDocument = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const data = await knowledgeService.deleteDocument(userId, shopId, req.params.id);
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

const searchFaq = async (req, res, next) => {
    try {
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const answers = await knowledgeService.searchFaq(userId, shopId, req.body);
        res.status(200).json({ success: true, data: answers, total: answers.length });
    } catch (error) {
        next(error);
    }
};

const getPolicies = async (req, res, next) => {
    try {
        // Always scope to the authenticated shop — ignore URL params to prevent confused-deputy attacks
        const { shopId, userId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const policies = await knowledgeService.getShopPolicies(userId, shopId);
        res.status(200).json({ success: true, data: policies });
    } catch (error) {
        next(error);
    }
};

const normalizeLanguage = async (req, res, next) => {
    try {
        const result = await knowledgeService.normalizeLanguage(req.body);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

const cacheLanguageLearning = async (req, res, next) => {
    try {
        const result = await knowledgeService.cacheLanguageLearning(req.body);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

// Fix #5: shopId ALWAYS from req.user — never from request body
const queryKnowledge = async (req, res, next) => {
    try {
        const { shopId } = req.user;
        if (!shopId) {
            return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No shop selected. Please login again.' } });
        }
        const result = await knowledgeService.queryKnowledge(shopId, req.body);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getKnowledge,
    updateBusinessInfo,
    updateBrandingRules,
    listFaqs,
    createFaq,
    updateFaq,
    archiveFaq,
    restoreFaq,
    resyncFaq,
    deleteFaq,
    listGaps,
    listDocuments,
    createDocument,
    deleteDocument,
    searchFaq,
    getPolicies,
    normalizeLanguage,
    cacheLanguageLearning,
    queryKnowledge
};
