/**
 * Roundtable Routes
 *
 * POST   /                      — start a new discussion
 * GET    /                      — list past discussions (paginated)
 * GET    /defaults              — default panel + synthesizer config
 * GET    /active                — current running/pending roundtable (if any)
 * GET    /:id                   — full document
 * DELETE /:id                   — delete a record
 * GET    /:id/stream            — live SSE stream of events
 * GET    /:id/transcript        — markdown transcript
 * POST   /:id/score             — (re-)run quality analysis
 * POST   /:id/interjections     — add a chair interjection for the next phase
 * POST   /:id/decision          — approve/reject an approval-gated verdict
 * POST   /telegram/webhook      — retired adapter compatibility response
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const roundtableService = require('../src/services/roundtable');
const Roundtable = require('../models/Roundtable');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

function secretMatches(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireChairToken(req, res) {
  const expected = process.env.ROUNDTABLE_CHAIR_TOKEN;
  if (!expected) {
    res.status(503).json({ status: 'error', message: 'Roundtable chair approval is not configured' });
    return false;
  }
  const supplied = req.get('x-roundtable-chair-token') || '';
  if (!secretMatches(supplied, expected)) {
    res.status(401).json({ status: 'error', message: 'Invalid roundtable chair token' });
    return false;
  }
  return true;
}

router.post('/', express.json(), async (req, res) => {
  try {
    const {
      question, rounds, panel, synthesizer, tags, source, enableScoring,
      governance
    } = req.body || {};

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ status: 'error', message: 'question is required' });
    }
    if (question.length > 5000) {
      return res.status(400).json({ status: 'error', message: 'question exceeds 5000 char limit' });
    }
    const usesRealRuntime = Array.isArray(panel)
      && panel.some((agent) => String(agent?.runtime || 'model').toLowerCase() !== 'model');
    if (req.body?.telegram || req.body?.notify) {
      return res.status(410).json({
        status: 'error',
        message: 'Roundtable publication and notification adapters are separately deployed.',
        code: 'ADAPTER_REQUIRED'
      });
    }
    if ((usesRealRuntime || governance?.requireApproval) && !requireChairToken(req, res)) return;

    const doc = await roundtableService.startRoundtable({
      question: question.trim(),
      rounds,
      panel,
      synthesizer,
      source: source || 'api',
      tags: tags || [],
      governance: governance || {},
      enableScoring: enableScoring === true
    });

    res.status(201).json({
      status: 'ok',
      data: {
        _id: doc._id,
        status: doc.status,
        question: doc.question,
        rounds: doc.rounds
      }
    });
  } catch (err) {
    logger.error('POST /api/roundtable failed', { error: err.message });
    res.status(err.status || 500).json({
      status: 'error',
      message: err.message,
      ...(err.code ? { code: err.code } : {})
    });
  }
});

router.post('/telegram/webhook', express.json({ limit: '64kb' }), (_req, res) => res.status(410).json({
  ok: false,
  error: 'The embedded Telegram adapter was removed. Consume the Roundtable API from a separate adapter.',
  code: 'ADAPTER_REQUIRED'
}));

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = parseInt(req.query.skip, 10) || 0;
    const { docs, total } = await roundtableService.listRoundtables({ limit, skip });
    res.json({ status: 'ok', data: docs, total, limit, skip });
  } catch (err) {
    logger.error('GET /api/roundtable failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/defaults', async (_req, res) => {
  try {
    const defaults = await roundtableService.getCouncilDefaults();
    res.json({
      status: 'ok',
      data: {
        ...defaults,
        options: roundtableService.COUNCIL_OPTIONS,
        policy: {
          canonicalSurface: '/council',
          advisoryOnlyDefault: true,
          executionAuthority: 'none',
          qualityScoringDefault: false,
          modelDownloadsImplicit: false,
          runtimeParticipantsEnabled: ['1', 'true', 'yes', 'on'].includes(
            String(process.env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED || '').trim().toLowerCase()
          )
        }
      }
    });
  } catch (err) {
    logger.error('GET /api/roundtable/defaults failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Council model defaults are unavailable' });
  }
});

router.get('/active', async (req, res) => {
  try {
    const activeId = roundtableService.getActiveRoundtableId();
    if (activeId) {
      const doc = await roundtableService.getRoundtable(activeId);
      return res.json({ status: 'ok', data: doc });
    }
    // Fallback — look for any doc still marked running/pending, after closing
    // sessions a previous process left behind so a stale RUNNING is never served.
    if (typeof roundtableService.reconcileStaleRoundtables === 'function') {
      await roundtableService.reconcileStaleRoundtables().catch(() => {});
    }
    const doc = await Roundtable.findOne({ status: { $in: ['pending', 'running'] } }).sort({ createdAt: -1 });
    res.json({ status: 'ok', data: doc });
  } catch (err) {
    logger.error('GET /api/roundtable/active failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await roundtableService.getRoundtable(req.params.id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });
    res.json({ status: 'ok', data: doc });
  } catch (err) {
    logger.error('GET /api/roundtable/:id failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!requireTypedConfirmation(req, res, 'DELETE COUNCIL RECORD', req.params.id)) return;
    const result = await Roundtable.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ status: 'error', message: 'Not found' });
    }
    res.json({ status: 'ok', data: { _id: req.params.id, deleted: true } });
  } catch (err) {
    logger.error('DELETE /api/roundtable/:id failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/:id/stream', async (req, res) => {
  try {
    const doc = await roundtableService.getRoundtable(req.params.id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });

    const sseHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    };

    // Already finished — send final and close.
    if (['completed', 'failed', 'timeout'].includes(doc.status)) {
      res.writeHead(200, sseHeaders);
      res.write(`event: done\ndata: ${JSON.stringify({ status: doc.status, totalDurationMs: doc.totalDurationMs })}\n\n`);
      return res.end();
    }

    const emitter = roundtableService.getEmitter(req.params.id);
    if (!emitter) {
      res.writeHead(200, sseHeaders);
      res.write(`event: done\ndata: ${JSON.stringify({ status: 'no-stream', message: 'No active stream for this roundtable' })}\n\n`);
      return res.end();
    }

    res.writeHead(200, sseHeaders);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);

    const onChunk = (data) => {
      try {
        res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
        if (data.type === 'done') cleanup();
      } catch {
        cleanup();
      }
    };

    const cleanup = () => {
      clearInterval(heartbeat);
      emitter.removeListener('chunk', onChunk);
      if (!res.writableEnded) res.end();
    };

    emitter.on('chunk', onChunk);
    req.on('close', cleanup);
  } catch (err) {
    logger.error('GET /api/roundtable/:id/stream failed', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  }
});

router.get('/:id/transcript', async (req, res) => {
  try {
    const doc = await roundtableService.getRoundtable(req.params.id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });
    res.type('text/markdown').send(roundtableService.formatTranscript(doc));
  } catch (err) {
    logger.error('GET /api/roundtable/:id/transcript failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/:id/interjections', express.json({ limit: '16kb' }), async (req, res) => {
  if (!requireChairToken(req, res)) return;
  try {
    const { doc, interjection } = await roundtableService.addInterjection(req.params.id, {
      text: req.body?.text,
      author: req.body?.author || 'web-chair',
      source: req.body?.source === 'telegram' ? 'api' : (req.body?.source || 'api')
    });
    roundtableService.getEmitter(req.params.id)?.emit('chunk', {
      type: 'interjection-added',
      interjectionId: interjection.interjectionId,
      author: interjection.author
    });
    res.status(201).json({
      status: 'ok',
      data: { interjection, decisionStatus: doc.governance?.decisionStatus }
    });
  } catch (err) {
    logger.warn('POST /api/roundtable/:id/interjections failed', { error: err.message });
    res.status(err.status || 400).json({ status: 'error', message: err.message });
  }
});

router.post('/:id/decision', express.json({ limit: '16kb' }), async (req, res) => {
  if (!requireChairToken(req, res)) return;
  try {
    const doc = await roundtableService.setDecision(req.params.id, {
      decision: req.body?.decision,
      actor: req.body?.actor || 'web-chair',
      note: req.body?.note || '',
      source: 'web-ui'
    });
    res.json({ status: 'ok', data: doc.governance });
  } catch (err) {
    logger.warn('POST /api/roundtable/:id/decision failed', { error: err.message });
    res.status(err.status || 400).json({ status: 'error', message: err.message });
  }
});

router.post('/:id/score', async (req, res) => {
  try {
    const scores = await roundtableService.analyzeQuality(req.params.id);
    if (!scores) {
      return res.status(400).json({ status: 'error', message: 'Scoring requires a completed roundtable' });
    }
    res.json({ status: 'ok', data: scores });
  } catch (err) {
    logger.error('POST /api/roundtable/:id/score failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
