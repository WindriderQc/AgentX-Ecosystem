'use strict';

/**
 * mockToolExecutor — the safe mocked-tool boundary for task 0468.
 * PURE + deterministic: executes ONLY tools defined in toolCallFixtures,
 * returns ONLY the scenario's scripted results/errors, and records a full
 * trace. There is no network, no filesystem, no database and no production
 * side effect anywhere in this module — by construction, not by convention.
 */

const { getToolByName } = require('./toolCallFixtures');

/**
 * Create an executor bound to one scenario's script.
 * Script entries are consumed per-tool in call order; a call with no
 * remaining script entry yields { error: 'unscripted_call' } so a runaway
 * agent is observable instead of invisible.
 */
function createMockToolExecutor(scenario) {
  const script = (scenario.scripted || []).slice();
  const trace = [];

  function execute(call) {
    const record = {
      ordinal: trace.length,
      name: call && call.name,
      args: (call && call.args) || {},
      known: false,
      offered: false,
      scripted: false,
      result: null,
      error: null
    };

    const tool = call && call.name ? getToolByName(call.name) : null;
    record.known = !!tool;
    record.offered = !!tool && (scenario.tools || []).includes(call.name);

    if (!record.known || !record.offered) {
      // Unknown or un-offered tool: refuse deterministically, zero effects.
      record.error = record.known ? 'tool_not_offered' : 'unknown_tool';
      trace.push(record);
      return { error: record.error };
    }

    const idx = script.findIndex((s) => s.tool === call.name);
    if (idx === -1) {
      record.error = 'unscripted_call';
      trace.push(record);
      return { error: 'unscripted_call' };
    }

    const step = script.splice(idx, 1)[0];
    record.scripted = true;
    if (step.error) {
      record.error = step.error;
      trace.push(record);
      return { error: step.error };
    }
    record.result = step.result;
    trace.push(record);
    return step.result;
  }

  return {
    execute,
    getTrace: () => trace.slice(),
    remainingScript: () => script.length
  };
}

module.exports = { createMockToolExecutor };
