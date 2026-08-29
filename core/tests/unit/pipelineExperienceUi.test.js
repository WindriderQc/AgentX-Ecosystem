'use strict';

const fs = require('node:fs');
const path = require('node:path');

describe('Pipeline open-work experience', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/pipeline.ejs'), 'utf8');
  const script = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');

  test('offers visible service, lane, and open-status filters', () => {
    for (const id of ['pipelineServiceFilter', 'pipelineLaneFilter', 'pipelineStatusFilter']) {
      expect(view).toContain(`id="${id}"`);
    }
    expect(script).toContain('function matchesFilters(task)');
    expect(script).toContain("task.source || 'unspecified'");
    expect(script).toMatch(/Showing \$\{openTasks\.length\} of \$\{allOpenTasks\.length\}/);
  });

  test('keeps the exact task title available even when layout constrains it', () => {
    expect(script).toMatch(/class="pipeline-title" title=/);
    expect(view).toMatch(/Heartbeat <small>\(active only\)<\/small>/);
  });
});
