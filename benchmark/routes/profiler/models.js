const express = require('express');
const router = express.Router();
const ModelAdaptation = require('../../models/ModelAdaptation');
const modelProfileService = require('../../src/services/profiler/modelProfileService');
const adaptationService = require('../../src/services/profiler/adaptationService');
function validateHostId(hostId, res) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(String(hostId || ''))) return true;
  res.status(400).json({ status: 'error', error: 'Invalid Host ID format' });
  return false;
}

router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.stage) filter.stage = req.query.stage;
    res.json({ status: 'success', data: await modelProfileService.getAll(filter) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// ── Lineage Routes (must be before /:name) ──────────────────────────────────

router.get('/roots', async (req, res) => {
  try {
    const roots = await ModelAdaptation.aggregate([
      { $match: { 'lineage.rootModel': { $exists: true, $ne: null } } },
      { $group: {
        _id: '$lineage.rootModel',
        derivativeCount: { $sum: 1 },
        models: { $push: { modelName: '$modelName', hostId: '$hostId', quantization: '$lineage.quantization' } }
      }},
      { $project: { _id: 0, rootModel: '$_id', derivativeCount: 1, models: 1 } },
      { $sort: { rootModel: 1 } }
    ]);
    res.json({ status: 'success', data: roots });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:name/lineage', async (req, res) => {
  try {
    const docs = await ModelAdaptation.find(
      { modelName: req.params.name, lineage: { $exists: true } },
      { hostId: 1, lineage: 1, _id: 0 }
    ).lean();
    if (!docs.length) return res.status(404).json({ status: 'error', error: 'No lineage data found' });
    res.json({ status: 'success', data: docs });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:name', async (req, res) => {
  try {
    const model = await modelProfileService.getByName(req.params.name);
    if (!model) return res.status(404).json({ status: 'error', error: 'Model not found' });
    res.json({ status: 'success', data: model });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:name/config', async (req, res) => {
  try {
    const hostId = req.query.host;
    if (!hostId) return res.status(400).json({ status: 'error', error: 'host query param required' });
    if (!validateHostId(hostId, res)) return;
    const adaptation = await adaptationService.getAdaptation(req.params.name, hostId);
    if (!adaptation?.config) return res.status(404).json({ status: 'error', error: 'No adapted config found' });
    res.json({ status: 'success', data: { modelName: req.params.name, hostId, config: adaptation.config, adaptedName: adaptation.adaptedName } });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.put('/:name', async (req, res) => {
  try {
    const allowed = ['stage', 'hostId', 'sourceHost', 'readiness', 'profile', 'notes'];
    const update = { name: req.params.name };
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    res.json({ status: 'success', data: await modelProfileService.upsert(update) });
  }
  catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});
module.exports = router;
