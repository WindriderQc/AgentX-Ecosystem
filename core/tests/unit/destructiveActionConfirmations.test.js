'use strict';

const fs = require('fs');
const path = require('path');

const CORE_ROOT = path.join(__dirname, '../..');

function source(relativePath) {
  return fs.readFileSync(path.join(CORE_ROOT, relativePath), 'utf8');
}

function routeBlock(code, declaration) {
  const start = code.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = code.indexOf('\nrouter.', start + declaration.length);
  return code.slice(start, next === -1 ? code.length : next);
}

describe('Core destructive-action confirmation coverage', () => {
  const routeContracts = {
    'routes/alerts-ops.js': [["router.delete('/rules/:ruleId'", "requireTypedConfirmation(req, res, 'DELETE ALERT RULE'"]],
    'routes/custom-models.js': [
      ["router.delete('/:id'", "requireTypedConfirmation(req, res, 'ARCHIVE CUSTOM MODEL'"],
      ["router.post('/:id/rollback'", "requireTypedConfirmation(req, res, 'ROLLBACK CUSTOM MODEL'"],
      ["router.post('/:id/deprecate'", "requireTypedConfirmation(req, res, 'DEPRECATE CUSTOM MODEL'"]
    ],
    'routes/history.js': [["router.delete('/:id/tags'", "requireTypedConfirmation(req, res, 'REMOVE CONVERSATION TAGS'"]],
    'routes/inference.js': [["router.post('/router/config/reset'", "requireTypedConfirmation(req, res, 'RESET ROUTER CONFIG'"]],
    'routes/model-registry.js': [
      ["router.delete('/:name'", "requireTypedConfirmation(req, res, 'RETIRE MODEL'"],
      ["router.delete('/:name/categories/:category'", "requireTypedConfirmation(req, res, 'REMOVE MODEL CATEGORY'"],
      ["router.delete('/:name/execution-config'", "requireTypedConfirmation(req, res, 'RESET MODEL EXECUTION CONFIG'"]
    ],
    'routes/models-unified.js': [["router.delete('/ollama/:name'", "requireTypedConfirmation(req, res, 'DELETE OLLAMA MODEL'"]],
    'routes/nerve-center-host-preferences.js': [["router.delete('/host-preferences/:hostUrl(*)/pin'", "requireTypedConfirmation(req, res, 'CLEAR HOST PIN'"]],
    'routes/ollama-vram.js': [["router.delete('/override/:hostIp'", "requireTypedConfirmation(req, res, 'CLEAR VRAM OVERRIDE'"]],
    'routes/performance-data.js': [["router.delete('/baselines/:id'", "requireTypedConfirmation(req, res, 'DELETE PERFORMANCE BASELINE'"]],
    'routes/planning.js': [
      ["router.delete('/items/:id'", "requireTypedConfirmation(req, res, 'ARCHIVE PLANNING ITEM'"],
      ["router.delete('/items/:id/tasks/:pipelineId'", "requireTypedConfirmation(req, res, 'UNLINK PLANNING TASK'"],
      ["router.delete('/items/:id/schedules/:sourceId'", "requireTypedConfirmation(req, res, 'UNLINK PLANNING SCHEDULE'"],
      ["router.delete('/items/:id/evidence/:evidenceId'", "requireTypedConfirmation(req, res, 'DELETE PLANNING EVIDENCE'"]
    ],
    'routes/prompt-templates.js': [["router.delete('/:id'", "requireTypedConfirmation(req, res, 'DELETE PROMPT TEMPLATE'"]],
    'routes/prompts.js': [["router.delete('/:id'", "requireTypedConfirmation(req, res, 'DELETE PROMPT'"]],
    'routes/rag.js': [["router.delete('/documents/:documentId'", "requireTypedConfirmation(req, res, 'DELETE RAG DOCUMENT'"]],
    'routes/roundtable.js': [["router.delete('/:id'", "requireTypedConfirmation(req, res, 'DELETE COUNCIL RECORD'"]]
  };

  test.each(Object.entries(routeContracts))('%s checks every destructive phrase inside the intended route', (file, contracts) => {
    const code = source(file);
    expect(code).toContain("require('../src/helpers/typedConfirmation')");
    for (const [declaration, phrase] of contracts) expect(routeBlock(code, declaration)).toContain(phrase);
  });

  const uiContracts = {
    'public/js/nerve-center-alerts.js': ['DELETE ALERT RULE'],
    'public/js/models-management.js': ['DELETE OLLAMA MODEL'],
    'public/js/models-execution-config.js': ['RESET MODEL EXECUTION CONFIG'],
    'public/js/nerve-center-cluster.js': ['CLEAR HOST PIN'],
    'public/js/performance-baselines.js': ['DELETE PERFORMANCE BASELINE'],
    'public/js/planning-editor.js': [
      'ARCHIVE PLANNING ITEM',
      'UNLINK PLANNING TASK',
      'UNLINK PLANNING SCHEDULE',
      'DELETE PLANNING EVIDENCE'
    ],
    'public/js/roundtable.js': ['DELETE COUNCIL RECORD']
  };

  test.each(Object.entries(uiContracts))('%s obtains the exact phrase from the operator', (file, phrases) => {
    const code = source(file);
    expect(code).toContain('AgentXTypedConfirmation.confirm');
    for (const phrase of phrases) expect(code).toContain(phrase);
  });

  test('loads the shared confirmation dialog before page-specific scripts', () => {
    const footer = source('views/partials/footer-scripts.ejs');
    expect(footer).toContain('<script src="/js/utils/typed-confirmation.js"></script>');
  });
});
