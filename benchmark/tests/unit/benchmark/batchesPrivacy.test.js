'use strict';

const {
    isTrustCampaignBatch,
    projectBenchmarkBatchForPublicRead,
    projectBenchmarkTimelineEventForPublicRead
} = require('../../../src/services/benchmark/batches');
const {
    applyStrictTrustExclusionToAggregate,
    combineWithStrictTrustResultExclusion,
    isPublicBenchmarkRead,
    runWithVerifiedStrictTrustEvidenceRead,
    withPublicBenchmarkReadPrivacy
} = require('../../../src/services/benchmark/publicReadPrivacy');

describe('Benchmark Trust public batch privacy', () => {
    const trustBatch = {
        _id: '507f1f77bcf86cd799439011',
        trust_batch_id: `batch_${'a'.repeat(32)}`,
        trust_campaign_spec_id: 'b'.repeat(64),
        status: 'running',
        total_tests: 30,
        completed: 1,
        failed: 0,
        host: 'http://private-host:11434',
        models: ['private-model'],
        targets: [{ provider: 'private-provider', model: 'private-model' }],
        judge_config: { model: 'private-judge', host: 'http://private-judge:11434' },
        execution_config: {
            custom_hint: 'PRIVATE-HINT',
            answer_contract_template: 'PRIVATE-CONTRACT {target}',
            thinking_final_answer_template: 'PRIVATE-THINKING',
            length_hint_template: 'PRIVATE-LENGTH {max}'
        },
        current_test: {
            model: 'private-model',
            prompt_id: 'private-prompt-id',
            prompt_name: 'private-prompt-name',
            prompt_text: 'PRIVATE-PROMPT-TEXT',
            response_preview: 'PRIVATE-RESPONSE',
            stage: 'executing',
            test_number: 2
        }
    };

    test('projects a Trust batch through a strict opaque allowlist', () => {
        expect(isTrustCampaignBatch(trustBatch)).toBe(true);
        const projected = projectBenchmarkBatchForPublicRead(trustBatch);
        const bytes = JSON.stringify(projected);

        expect(projected).toMatchObject({
            _id: trustBatch._id,
            trust_batch_id: trustBatch.trust_batch_id,
            trust_campaign_spec_id: trustBatch.trust_campaign_spec_id,
            status: 'running',
            privacy_redacted: true,
            current_test: { stage: 'executing', test_number: 2 }
        });
        for (const forbidden of [
            'PRIVATE-HINT', 'PRIVATE-CONTRACT', 'PRIVATE-THINKING', 'PRIVATE-LENGTH',
            'private-host', 'private-model', 'private-provider', 'private-judge',
            'PRIVATE-PROMPT-TEXT', 'PRIVATE-RESPONSE', 'private-prompt-name'
        ]) {
            expect(bytes).not.toContain(forbidden);
        }
    });

    test('treats a committed source context as Trust authority even without a CampaignSpec id', () => {
        const contextOnly = {
            ...trustBatch,
            trust_campaign_spec_id: null,
            trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
        };
        expect(isTrustCampaignBatch(contextOnly)).toBe(true);
        expect(projectBenchmarkBatchForPublicRead(contextOnly)).toMatchObject({
            _id: trustBatch._id,
            privacy_redacted: true
        });
        expect(JSON.stringify(projectBenchmarkBatchForPublicRead(contextOnly)))
            .not.toMatch(/private-host|private-model|PRIVATE-PROMPT-TEXT/);
    });

    test('preserves legacy batch reads and redacts Trust timeline identities', () => {
        const legacy = { _id: 'legacy', status: 'completed', execution_config: { custom_hint: 'legacy' } };
        expect(projectBenchmarkBatchForPublicRead(legacy)).toEqual(legacy);

        const event = {
            _id: 'event-id',
            timestamp: new Date('2026-09-01T00:00:00.000Z'),
            event: 'test_complete',
            model: 'private-model',
            host: 'private-host',
            prompt_id: 'private-prompt',
            duration_ms: 10,
            tokens_per_sec: 20,
            success: false,
            error: 'PRIVATE-ERROR',
            details: { prompt: 'PRIVATE-DETAIL' }
        };
        const projected = projectBenchmarkTimelineEventForPublicRead(event, true);
        expect(projected).toMatchObject({
            _id: 'event-id',
            event: 'test_complete',
            duration_ms: 10,
            tokens_per_sec: 20,
            success: false,
            has_error: true,
            privacy_redacted: true
        });
        expect(JSON.stringify(projected)).not.toMatch(/private|PRIVATE/);
        expect(projectBenchmarkTimelineEventForPublicRead(event, false)).toEqual(event);
    });

    test('adds one request-scoped Trust exclusion to queries and aggregates', async () => {
        expect(combineWithStrictTrustResultExclusion({ success: true })).toEqual({
            $and: [
                { success: true },
                {
                    $nor: [
                        { trust_candidate_id: { $ne: null } },
                        { trust_prompt_id: { $ne: null } },
                        { trust_evidence_sealed: true }
                    ]
                }
            ]
        });
        const pipeline = [{ $sort: { timestamp: -1 } }];
        applyStrictTrustExclusionToAggregate(pipeline);
        expect(pipeline[0]).toHaveProperty('$match.$nor');

        expect(isPublicBenchmarkRead()).toBe(false);
        await new Promise((resolve, reject) => {
            withPublicBenchmarkReadPrivacy({ method: 'GET' }, {}, async () => {
                try {
                    expect(isPublicBenchmarkRead()).toBe(true);
                    await runWithVerifiedStrictTrustEvidenceRead(async () => {
                        expect(isPublicBenchmarkRead()).toBe(false);
                        await Promise.resolve();
                        expect(isPublicBenchmarkRead()).toBe(false);
                    });
                    expect(isPublicBenchmarkRead()).toBe(true);
                    await Promise.resolve();
                    expect(isPublicBenchmarkRead()).toBe(true);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        expect(isPublicBenchmarkRead()).toBe(false);
    });

    test('treats HEAD as a public read', async () => {
        await new Promise((resolve, reject) => {
            withPublicBenchmarkReadPrivacy({ method: 'HEAD' }, {}, async () => {
                try {
                    expect(isPublicBenchmarkRead()).toBe(true);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        expect(isPublicBenchmarkRead()).toBe(false);
    });
});
