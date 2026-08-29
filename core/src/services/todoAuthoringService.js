// Pure task-spec validation + rendering. The git-writing path (createTodo,
// nextTodoId, …) was removed in the 2026-06-26 cutover; createTaskInMongo
// (pipelineTaskService) reuses validateRequest + renderTodo from here.
class TodoAuthoringError extends Error {
  constructor(message, { status = 400, code = 'TODO_AUTHORING_ERROR' } = {}) {
    super(message);
    this.name = 'TodoAuthoringError';
    this.status = status;
    this.code = code;
  }
}

function cleanString(value, field, { min = 1, max = 2000 } = {}) {
  if (typeof value !== 'string') {
    throw new TodoAuthoringError(`${field} must be a string`, { code: 'INVALID_TODO_INPUT' });
  }
  const out = value.trim();
  if (out.length < min) {
    throw new TodoAuthoringError(`${field} is required`, { code: 'INVALID_TODO_INPUT' });
  }
  if (out.length > max) {
    throw new TodoAuthoringError(`${field} exceeds ${max} characters`, { code: 'INVALID_TODO_INPUT' });
  }
  return out;
}

function cleanStringArray(value, field, { minItems = 1, maxItems = 20, maxItemLength = 1000 } = {}) {
  if (!Array.isArray(value)) {
    throw new TodoAuthoringError(`${field} must be an array`, { code: 'INVALID_TODO_INPUT' });
  }
  const out = value
    .map((item) => cleanString(item, `${field}[]`, { max: maxItemLength }))
    .filter(Boolean);
  if (out.length < minItems) {
    throw new TodoAuthoringError(`${field} must include at least ${minItems} item(s)`, { code: 'INVALID_TODO_INPUT' });
  }
  if (out.length > maxItems) {
    throw new TodoAuthoringError(`${field} exceeds ${maxItems} items`, { code: 'INVALID_TODO_INPUT' });
  }
  return out;
}

function slugify(input) {
  const slug = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (!slug) {
    throw new TodoAuthoringError('short_name must contain letters or digits', { code: 'INVALID_TODO_INPUT' });
  }
  return slug;
}

function renderTable(items, firstHeader, secondHeader, secondDefault) {
  if (!items || items.length === 0) return 'None.\n';
  const rows = items.map((item) => `| \`${item}\` | ${secondDefault} |`).join('\n');
  return `| ${firstHeader} | ${secondHeader} |\n|---|---|\n${rows}\n`;
}

function renderNumbered(items) {
  return items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
}

function renderBullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function validateRequest(input) {
  const objective = cleanString(input.objective, 'objective', { max: 3000 });
  const service = cleanString(input.service, 'service', { max: 120 });
  const shortName = slugify(input.short_name || input.shortName || input.title || objective);
  const title = cleanString(input.title || objective.split(/\n/)[0], 'title', { max: 120 });
  const sourceFiles = cleanStringArray(input.source_files || input.sourceFiles || [], 'source_files', {
    minItems: 1,
    maxItems: 30,
    maxItemLength: 240,
  });
  const steps = cleanStringArray(input.steps, 'steps', { minItems: 1, maxItems: 30, maxItemLength: 1000 });
  const constraints = cleanStringArray(input.constraints, 'constraints', { minItems: 1, maxItems: 30, maxItemLength: 1000 });
  const acceptanceCriteria = cleanStringArray(input.acceptance_criteria || input.acceptanceCriteria, 'acceptance_criteria', {
    minItems: 1,
    maxItems: 30,
    maxItemLength: 1000,
  });
  const relatedTasks = Array.isArray(input.related_tasks || input.relatedTasks)
    ? cleanStringArray(input.related_tasks || input.relatedTasks, 'related_tasks', { minItems: 0, maxItems: 12, maxItemLength: 80 })
    : [];
  const whyNow = typeof input.why_now === 'string' || typeof input.whyNow === 'string'
    ? cleanString(input.why_now || input.whyNow, 'why_now', { max: 1000 })
    : 'Created by AgentX MCP create_todo.';
  return { objective, service, shortName, title, sourceFiles, steps, constraints, acceptanceCriteria, relatedTasks, whyNow };
}

function renderTodo({ id, title, objective, service, shortName, sourceFiles, steps, constraints, acceptanceCriteria, relatedTasks, whyNow }) {
  const criteria = acceptanceCriteria.map((criterion, idx) => ({
    id: idx + 1,
    status: 'pending',
    command: '',
    output_summary: criterion,
  }));

  return `# ${id} - ${title}

Queued ${new Date().toISOString().slice(0, 10)} into the Mongo pipeline by AgentX MCP skill bus (\`create_todo\`). Unclaimed in Mongo \`pipelinetasks\`.

Before starting, claim this task atomically via \`POST /api/pipeline/tasks/${id}/claim\` (body \`{"assignee":"<you>"}\`; a \`409\` means someone else holds it) and keep \`POST /api/pipeline/tasks/${id}/heartbeat\` current while you work. A remote worker must attach \`X-AgentX-Pipeline-Token: <AGENTX_PIPELINE_TOKEN>\` to the bounded next-task lookup, claim, heartbeat, status, and feedback requests. The credential does not grant the full task-list read. The worker credential may report \`status: "done"\` through feedback (which moves the task to review), but it cannot confirm \`status: "done"\` through the status endpoint; a trusted reviewer or operator owns that final transition. Task state is owned by the pipeline endpoints — never hand-edit it.

## Objective

${objective}

## Context

- **Service:** ${service}
- **Related tasks:** ${relatedTasks.length ? relatedTasks.join(', ') : 'none'}
- **Why now:** ${whyNow}

## Reference Sources

None.

## Source Files to Read

${renderTable(sourceFiles, 'File', 'Why', 'Relevant to this task')}

## Steps

${renderNumbered(steps)}

## Constraints

${renderBullets(constraints)}

## Acceptance Criteria

${renderNumbered(acceptanceCriteria)}

## Environment

- **Service port:** 3080 (core) unless the task says otherwise.
- **MongoDB:** shared \`agentx\` database via Docker Compose.
- **Node:** v22+ in the current AgentX runtime.

## Feedback

When done, close the task with \`POST /api/pipeline/tasks/${id}/feedback\`:

\`\`\`json
{
  "status": "done | partial | blocked",
  "by": "<you>",
  "text": "..."
}
\`\`\`

The \`text\` must carry the same evidence the old FEEDBACK file did:
- **Files changed:** list with one-line description each
- **Files created:** if any
- **Files deleted:** if any
- **Issues:** deviations, blockers, or concerns
- **Verification:** command output proving each acceptance criterion

Embed a machine-parsable verification block inside \`text\`:

\`\`\`json
{
  "criteria_verified": ${JSON.stringify(criteria, null, 4)}
}
\`\`\`
`;
}

module.exports = {
  TodoAuthoringError,
  validateRequest,
  renderTodo,
};
