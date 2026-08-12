const {
  initialStatusForType,
  actionsFor,
  inferAction,
  transitionIssues
} = require('../../src/services/planningWorkflowService');

describe('planningWorkflowService', () => {
  test('starts each type in its capture state and exposes named actions', () => {
    expect(initialStatusForType('outcome')).toBe('draft');
    expect(initialStatusForType('idea')).toBe('inbox');
    expect(actionsFor('outcome', 'active').map((entry) => entry.action)).toEqual([
      'raise_risk',
      'block',
      'complete'
    ]);
    expect(inferAction('milestone', 'blocked', 'active')).toBe('resume');
    expect(inferAction('milestone', 'draft', 'active')).toBe('');
  });

  test('requires goal structure before commitment', () => {
    expect(transitionIssues({
      type: 'outcome',
      owner: '',
      summary: '',
      workstreamId: null,
      dates: {},
      progress: { mode: 'metric', metric: {} }
    }, 'commit')).toEqual(expect.arrayContaining([
      'a workstream is required',
      'an owner is required',
      'a target date is required',
      'a measurable metric or explicit success definition is required'
    ]));
  });

  test('requires a parent goal and definition of done for milestones', () => {
    expect(transitionIssues({
      type: 'milestone',
      owner: 'codex',
      summary: '',
      parentId: 'parent',
      dates: { targetAt: new Date() }
    }, 'commit', { parentType: 'workstream' })).toEqual([
      'a parent goal is required',
      'a definition of done is required'
    ]);
  });

  test('requires proof before completing outcomes and milestones', () => {
    expect(transitionIssues({
      type: 'outcome',
      evidence: []
    }, 'complete')).toEqual(['at least one evidence record is required']);
  });
});
