const express = require('express');
const router = express.Router();
const { getUserId, getOrCreateProfile, saveProfile } = require('../src/helpers/userHelpers');

router.get('/', async (_req, res, next) => {
  try {
    const userId = getUserId(res);
    const profile = await getOrCreateProfile(userId);
    return res.json({ status: 'success', data: profile });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const userId = getUserId(res);
    const profile = await saveProfile(userId, req.body || {});
    return res.json({ status: 'success', data: profile });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
