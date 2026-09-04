'use strict';

const mockReconciliationFindOneAndUpdate = jest.fn();
const mockReconciliationUpdateOne = jest.fn();
const mockBatchUpdateOne = jest.fn();
const mockResultCollectionUpdateOne = jest.fn();

jest.mock('../../../models/BenchmarkAuthorityReconciliation', () => ({
  findOneAndUpdate: (...args) => mockReconciliationFindOneAndUpdate(...args),
  updateOne: (...args) => mockReconciliationUpdateOne(...args),
  find: jest.fn()
}));
jest.mock('../../../models/BenchmarkBatch', () => ({
  updateOne: (...args) => mockBatchUpdateOne(...args)
}));
jest.mock('../../../models/BenchmarkResult', () => ({
  collection: { updateOne: (...args) => mockResultCollectionUpdateOne(...args) }
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const service = require('../../../src/services/benchmark/benchmarkAuthorityReconciliation');

function leanResult(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReconciliationFindOneAndUpdate.mockReturnValue(leanResult({ _id: 'reconciliation-1' }));
  mockReconciliationUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockBatchUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockResultCollectionUpdateOne.mockResolvedValue({ matchedCount: 1 });
});

test('journals an ambiguous result before handing it to recovery', async () => {
  await expect(service.enqueueResultInvalidation({
    resultId: 'result-1',
    batchId: 'batch-1',
    phase: 'successful result save',
    reason: 'acknowledgement lost'
  })).resolves.toMatchObject({ _id: 'reconciliation-1' });

  expect(mockReconciliationFindOneAndUpdate).toHaveBeenCalledWith(
    { resultId: 'result-1' },
    expect.objectContaining({
      $setOnInsert: expect.objectContaining({
        kind: 'result_invalidation',
        batchId: 'batch-1',
        state: 'pending_reconciliation'
      })
    }),
    { upsert: true, new: true }
  );
  expect(mockBatchUpdateOne).toHaveBeenCalledWith(
    expect.objectContaining({ _id: 'batch-1' }),
    { $set: expect.objectContaining({ authority_state: 'pending_reconciliation' }) }
  );
});

test('terminal reconciliation tombstones the result and invalidates its batch before resolving', async () => {
  const row = {
    _id: 'reconciliation-1',
    resultId: 'result-1',
    batchId: 'batch-1',
    phase: 'successful result save'
  };

  await expect(service._reconcileResultInvalidation(row)).resolves.toMatchObject({
    resolved: true,
    resultId: 'result-1'
  });

  expect(mockResultCollectionUpdateOne).toHaveBeenCalledWith(
    { _id: 'result-1' },
    { $set: expect.objectContaining({
      excluded_from_leaderboard: true,
      scoring_method: 'authority_invalidated'
    }) },
    { upsert: true }
  );
  expect(mockBatchUpdateOne).toHaveBeenCalledWith(
    { _id: 'batch-1' },
    { $set: expect.objectContaining({ authority_state: 'authority_invalidated' }) }
  );
  expect(mockReconciliationUpdateOne).toHaveBeenCalledWith(
    { _id: 'reconciliation-1', state: 'pending_reconciliation' },
    expect.objectContaining({
      $set: expect.objectContaining({ state: 'resolved', resolvedAt: expect.any(Date) }),
      $inc: { attempts: 1 }
    })
  );
});

test('keeps the durable journal pending when result invalidation still fails', async () => {
  const failure = new Error('Mongo acknowledgement unavailable');
  mockResultCollectionUpdateOne.mockRejectedValue(failure);

  await expect(service._reconcileResultInvalidation({
    _id: 'reconciliation-1',
    resultId: 'result-1',
    batchId: 'batch-1',
    phase: 'failed result save'
  })).rejects.toBe(failure);

  expect(mockReconciliationUpdateOne).toHaveBeenCalledWith(
    { _id: 'reconciliation-1', state: 'pending_reconciliation' },
    {
      $set: expect.objectContaining({ lastError: failure.message, lastAttemptAt: expect.any(Date) }),
      $inc: { attempts: 1 }
    }
  );
  expect(mockBatchUpdateOne).not.toHaveBeenCalled();
});
