'use strict';

/**
 * Partner application route — RETIRED (ADR-0011).
 *
 * The tiered Partner programme no longer exists: every shop is on the single
 * delivered-order model, so there is nothing to apply for. The endpoint stays
 * mounted so old clients receive an explicit 410 instead of a silent 404, and
 * the partner_applications table is preserved for historical reads.
 */

const express = require('express');

const router = express.Router();

router.post('/apply', (req, res) => res.status(410).json({
    success: false,
    code: 'PARTNER_PROGRAMME_RETIRED',
    message: 'The Partner programme is retired. All shops are billed per delivered order.',
}));

module.exports = router;