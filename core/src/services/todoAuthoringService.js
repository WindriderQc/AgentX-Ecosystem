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
  const objective = cleanString(input.objective || input.title, 'title or objective', { max: 3000 });
  const service = input.service ? cleanString(input.service, 'service', { max: 120 }) : '';
  const title = cleanString(input.title || objective.split(/\n/)[0], 'title', { max: 3000 }).slice(0, 120);
  const sourceFiles = cleanStringArray(input.source_files || input.sourceFiles || [], 'source_files', {
    minItems: 0,
    maxItems: 30,
    maxItemLength: 240,
  });
  const steps = cleanStringArray(input.steps || [], 'steps', { minItems: 0, maxItems: 30, maxItemLength: 1000 });
  const constraints = cleanStringArray(input.constraints || [], 'constraints', { minItems: 0, maxItems: 30, maxItemLength: 1000 });
  const acceptanceCriteria = cleanStringArray(input.acceptance_criteria || input.acceptanceCriteria || [], 'acceptance_criteria', {
    minItems: 0,
    maxItems: 30,
    maxItemLength: 1000,
  });
  const relatedTasks = Array.isArray(input.related_tasks || input.relatedTasks)
    ? cleanStringArray(input.related_tasks || input.relatedTasks, 'related_tasks', { minItems: 0, maxItems: 12, maxItemLength: 80 })
    : [];
  const whyNow = typeof input.why_now === 'string' || typeof input.whyNow === 'string'
    ? cleanString(input.why_now || input.whyNow, 'why_now', { max: 1000 })
    : '';
  return { objective, service, title, sourceFiles, steps, constraints, acceptanceCriteria, relatedTasks, whyNow };
}

function validateSpec(value) {
  if (typeof value !== 'string' || value.length > 100000) {
    throw new TodoAuthoringError('description must be text of at most 100000 characters', { code: 'INVALID_TASK_SPEC' });
  }
  return value;
}

function renderTodo({ id, title, objective, service, sourceFiles, steps, constraints, acceptanceCriteria, relatedTasks, whyNow }) {
  const sections = [`# ${id} - ${title}`, `## Objective\n\n${objective}`];
  const context = [
    service && `- **Service:** ${service}`,
    relatedTasks.length && `- **Related tasks:** ${relatedTasks.join(', ')}`,
    whyNow && `- **Why now:** ${whyNow}`,
  ].filter(Boolean);
  if (context.length) sections.push(`## Context\n\n${context.join('\n')}`);
  if (sourceFiles.length) sections.push(`## Source Files to Read\n\n${renderTable(sourceFiles, 'File', 'Why', 'Relevant to this task').trim()}`);
  if (steps.length) sections.push(`## Steps\n\n${renderNumbered(steps)}`);
  if (constraints.length) sections.push(`## Constraints\n\n${renderBullets(constraints)}`);
  if (acceptanceCriteria.length) sections.push(`## Acceptance Criteria\n\n${renderNumbered(acceptanceCriteria)}`);
  sections.push(`## Feedback\n\nClaim via POST /api/pipeline/tasks/${id}/claim with {"assignee":"<you>"}; keep its heartbeat current. Submit evidence via POST /api/pipeline/tasks/${id}/feedback with {"status":"done|partial|blocked","by":"<you>","text":"..."}. Done feedback requests review; the reviewer confirms completion through the status endpoint.`);
  if (acceptanceCriteria.length) {
    const criteria = acceptanceCriteria.map((criterion, idx) => ({
      id: String(idx + 1), status: 'pending', output_summary: criterion,
    }));
    sections.push('Include verification evidence in text, using a fenced JSON block:\n\n' +
      '```json\n' + JSON.stringify({ criteria_verified: criteria }, null, 2) + '\n```');
  }
  return sections.join('\n\n') + '\n';
}

module.exports = {
  TodoAuthoringError,
  validateRequest,
  validateSpec,
  renderTodo,
};
