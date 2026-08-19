const {
  chooseRule,
  groupTasks
} = require('../../src/services/planningBootstrapService');

describe('planningBootstrapService deterministic grouping', () => {
  test('routes Nerve Center and alert work to the alerting workstream', () => {
    expect(chooseRule({
      title: 'Nerve Center Phase 2 — make alerting trustworthy',
      service: 'core'
    }).key).toBe('nerve-center-alerting');
  });

  test('routes benchmark service tasks before generic model-routing matches', () => {
    expect(chooseRule({
      title: 'Profiler warmup times out on large models',
      service: 'benchmark'
    }).key).toBe('benchmark-capability');
  });

  test('routes RAG and memory work to knowledge and memory', () => {
    expect(chooseRule({
      title: 'RAG service down — memory/artifact lanes inoperative',
      service: 'rag'
    }).key).toBe('knowledge-memory');
  });

  test('skips personal tasks and groups unmatched platform work', () => {
    const groups = groupTasks([
      { pipelineId: '1', title: 'Cancel Spotify', service: 'personal', source: 'idea-drop' },
      { pipelineId: '2', title: 'Refresh docs index', service: 'ecosystem', source: 'api' }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('platform-reliability');
    expect(groups[0].tasks[0].pipelineId).toBe('2');
  });

  test('can provide every AgentX starter workstream for first-run planning', () => {
    const groups = groupTasks([], { includeEmpty: true });
    expect(groups.map((group) => group.key)).toEqual([
      'nerve-center-alerting',
      'benchmark-capability',
      'knowledge-memory',
      'routing-qualification',
      'platform-reliability'
    ]);
    expect(groups.every((group) => group.tasks.length === 0)).toBe(true);
  });
});
