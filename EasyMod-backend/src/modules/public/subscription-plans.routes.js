'use strict';

/**
 * Retired subscription catalog (ADR-0011, C1).
 *
 * The SHURU/GROWTH/PARTNER catalog is superseded in full by the delivered-order
 * commercial contract. The mount path is kept for one release so an old client
 * receives an explicit, machine-readable retirement instead of a 404 or - worse
 * - a second price authority.
 */

const express = require('express');

const router = express.Router();

const retired = (_req, res) => {
    res.status(410).json({
        success: false,
        code: 'CATALOG_RETIRED',
        message: 'The subscription catalog has been retired.',
        successor: '/api/public/commercial-contract',
    });
};

router.get('/', retired);
router.all('/', retired);

module.exports = router;