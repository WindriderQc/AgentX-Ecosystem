const express = require('express');
const router = express.Router();

// Sub-routers extracted from this file
router.use('/', require('./inference'));
router.use('/', require('./chat'));

module.exports = router;
