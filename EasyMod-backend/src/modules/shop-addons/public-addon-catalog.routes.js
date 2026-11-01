'use strict';

const express = require('express');
const { getPublicAddonCatalog } = require('./shop-addons.catalog');

const router = express.Router();
router.get('/', (_req, res) => res.json({ success: true, data: getPublicAddonCatalog() }));

module.exports = router;
