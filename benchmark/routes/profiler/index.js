const express = require('express');
const router = express.Router();
router.use('/', require('./dashboard'));
router.use('/hosts', require('./hosts'));
router.use('/models', require('./models'));
router.use('/adapt', require('./adapt'));
router.use('/pipeline', require('./pipeline'));
router.use('/settings', require('./settings'));
module.exports = router;
