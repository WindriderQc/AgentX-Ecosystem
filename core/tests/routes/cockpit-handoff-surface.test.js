const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('cockpit contextual handoffs', () => {
  test('Agent Ops emits bounded owner-interface context without mutation controls', () => {
    const source = read('public/js/agent-ops.js');
    expect(source).toContain("new URLSearchParams({ from: 'agent-ops' })");
    expect(source).toContain("pipelineContextHref({ task: task.pipelineId })");
    expect(source).toContain("pipelineContextHref({ assignee: agent.id, alias: agent.registryId })");
    expect(source).toContain('agentIdentityKeys(agent)');
    expect(source).toContain("nativeControlAttributes(nativeAgentPath(agent))");
    expect(source).toContain("nerveContextHref({ focus: 'health'");
    expect(source).not.toMatch(/method:\s*['"]POST['"]/);
  });

  test('Pipeline hydrates only an Agent Ops context and keeps global counts', () => {
    const source = read('public/js/pipeline.js');
    const view = read('views/pages/pipeline.ejs');
    expect(view).toContain('id="pipelineHandoffContext"');
    expect(source).toContain("params.get('from') !== 'agent-ops'");
    expect(source).toContain('state.tasks.filter(matchesContext)');
    expect(source).toContain("boundedParam(params, 'alias'");
    expect(source).toContain('renderCounts();');
    expect(source).toContain('Counts remain global');
  });

  test('Nerve Center reveals and spotlights the requested evidence section', () => {
    const source = read('public/js/nerve-center.js');
    const mode = read('public/js/nerve-center-mode.js');
    const view = read('views/pages/nerve-center.ejs');
    expect(view).toContain('id="ncHandoffContext"');
    expect(source).toContain("section.classList.add('nc-context-focus')");
    expect(source).toContain("chip.className = 'nc-context-chip'");
    expect(source).toContain("params.get('from') !== 'agent-ops'");
    expect(mode).toContain('queryTargetsDetail()');
  });
});
