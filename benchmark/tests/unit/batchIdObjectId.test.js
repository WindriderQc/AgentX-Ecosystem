/**
 * Regression test for TODO 0106: batch_id schema drift.
 *
 * Asserts that BenchmarkResult.batch_id is declared as ObjectId (not String),
 * so that direct mongosh queries like
 *   db.benchmarkresults.find({ batch_id: ObjectId("...") })
 * work correctly.
 */

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const mongoose = require('mongoose');
const BenchmarkResult = require('../../models/BenchmarkResult');

describe('BenchmarkResult.batch_id — ObjectId type (TODO 0106)', () => {
    test('batch_id schema type is ObjectId', () => {
        const path = BenchmarkResult.schema.path('batch_id');
        expect(path).toBeDefined();
        expect(path.instance).toBe('ObjectId');
    });

    test('batch_id has ref to BenchmarkBatch', () => {
        const path = BenchmarkResult.schema.path('batch_id');
        expect(path.options.ref).toBe('BenchmarkBatch');
    });

    test('string value is cast to ObjectId on assignment', () => {
        const hexId = new mongoose.Types.ObjectId().toHexString();
        const result = new BenchmarkResult({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'test prompt',
            success: true,
            batch_id: hexId
        });
        expect(result.batch_id).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(result.batch_id.toHexString()).toBe(hexId);
    });

    test('ObjectId value is preserved on assignment', () => {
        const oid = new mongoose.Types.ObjectId();
        const result = new BenchmarkResult({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'test prompt',
            success: true,
            batch_id: oid
        });
        expect(result.batch_id).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(result.batch_id.equals(oid)).toBe(true);
    });

    test('null batch_id is accepted (default)', () => {
        const result = new BenchmarkResult({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'test prompt',
            success: true
        });
        expect(result.batch_id).toBeNull();
    });
});
