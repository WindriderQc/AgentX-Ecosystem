/**
 * Unit tests for batchHelpers — focused on the terminal-status finalizer logic.
 *
 * 0205 shipped TERMINAL_BATCH_FAILURE_RATE_THRESHOLD + deriveTerminalBatchStatus.
 * 0209 adds the stricter deriveTerminalBatchOutcome that also returns a
 * captured failure_reason and forces 'failed' for the zero-cells-executed case.
 */

const {
    deriveTerminalBatchStatus,
    deriveTerminalBatchOutcome,
    TERMINAL_BATCH_FAILURE_RATE_THRESHOLD
} = require('../../../src/services/benchmark/batchHelpers');

describe('TERMINAL_BATCH_FAILURE_RATE_THRESHOLD', () => {
    it('defaults to 0.25', () => {
        // The env var BENCHMARK_TERMINAL_FAILURE_RATE_THRESHOLD may override at module-load.
        // This test asserts the default sticks when the env var is unset (CI default).
        expect(TERMINAL_BATCH_FAILURE_RATE_THRESHOLD).toBeGreaterThan(0);
        expect(TERMINAL_BATCH_FAILURE_RATE_THRESHOLD).toBeLessThanOrEqual(1);
    });
});

describe('deriveTerminalBatchStatus (0205)', () => {
    it('returns completed when totalTests is 0', () => {
        expect(deriveTerminalBatchStatus({ totalTests: 0, failed: 0 })).toBe('completed');
    });

    it('returns failed when failure rate meets the threshold', () => {
        expect(deriveTerminalBatchStatus({ totalTests: 4, failed: 1 })).toBe('failed');
    });

    it('returns completed when failure rate is below the threshold', () => {
        expect(deriveTerminalBatchStatus({ totalTests: 100, failed: 5 })).toBe('completed');
    });
});

describe('deriveTerminalBatchOutcome (0209)', () => {
    it('returns completed/null when no plan (totalTests=0)', () => {
        expect(deriveTerminalBatchOutcome({ totalTests: 0, completed: 0, failed: 0 }))
            .toEqual({ status: 'completed', failureReason: null });
    });

    it('returns failed/zero_cells_executed when plan exists but nothing ran', () => {
        expect(deriveTerminalBatchOutcome({ totalTests: 315, completed: 0, failed: 0 }))
            .toEqual({ status: 'failed', failureReason: 'zero_cells_executed' });
    });

    it('returns failed/zero_cells_executed even when failed is 0 (defends 0207 order-5)', () => {
        // Both 0207 order-5 batches (69fd49e0…, 69fd4a23…) had completed=0/315,
        // failed=0. Without this check, deriveTerminalBatchStatus returns
        // 'completed' because 0/315 < 25% threshold. 0209's stricter rule
        // catches the zero-cells case regardless of failure rate.
        expect(deriveTerminalBatchOutcome({ totalTests: 999, completed: 0, failed: 0 }))
            .toEqual({ status: 'failed', failureReason: 'zero_cells_executed' });
    });

    it('returns failed/incomplete_cells when some planned cells never produced results', () => {
        // 2026-06-11 audit: batch 6a2a2433... ended completed=42/60, failed=6.
        // The failed rate alone was below threshold, but 18 missing cells should
        // not be reported as a clean completed batch.
        expect(deriveTerminalBatchOutcome({ totalTests: 60, completed: 42, failed: 6 }))
            .toEqual({ status: 'failed', failureReason: 'incomplete_cells' });
    });

    it('returns failed/high_failure_rate when ≥25% failed and at least one cell ran', () => {
        expect(deriveTerminalBatchOutcome({ totalTests: 100, completed: 100, failed: 30 }))
            .toEqual({ status: 'failed', failureReason: 'high_failure_rate' });
    });

    it('returns failed/high_failure_rate at exactly the threshold (1/4 = 25%)', () => {
        expect(deriveTerminalBatchOutcome({ totalTests: 4, completed: 4, failed: 1 }))
            .toEqual({ status: 'failed', failureReason: 'high_failure_rate' });
    });

    it('returns completed/null when failure rate is below threshold', () => {
        expect(deriveTerminalBatchOutcome({ totalTests: 100, completed: 100, failed: 5 }))
            .toEqual({ status: 'completed', failureReason: null });
    });

    it('treats string-typed numeric inputs the same as numbers', () => {
        expect(deriveTerminalBatchOutcome({ totalTests: '4', completed: '4', failed: '1' }))
            .toEqual({ status: 'failed', failureReason: 'high_failure_rate' });
    });

    it('treats missing fields as 0', () => {
        expect(deriveTerminalBatchOutcome({}))
            .toEqual({ status: 'completed', failureReason: null });
    });
});
