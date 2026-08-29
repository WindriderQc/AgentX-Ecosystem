'use strict';

const fs = require('node:fs');
const path = require('node:path');

describe('Portal deployment identity UI', () => {
  test('renders the canonical consistency state instead of only reachable-service counts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../public/portal/index.html'),
      'utf8'
    );

    expect(source).toContain('const consistency = data.consistency || {}');
    expect(source).toContain("consistency.status === 'degraded'");
    expect(source).toContain('deployment mismatch');
    expect(source).toContain('consistencyIssues[0]');
    expect(source).toMatch(/Core, Benchmark, and RAG HTTP contracts/);
    expect(source).toMatch(/required dependency health/);
  });

  test('the front door links every supported full-profile Core workspace', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../public/portal/index.html'),
      'utf8'
    );

    for (const route of [
      '/playground', '/models', '/analytics', '/performance', '/prompts', '/council',
      '/nerve-center', '/agent-ops', '/cluster-schedule', '/memory-review', '/pipeline',
      '/planning', '/backup',
    ]) {
      expect(source).toContain(`data-public-path="${route}"`);
    }
    expect(source).toMatch(/Private deployment adapters do not expand the product portal/);
    expect(source).toContain('<body data-agentx-profile="full" data-agentx-surface="core-portal">');
  });
});
