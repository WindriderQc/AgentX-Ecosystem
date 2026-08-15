const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const { getUserId } = require('../src/helpers/userHelpers');
const logger = require('../config/logger');

// Sub-routers extracted from this file
router.use('/', require('./inference'));
router.use('/', require('./chat'));

// DEBUG: Temporary endpoint to inspect conversation
// SECURITY: Disabled in production, requires authentication
router.get('/debug/conversation/:id', async (req, res) => {
    try {
        // SECURITY: Disable in production
        if (process.env.NODE_ENV === 'production') {
            return res.status(404).json({ error: 'Not found' });
        }

        const mongoose = require('mongoose');

        // SECURITY: Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid conversation ID format' });
        }

        // SECURITY: Cast to ObjectId to prevent NoSQL injection
        const conv = await Conversation.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
        if (!conv) return res.status(404).json({ error: 'Not found' });

        const userId = getUserId(res);

        res.json({
            status: 'success',
            conversation: conv,
            context: {
                reqUserId: userId,
                matchUser: conv.userId === userId
            }
        });
    } catch (err) {
        logger.error('Debug endpoint error', { error: err.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
