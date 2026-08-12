const express = require('express');
const router = express.Router();
const { getAdaptation, getAdaptedRoster, deployToHost, validateModelfile } = require('../../src/services/profiler/adaptationService');
const hostProfileService = require('../../src/services/profiler/hostProfileService');
const ModelAdaptation = require('../../models/ModelAdaptation');

function validateHostId(hostId, res) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(String(hostId || ''))) return true;
  res.status(400).json({ status: 'error', error: 'Invalid Host ID format' });
  return false;
}

router.get('/roster', async (req, res) => {
  try {
    const filter = {};
    if (req.query.hostId) filter.hostId = req.query.hostId;
    if (req.query.status) filter.status = req.query.status;
    res.json({ status: 'success', data: await getAdaptedRoster(filter) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:modelName/:hostId', async (req, res) => {
  try {
    if (!validateHostId(req.params.hostId, res)) return;
    const a = await getAdaptation(req.params.modelName, req.params.hostId);
    if (!a) return res.status(404).json({ status: 'error', error: 'Adaptation not found' });
    res.json({ status: 'success', data: a });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.post('/:modelName/:hostId/deploy', async (req, res) => {
  try {
    if (!validateHostId(req.params.hostId, res)) return;
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    const result = await deployToHost(req.params.modelName, req.params.hostId, host.hostUrl);
    if (!result?.success) return res.status(502).json({ status: 'error', error: result?.error || 'Deploy failed', data: result });
    res.json({ status: 'success', data: result });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// ── Validate Modelfile content ──────────────────────────────────────────────
router.post('/:modelName/:hostId/validate', async (req, res) => {
  try {
    if (!validateHostId(req.params.hostId, res)) return;
    const { content } = req.body;
    if (!content) return res.status(400).json({ status: 'error', error: 'Missing Modelfile content' });

    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });

    const result = await validateModelfile(content, host.hostUrl);
    res.json({ status: 'success', data: result });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// ── Remove adapted model from Ollama host ───────────────────────────────────
router.delete('/:modelName/:hostId/deploy', async (req, res) => {
  try {
    if (!validateHostId(req.params.hostId, res)) return;
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });

    const adaptation = await ModelAdaptation.findOne({
      modelName: req.params.modelName,
      hostId: req.params.hostId
    });
    if (!adaptation) return res.status(404).json({ status: 'error', error: 'Adaptation not found' });

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    try {
      await fetch(`${host.hostUrl}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: adaptation.adaptedName }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    adaptation.deployment.status = 'removed';
    await adaptation.save();

    res.json({ status: 'success', data: { removed: true, adaptedName: adaptation.adaptedName } });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// ── Deployment history ──────────────────────────────────────────────────────
router.get('/:modelName/:hostId/history', async (req, res) => {
  try {
    if (!validateHostId(req.params.hostId, res)) return;
    const adaptation = await getAdaptation(req.params.modelName, req.params.hostId);
    if (!adaptation) return res.status(404).json({ status: 'error', error: 'Adaptation not found' });

    const history = (adaptation.deployment?.history || []).slice(-10).reverse();
    res.json({ status: 'success', data: history });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// ── Export Modelfile as text download ────────────────────────────────────────
router.get('/:modelName/:hostId/export', async (req, res) => {
  try {
    if (!validateHostId(req.params.hostId, res)) return;
    const adaptation = await getAdaptation(req.params.modelName, req.params.hostId);
    if (!adaptation?.modelfile?.content) {
      return res.status(404).json({ status: 'error', error: 'No Modelfile content found' });
    }

    const filename = `${req.params.modelName.replace(/[/:]/g, '_')}_${req.params.hostId}.Modelfile`;
    res.set('Content-Type', 'text/plain');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(adaptation.modelfile.content);
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

module.exports = router;
