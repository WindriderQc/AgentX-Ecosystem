const { renderTodo, validateRequest } = require('../../src/services/todoAuthoringService');

describe('todoAuthoringService', () => {
  test('rejects incomplete input', () => {
    expect(() => validateRequest({ objective: 'x' })).toThrow(/service/);
  });

  test('validates and renders a conformant Mongo pipeline task spec', () => {
    const request = validateRequest({
      title: 'Write focused task',
      objective: 'Create a precise task for a worker.',
      service: 'core',
      short_name: 'focused-task',
      source_files: ['core/src/app.js'],
      steps: ['Read the relevant file', 'Make the change'],
      constraints: ['Keep the change scoped'],
      acceptance_criteria: ['The task exists', 'The pipeline spec renders'],
    });

    expect(request.shortName).toBe('focused-task');
    expect(request.sourceFiles).toEqual(['core/src/app.js']);

    const spec = renderTodo({ id: '0320', ...request });

    expect(spec).toContain('# 0320 - Write focused task');
    expect(spec).toContain('Unclaimed in Mongo `pipelinetasks`');
    expect(spec).toContain('POST /api/pipeline/tasks/0320/claim');
    expect(spec).toContain('## Acceptance Criteria');
    expect(spec).toContain('## Feedback');
    expect(spec).toContain('criteria_verified');
    // Instructions point at the Mongo pipeline, not the retired git TODO/ tree.
    expect(spec).toContain('POST /api/pipeline/tasks/0320/claim');
    expect(spec).toContain('POST /api/pipeline/tasks/0320/feedback');
    expect(spec).toContain('X-AgentX-Pipeline-Token: <AGENTX_PIPELINE_TOKEN>');
    expect(spec).toContain('credential does not grant the full task-list read');
    expect(spec).toContain('a trusted reviewer or operator owns that final transition');
    expect(spec).not.toContain('TODO/ASSIGNMENTS.md');
    expect(spec).not.toContain('TODO/FEEDBACK');
    expect(spec).toContain('| `core/src/app.js` | Relevant to this task |');
  });
});
