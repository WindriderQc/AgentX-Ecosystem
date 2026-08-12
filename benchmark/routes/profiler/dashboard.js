const express = require('express');
const router = express.Router();
const modelProfileService = require('../../src/services/profiler/modelProfileService');
const hostProfileService = require('../../src/services/profiler/hostProfileService');

router.get('/dashboard', async (req, res) => {
  try {
    const [hosts, funnel, stale, benchmarkedModels] = await Promise.all([
      hostProfileService.getAll(),
      modelProfileService.getReadinessFunnel(),
      modelProfileService.getStalenessReport(),
      modelProfileService.getBenchmarkedModelNames()
    ]);
    const adjustedFunnel = {
      ...funnel,
      benchmarked: Math.max(Number(funnel?.benchmarked) || 0, benchmarkedModels.length)
    };
    res.json({ status: 'success', data: { hosts, funnel: adjustedFunnel, staleProfiles: stale, benchmarkedModels } });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});
module.exports = router;
