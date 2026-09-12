const { taskTimeline, taskSummaryWithTimeline } = require('../../src/services/pipelineTaskTimeline');

test('does not infer completion from a done record or free-form feedback', () => {
  const task = { status: 'done', createdAt: '2026-09-01', updatedAt: '2026-09-10', feedback: [{ at: '2026-09-02', text: 'done deployed' }] };
  expect(taskTimeline(task).map(event => event.kind)).toEqual(['created', 'updated']);
});

test('projects recorded attempts and decisions without exposing attempt payloads', () => {
  const task = { pipelineId: '1001', createdAt: '2026-09-01', automationAttempts: [{
    attempt: 2, acquiredAt: '2026-09-03', completedAt: '2026-09-04', finalState: 'review',
    reviewedAt: '2026-09-05', reviewOutcome: 'accepted', evidence: { privatePayload: 'must not leave summary' }
  }] };
  const summary = taskSummaryWithTimeline(task);
  expect(summary.automationAttempts).toBeUndefined();
  expect(JSON.stringify(summary)).not.toContain('privatePayload');
  expect(summary.timeline.map(event => event.kind)).toEqual(['created', 'started', 'completed', 'reviewed']);
  expect(summary.timeline.at(-1)).toMatchObject({ at: '2026-09-05T00:00:00.000Z', label: 'Human decision: accepted', attempt: 2 });
});

test('unknown dates remain absent and supersession remains a separate closure', () => {
  expect(taskTimeline({ createdAt: 'bad', updatedAt: null, status: 'done' })).toEqual([]);
  expect(taskTimeline({ resolution: { kind: 'superseded', at: '2026-09-05' } })).toEqual([
    { at: '2026-09-05T00:00:00.000Z', kind: 'superseded', label: 'Closed by supersession' }
  ]);
});
