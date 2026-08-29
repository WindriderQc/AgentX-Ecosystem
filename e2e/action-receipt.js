'use strict';

const JOURNEY_PHASES = Object.freeze({
  'benchmark.stop-failure-recovery': Object.freeze([
    'active_observed',
    'stop_failed',
    'stop_acknowledged',
    'idle_recovered',
  ]),
  'prompts.validation-save-reload': Object.freeze([
    'revision_loaded',
    'validation_rejected',
    'save_conflict',
    'save_acknowledged',
    'revision_reloaded',
  ]),
  'playground.exact-turn-actions': Object.freeze([
    'duplicate_history_loaded',
    'ask_again_provenance_submitted',
    'retry_exposed',
    'retry_acknowledged',
  ]),
  'rag.ingest-delete-recovery': Object.freeze([
    'ingest_validation_rejected',
    'ingest_failed',
    'ingest_acknowledged',
    'source_opened',
    'chunk_keyboard_toggled',
    'delete_failed',
    'delete_acknowledged',
  ]),
});
const JOURNEY_IDENTITIES = Object.freeze({
  'benchmark.stop-failure-recovery': Object.freeze({ service: 'benchmark', surface: 'benchmark-home' }),
  'prompts.validation-save-reload': Object.freeze({ service: 'agentx-core', surface: 'core-prompts' }),
  'playground.exact-turn-actions': Object.freeze({ service: 'agentx-core', surface: 'core-playground' }),
  'rag.ingest-delete-recovery': Object.freeze({ service: 'agentx-rag', surface: 'rag-upload' }),
});
const EXPECTED_PHASES = JOURNEY_PHASES['benchmark.stop-failure-recovery'];
const EXPECTED_PROJECTS = Object.freeze([
  Object.freeze({ name: 'desktop-chromium', viewport: Object.freeze({ width: 1440, height: 900 }) }),
  Object.freeze({ name: 'mobile-chromium', viewport: Object.freeze({ width: 375, height: 667 }) }),
]);

function validateActionReceipt(receipt) {
  const errors = [];
  if (receipt?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (receipt?.kind !== 'agentx.browser-action-observation') errors.push('kind is invalid');
  if (receipt?.status !== 'pass') errors.push('receipt status must be pass');
  if (!['demo', 'full'].includes(receipt?.profile)) errors.push('profile must be demo or full');
  if (!/^[a-f0-9]{40}$/.test(receipt?.buildRevision || '')) errors.push('buildRevision must be a commit SHA');
  if (!/^[a-f0-9]{12}$/.test(receipt?.subjectHash || '')) errors.push('subjectHash must be a bounded hash');
  if (receipt?.evidenceMode !== 'deterministic-contract') errors.push('evidenceMode is invalid');
  const expectedPhases = JOURNEY_PHASES[receipt?.journeyId];
  const expectedIdentity = JOURNEY_IDENTITIES[receipt?.journeyId];
  if (!expectedPhases) errors.push('journeyId is unknown');
  if (expectedIdentity && (
    receipt?.serviceIdentity?.service !== expectedIdentity.service
    || receipt?.serviceIdentity?.surface !== expectedIdentity.surface
  )) {
    errors.push('serviceIdentity does not match journeyId');
  }
  if (!Array.isArray(receipt?.observations) || receipt.observations.length !== EXPECTED_PROJECTS.length) {
    errors.push('desktop and mobile project observations are both required');
  }

  for (const [index, observation] of (receipt?.observations || []).entries()) {
    const expectedProject = EXPECTED_PROJECTS[index];
    if (!expectedProject
        || observation.project !== expectedProject.name
        || observation.viewport?.width !== expectedProject.viewport.width
        || observation.viewport?.height !== expectedProject.viewport.height) {
      errors.push(`${observation.project || 'unknown project'} does not match the required project/viewport`);
    }
    const phaseIds = Array.isArray(observation.phases)
      ? observation.phases.map((phase) => phase.id)
      : [];
    if (!expectedPhases || JSON.stringify(phaseIds) !== JSON.stringify(expectedPhases)) {
      errors.push(`${observation.project || 'unknown project'} has incomplete or unordered phases`);
    }
    for (const phase of observation.phases || []) {
      if (phase.outcome !== 'pass') errors.push(`${observation.project}:${phase.id} did not pass`);
      const template = phase.request?.pathTemplate;
      if (template && (template.includes('://') || !template.startsWith('/'))) {
        errors.push(`${observation.project}:${phase.id} contains a non-template request path`);
      }
    }
  }

  const expectedSteps = (receipt?.observations?.length || 0) * (expectedPhases?.length || 0);
  if (receipt?.summary?.expectedSteps !== expectedSteps) errors.push('summary expectedSteps is inconsistent');
  if (receipt?.summary?.passed !== expectedSteps) errors.push('summary passed is inconsistent');
  if (receipt?.summary?.failed !== 0 || receipt?.summary?.missing !== 0) {
    errors.push('summary must fail closed for failed or missing steps');
  }

  const privacy = receipt?.privacy || {};
  for (const key of ['addressesIncluded', 'rawResponsesIncluded', 'subjectIdentifiersIncluded', 'secretsIncluded']) {
    if (privacy[key] !== false) errors.push(`privacy.${key} must be false`);
  }

  const serialized = JSON.stringify(receipt);
  if (/https?:\/\//i.test(serialized)) errors.push('receipt contains an origin or URL');
  return errors;
}

module.exports = {
  EXPECTED_PHASES,
  EXPECTED_PROJECTS,
  JOURNEY_IDENTITIES,
  JOURNEY_PHASES,
  validateActionReceipt,
};
