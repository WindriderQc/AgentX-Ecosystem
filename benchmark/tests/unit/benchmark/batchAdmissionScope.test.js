'use strict';
const { batchAdmissionScope } = require('../../../src/services/benchmark/batchAdmissionScope');

describe('batch admission scope', () => {
    const targets = [{ executionKind: 'ollama', host: 'http://exec:11434' }];
    test('includes a separate local judge without changing the workload kind', () => {
        expect(batchAdmissionScope(targets, { host: 'http://judge:11434' })).toEqual({
            kind: 'benchmark', hosts: ['http://exec:11434', 'http://judge:11434']
        });
    });
    test('deduplicates co-located candidates and their default judge', () => {
        expect(batchAdmissionScope([...targets, ...targets])).toEqual({
            kind: 'benchmark', hosts: ['http://exec:11434']
        });
    });
    test('includes a local judge for harness-only candidates', () => {
        expect(batchAdmissionScope([{ executionKind: 'harness', host: null }], {
            host: 'http://judge:11434'
        })).toEqual({ kind: 'benchmark-cloud', hosts: ['http://judge:11434'] });
    });
    test('a harness judge changes kind without claiming its pseudo-host as Ollama', () => {
        expect(batchAdmissionScope(targets, {
            host: 'harness:test', target: { executionKind: 'harness' }
        })).toEqual({ kind: 'benchmark-cloud', hosts: ['http://exec:11434'] });
    });
});
