const router = require('express').Router();
const { prepareQuickComparison } = require('../../src/services/benchmark/quickComparison');

router.post('/quick-comparison', async (req, res) => {
    try {
        res.json({ status: 'success', data: await prepareQuickComparison(req.body || {}) });
    } catch (error) {
        res.status(error.status || 503).json({ status: 'error', error: error.message });
    }
});

module.exports = router;
