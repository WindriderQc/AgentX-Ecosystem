const INITIAL_STATUS_BY_TYPE = {
  workstream: 'draft',
  outcome: 'draft',
  milestone: 'draft',
  idea: 'inbox',
  decision: 'draft'
};

const ACTION_META = {
  commit: { label: 'Commit', icon: 'fa-check', tone: 'primary' },
  start: { label: 'Start', icon: 'fa-play', tone: 'primary' },
  raise_risk: { label: 'Raise risk', icon: 'fa-triangle-exclamation', tone: 'warning' },
  block: { label: 'Block', icon: 'fa-ban', tone: 'danger' },
  resume: { label: 'Resume', icon: 'fa-rotate-right', tone: 'primary' },
  complete: { label: 'Complete', icon: 'fa-circle-check', tone: 'primary' },
  reopen: { label: 'Reopen', icon: 'fa-arrow-rotate-left', tone: 'secondary' },
  shape: { label: 'Shape', icon: 'fa-wand-magic-sparkles', tone: 'primary' },
  park: { label: 'Park', icon: 'fa-pause', tone: 'secondary' },
  reject: { label: 'Reject', icon: 'fa-xmark', tone: 'danger' },
  propose: { label: 'Propose', icon: 'fa-paper-plane', tone: 'primary' },
  accept: { label: 'Accept', icon: 'fa-check-double', tone: 'primary' },
  supersede: { label: 'Supersede', icon: 'fa-code-branch', tone: 'secondary' }
};

const DELIVERY_TRANSITIONS = {
  draft: { commit: 'planned' },
  planned: { start: 'active', raise_risk: 'at_risk', block: 'blocked' },
  active: { raise_risk: 'at_risk', block: 'blocked', complete: 'completed' },
  at_risk: { resume: 'active', block: 'blocked', complete: 'completed' },
  blocked: { resume: 'active', raise_risk: 'at_risk', complete: 'completed' },
  completed: { reopen: 'active' }
};

const TRANSITIONS_BY_TYPE = {
  workstream: DELIVERY_TRANSITIONS,
  outcome: DELIVERY_TRANSITIONS,
  milestone: DELIVERY_TRANSITIONS,
  idea: {
    inbox: { shape: 'triaged', park: 'parked', reject: 'rejected' },
    triaged: { park: 'parked', reject: 'rejected' },
    parked: { reopen: 'inbox', reject: 'rejected' },
    rejected: { reopen: 'inbox' }
  },
  decision: {
    draft: { propose: 'proposed' },
    proposed: { accept: 'accepted' },
    accepted: { supersede: 'superseded' }
  }
};

function initialStatusForType(type) {
  return INITIAL_STATUS_BY_TYPE[type];
}

function actionsFor(type, status) {
  const transitions = TRANSITIONS_BY_TYPE[type]?.[status] || {};
  return Object.entries(transitions).map(([action, toStatus]) => ({
    action,
    toStatus,
    ...(ACTION_META[action] || { label: action, icon: 'fa-arrow-right', tone: 'secondary' })
  }));
}

function resolveAction(type, status, action) {
  return actionsFor(type, status).find((entry) => entry.action === action) || null;
}

function inferAction(type, fromStatus, toStatus) {
  const matches = actionsFor(type, fromStatus).filter((entry) => entry.toStatus === toStatus);
  return matches.length === 1 ? matches[0].action : '';
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function goalHasMeasurableDefinition(item) {
  const metric = item.progress?.metric || {};
  return Boolean(
    item.progress?.mode === 'metric'
    && String(metric.label || '').trim()
    && hasNumber(metric.baseline)
    && hasNumber(metric.target)
  );
}

function commitmentIssues(item, context = {}) {
  const issues = [];
  if (item.type === 'outcome') {
    if (!item.workstreamId) issues.push('a workstream is required');
    if (!String(item.owner || '').trim()) issues.push('an owner is required');
    if (!item.dates?.targetAt) issues.push('a target date is required');
    if (!String(item.summary || '').trim() && !goalHasMeasurableDefinition(item)) {
      issues.push('a measurable metric or explicit success definition is required');
    }
  }
  if (item.type === 'milestone') {
    if (!item.parentId || context.parentType !== 'outcome') {
      issues.push('a parent goal is required');
    }
    if (!String(item.owner || '').trim()) issues.push('an owner is required');
    if (!item.dates?.targetAt) issues.push('a target date is required');
    if (!String(item.summary || '').trim()) issues.push('a definition of done is required');
  }
  return issues;
}

function progressSourceIssues(item, context = {}) {
  if (item.type !== 'outcome') return [];
  const mode = item.progress?.mode || 'tasks';
  if (mode === 'metric' && !String(item.progress?.metric?.sourceRef || '').trim()) {
    return ['a metric source is required before starting'];
  }
  if (mode === 'tasks' && !context.linkedTaskCount) {
    return ['at least one linked pipeline task is required before starting'];
  }
  if (mode === 'children' && !context.childCount) {
    return ['at least one child item is required before starting'];
  }
  return [];
}

function transitionIssues(item, action, context = {}) {
  const issues = [];
  if (['commit', 'start'].includes(action)) {
    issues.push(...commitmentIssues(item, context));
  }
  if (action === 'start') {
    issues.push(...progressSourceIssues(item, context));
  }
  if (action === 'accept' && item.type === 'decision') {
    if (!String(item.decision?.context || '').trim()) issues.push('decision context is required');
    if (!String(item.decision?.choice || '').trim()) issues.push('the accepted choice is required');
    if (!String(item.decision?.rationale || '').trim()) issues.push('decision rationale is required');
  }
  if (action === 'complete' && ['outcome', 'milestone'].includes(item.type)) {
    if (!(item.evidence || []).length) issues.push('at least one evidence record is required');
  }
  if (action === 'complete' && item.type === 'workstream' && context.incompleteChildCount) {
    issues.push(`${context.incompleteChildCount} child commitment(s) are still open`);
  }
  return [...new Set(issues)];
}

module.exports = {
  ACTION_META,
  INITIAL_STATUS_BY_TYPE,
  TRANSITIONS_BY_TYPE,
  initialStatusForType,
  actionsFor,
  resolveAction,
  inferAction,
  commitmentIssues,
  transitionIssues
};
