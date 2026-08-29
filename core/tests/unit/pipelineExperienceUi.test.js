'use strict';

const fs = require('node:fs');
const path = require('node:path');

describe('Pipeline open-work experience', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/pipeline.ejs'), 'utf8');
  const script = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');

  test('offers visible service, lane, and status-card filters', () => {
    for (const id of ['pipelineServiceFilter', 'pipelineLaneFilter']) {
      expect(view).toContain(`id="${id}"`);
    }
    for (const status of ['queued', 'in_progress', 'review', 'blocked', 'done']) {
      expect(view).toContain(`data-status-filter="${status}"`);
    }
    expect(script).toContain('function matchesFilters(task)');
    expect(script).toContain("task.source || 'unspecified'");
    expect(script).toMatch(/\$\{tasks\.length\} matching loaded \$\{scope\}/);
  });

  test('keeps the exact task title available even when layout constrains it', () => {
    expect(script).toMatch(/class="pipeline-title" title=/);
    expect(view).toContain('<th scope="col">Activity</th>');
    expect(script).toContain('return `Heartbeat ${relativeTime(task.heartbeatAt)}`');
  });

  test('labels exact MongoDB count evidence separately from loaded rows', () => {
    expect(view).toContain('id="pipelineCountEvidence"');
    expect(script).toContain("fetchJson('/api/pipeline/tasks?limit=1000&view=summary&includeDone=true')");
    expect(script).toContain("evidence?.authority !== 'core.pipeline'");
    expect(script).toMatch(/exact full-scope totals/);
  });
});
