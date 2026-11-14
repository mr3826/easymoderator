'use strict';

/**
 * Partner Admin routes.
 *
 * ADR-0011 retired the Partner programme. Listing preserved applications stays
 * available as a historical read; approving one is refused with 410 Gone.
 *
 * Guarded by a shared-secret header (x-admin-key === process.env.ADMIN_API_KEY)
 * rather than the user session: there is no first-class admin role yet. If
 * ADMIN_API_KEY is not configured the endpoints return 503 (disabled) so they
 * can never be hit anonymously.
 */

const express = require('express');
const partnerService = require('./partner.service');

const router = express.Router();

const requireAdminKey = (req, res, next) => {
    const configured = process.env.ADMIN_API_KEY;
    if (!configured) {
        return res.status(503).json({ success: false, message: 'Admin API disabled (ADMIN_API_KEY not set)' });
    }
    if (req.get('x-admin-key') !== configured) {
        return res.status(401).json({ success: false, message: 'Invalid admin key' });
    }
    return next();
};

router.use(requireAdminKey);

// Historical read (optional ?status=pending|approved|rejected)
router.get('/applications', async (req, res) => {
    try {
        const apps = await partnerService.listApplications({ status: req.query.status });
        return res.json({ success: true, data: apps });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Retired: no shop is switched to a Partner plan any more.
router.post('/applications/:id/approve', (req, res) => res.status(410).json({
    success: false,
    code: partnerService.RETIRED_CODE,
    message: 'The Partner programme is retired. All shops are billed per delivered order.',
}));

module.exports = router;