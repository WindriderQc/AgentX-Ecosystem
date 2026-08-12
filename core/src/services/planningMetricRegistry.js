const ALERT_STATUSES = ['active', 'acknowledged', 'resolved', 'suppressed'];
const ALERT_SEVERITIES = ['info', 'warning', 'error', 'critical'];

class PlanningMetricError extends Error {
  constructor(message, { status = 400, code = 'INVALID_PLANNING_METRIC_BINDING' } = {}) {
    super(message);
    this.name = 'PlanningMetricError';
    this.status = status;
    this.code = code;
  }
}

const DEFINITIONS = {
  'pipeline.progress': {
    label: 'Pipeline weighted progress',
    unit: '%',
    description: 'Weighted progress across pipeline tasks linked to the Planning item.',
    params: {}
  },
  'pipeline.done_ratio': {
    label: 'Pipeline done ratio',
    unit: '%',
    description: 'Percentage of linked pipeline tasks in the done state.',
    params: {}
  },
  'alerts.active_count': {
    label: 'Active alert count',
    unit: 'count',
    description: 'Count alerts using allowlisted status, severity, rule, component, and age filters.',
    params: {
      status: { type: 'enum', values: ALERT_STATUSES, default: 'active' },
      severity: { type: 'enum', values: ALERT_SEVERITIES },
      ruleId: { type: 'string', max: 160 },
      component: { type: 'string', max: 200 },
      olderThanMs: { type: 'number', min: 60000, max: 2592000000 }
    }
  },
  'schedule.success_rate': {
    label: 'Schedule success rate',
    unit: '%',
    description: 'Percentage of linked schedules whose latest declared run status is successful.',
    params: {}
  },
  'schedule.consecutive_errors': {
    label: 'Schedule consecutive errors',
    unit: 'count',
    description: 'Maximum consecutive error count across linked schedules.',
    params: {}
  },
  'benchmark.batch_completion': {
    label: 'Benchmark batch completion',
    unit: '%',
    description: 'Execution completion for one Benchmark batch selected by ID or Planning tag.',
    oneOf: ['batchId', 'tag'],
    params: {
      batchId: { type: 'string', max: 24, pattern: '^[a-fA-F0-9]{24}$' },
      tag: { type: 'string', max: 50, pattern: '^planning:[A-Za-z0-9][A-Za-z0-9._:-]*$' }
    }
  },
  'benchmark.batch_success_rate': {
    label: 'Benchmark batch success rate',
    unit: '%',
    description: 'Successful executions among completed results for one Benchmark batch.',
    oneOf: ['batchId', 'tag'],
    params: {
      batchId: { type: 'string', max: 24, pattern: '^[a-fA-F0-9]{24}$' },
      tag: { type: 'string', max: 50, pattern: '^planning:[A-Za-z0-9][A-Za-z0-9._:-]*$' }
    }
  },
  'benchmark.trusted_generalist_score': {
    label: 'Trusted generalist score',
    unit: 'score',
    description: 'Confidence-weighted composite score for a model in the selected Benchmark host scope.',
    params: {
      model: { type: 'string', max: 200, required: true },
      hostScope: { type: 'enum', values: ['current', 'primary', 'all'], default: 'current' }
    }
  }
};

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getDefinition(adapter) {
  const definition = DEFINITIONS[adapter];
  if (!definition) {
    throw new PlanningMetricError(`Unknown Planning metric adapter: ${adapter}`, {
      code: 'UNKNOWN_PLANNING_METRIC_ADAPTER'
    });
  }
  return definition;
}

function cleanParam(name, value, rule) {
  if (value == null || value === '') return undefined;
  if (rule.type === 'enum') {
    const normalized = String(value);
    if (!rule.values.includes(normalized)) {
      throw new PlanningMetricError(`${name} must be one of ${rule.values.join('|')}`);
    }
    return normalized;
  }
  if (rule.type === 'string') {
    const normalized = String(value).trim();
    if (normalized.length > rule.max) {
      throw new PlanningMetricError(`${name} exceeds ${rule.max} characters`);
    }
    if (normalized && rule.pattern && !(new RegExp(rule.pattern)).test(normalized)) {
      throw new PlanningMetricError(`${name} has an invalid format`);
    }
    return normalized || undefined;
  }
  if (rule.type === 'number') {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < rule.min || normalized > rule.max) {
      throw new PlanningMetricError(`${name} must be between ${rule.min} and ${rule.max}`);
    }
    return normalized;
  }
  throw new PlanningMetricError(`Unsupported parameter rule for ${name}`);
}

function validateParams(adapter, params = {}) {
  const definition = getDefinition(adapter);
  if (!plainObject(params)) {
    throw new PlanningMetricError('progress.metric.params must be an object');
  }
  if (JSON.stringify(params).length > 2000) {
    throw new PlanningMetricError('progress.metric.params exceeds 2000 characters');
  }
  const allowed = definition.params || {};
  const unknown = Object.keys(params).filter((key) => !Object.prototype.hasOwnProperty.call(allowed, key));
  if (unknown.length) {
    throw new PlanningMetricError(`Unsupported ${adapter} parameter(s): ${unknown.join(', ')}`);
  }
  const cleaned = {};
  for (const [name, rule] of Object.entries(allowed)) {
    const value = cleanParam(name, params[name], rule);
    if (value !== undefined) cleaned[name] = value;
    else if (rule.default !== undefined) cleaned[name] = rule.default;
    else if (rule.required) throw new PlanningMetricError(`${name} is required`);
  }
  if (definition.oneOf) {
    const selected = definition.oneOf.filter((name) => cleaned[name] !== undefined);
    if (selected.length !== 1) {
      throw new PlanningMetricError(`Exactly one of ${definition.oneOf.join('|')} is required`);
    }
  }
  return cleaned;
}

function validateBinding(adapter, params = {}) {
  const normalized = String(adapter || '').trim();
  if (!normalized) return { adapter: '', params: {} };
  return { adapter: normalized, params: validateParams(normalized, params) };
}

function catalog() {
  return Object.entries(DEFINITIONS).map(([adapter, definition]) => ({
    adapter,
    label: definition.label,
    unit: definition.unit,
    description: definition.description,
    params: definition.params
  }));
}

module.exports = {
  ALERT_STATUSES,
  ALERT_SEVERITIES,
  DEFINITIONS,
  PlanningMetricError,
  getDefinition,
  validateParams,
  validateBinding,
  catalog
};
