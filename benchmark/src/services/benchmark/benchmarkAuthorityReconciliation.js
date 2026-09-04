'use strict';

const mongoose = require('mongoose');
const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const logger = require('../../../config/logger');

const DEFAULT_INTERVAL_MS = 5_000;
let interval = null;
let running = false;

function resultObjectId(resultId) {
  const value = String(resultId || '');
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : resultId;
}

function invalidationUpdate(phase) {
  return {
    $set: {
      excluded_from_leaderboard: true,
      needs_review: true,
      scoring_method: 'authority_invalidated',
      quality_score: null,
      composite_score: null,
      review_reason: `Persistence authority was lost during ${phase}; reconciliation is required`
    }
  };
}

async function enqueueResultInvalidation({ resultId, batchId, phase, reason }) {
  const identity = String(resultId || '');
  if (!identity) throw new Error('resultId is required for authority reconciliation');
  const record = await BenchmarkAuthorityReconciliation.findOneAndUpdate(
    { resultId: identity },
    {
      $setOnInsert: {
        kind: 'result_invalidation',
        resultId: identity,
        batchId: batchId ? String(batchId) : null,
        phase,
        state: 'pending_reconciliation',
        reason: reason || null,
        attempts: 0,
        startedAt: new Date()
      },
      $set: { lastError: reason || null }
    },
    { upsert: true, new: true }
  ).lean();

  if (batchId) {
    try {
      await BenchmarkBatch.updateOne(
        { _id: batchId, authority_state: { $ne: 'authority_invalidated' } },
        {
          $set: {
            authority_state: 'pending_reconciliation',
            authority_reconciliation_reason: `result ${identity} persistence acknowledgement was ambiguous`
          }
        }
      );
    } catch (error) {
      logger.warn('Benchmark batch authority projection remains pending durable reconciliation', {
        batchId: String(batchId),
        resultId: identity,
        error: error.message
      });
    }
  }
  return record;
}

async function reconcileResultInvalidation(record) {
  const attemptedAt = new Date();
  try {
    await BenchmarkResult.collection.updateOne(
      { _id: resultObjectId(record.resultId) },
      invalidationUpdate(record.phase),
      { upsert: true }
    );
    if (record.batchId) {
      await BenchmarkBatch.updateOne(
        { _id: record.batchId },
        {
          $set: {
            authority_state: 'authority_invalidated',
            authority_reconciliation_reason: `result ${record.resultId} was invalidated after ambiguous persistence`
          }
        }
      );
    }
    const resolvedAt = new Date();
    await BenchmarkAuthorityReconciliation.updateOne(
      { _id: record._id, state: 'pending_reconciliation' },
      {
        $set: {
          state: 'resolved',
          lastAttemptAt: attemptedAt,
          lastError: null,
          resolvedAt
        },
        $inc: { attempts: 1 }
      }
    );
    return { resolved: true, resultId: record.resultId, resolvedAt };
  } catch (error) {
    await BenchmarkAuthorityReconciliation.updateOne(
      { _id: record._id, state: 'pending_reconciliation' },
      {
        $set: { lastAttemptAt: attemptedAt, lastError: error.message },
        $inc: { attempts: 1 }
      }
    ).catch(updateError => logger.error('Authority reconciliation retry state could not be persisted', {
      reconciliationId: String(record._id),
      error: updateError.message
    }));
    throw error;
  }
}

async function reconcilePendingResultInvalidations(options = {}) {
  if (running) return { skipped: true, reason: 'authority reconciliation already running' };
  running = true;
  try {
    const rows = await BenchmarkAuthorityReconciliation.find({
      state: 'pending_reconciliation',
      kind: 'result_invalidation'
    }).sort({ startedAt: 1 }).limit(Number(options.limit) || 50).lean();
    const results = [];
    for (const row of rows) {
      try {
        results.push(await reconcileResultInvalidation(row));
      } catch (error) {
        logger.warn('Benchmark authority reconciliation remains pending', {
          reconciliationId: String(row._id),
          resultId: row.resultId,
          error: error.message
        });
        results.push({ resolved: false, resultId: row.resultId, error: error.message });
      }
    }
    return {
      inspected: rows.length,
      resolved: results.filter(result => result.resolved).length,
      pending: results.filter(result => !result.resolved).length,
      results
    };
  } finally {
    running = false;
  }
}

async function waitForResultInvalidation(reconciliationId, options = {}) {
  const retryMs = Math.max(10, Number(options.retryMs) || 1_000);
  while (true) {
    const row = await BenchmarkAuthorityReconciliation.findById(reconciliationId).lean();
    if (!row) throw new Error(`Authority reconciliation ${reconciliationId} disappeared`);
    if (row.state === 'resolved') return { resolved: true, reconciliationId: String(row._id) };
    try {
      await reconcileResultInvalidation(row);
    } catch (_error) {
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
}

function startBenchmarkAuthorityReconciliation(options = {}) {
  if (interval) return interval;
  const intervalMs = Math.max(100, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const run = () => reconcilePendingResultInvalidations(options)
    .catch(error => logger.warn('Benchmark authority reconciliation sweep failed', { error: error.message }));
  run();
  interval = setInterval(run, intervalMs);
  interval.unref?.();
  return interval;
}

function stopBenchmarkAuthorityReconciliation() {
  if (interval) clearInterval(interval);
  interval = null;
}

module.exports = {
  enqueueResultInvalidation,
  reconcilePendingResultInvalidations,
  waitForResultInvalidation,
  startBenchmarkAuthorityReconciliation,
  stopBenchmarkAuthorityReconciliation,
  _reconcileResultInvalidation: reconcileResultInvalidation,
  _invalidationUpdate: invalidationUpdate
};
