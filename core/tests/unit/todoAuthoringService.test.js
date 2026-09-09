const { renderTodo, validateRequest } = require('../../src/services/todoAuthoringService');

describe('todoAuthoringService', () => {
  test('rejects incomplete input', () => {
    expect(() => validateRequest({})).toThrow(/title or objective/);
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

    expect(request.sourceFiles).toEqual(['core/src/app.js']);

    const spec = renderTodo({ id: '0320', ...request });

    expect(spec).toContain('# 0320 - Write focused task');
    expect(spec).toContain('POST /api/pipeline/tasks/0320/claim');
    expect(spec).toContain('## Acceptance Criteria');
    expect(spec).toContain('## Feedback');
    expect(spec).toContain('criteria_verified');
    // Instructions point at the Mongo pipeline, not the retired git TODO/ tree.
    expect(spec).toContain('POST /api/pipeline/tasks/0320/claim');
    expect(spec).toContain('POST /api/pipeline/tasks/0320/feedback');
    expect(spec).not.toMatch(/credential|trusted reviewer|Service port|Reference Sources/);
    expect(spec).toContain('Done feedback requests review');
    const receipt = JSON.parse(spec.match(/```json\n([\s\S]*?)\n```/)[1]);
    expect(receipt.criteria_verified.map(item => item.id)).toEqual(['1', '2']);
    expect(spec).not.toContain('TODO/ASSIGNMENTS.md');
    expect(spec).not.toContain('TODO/FEEDBACK');
    expect(spec).toContain('| `core/src/app.js` | Relevant to this task |');
  });
});
