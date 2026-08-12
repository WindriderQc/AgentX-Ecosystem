'use strict';

/**
 * toolCallHarness — deterministic tool-call reliability harness (task 0468).
 *
 * The harness drives ONE transport through the fixture scenarios and grades
 * the resulting transcripts. A transport is any async function:
 *
 *   transport({ scenario, messages, tools }) -> {
 *     toolCalls?: [{ name, args }],   // model wants tool executions
 *     content?: string,               // model's visible final answer
 *     toolSupport?: boolean           // false => artifact has no tool surface
 *   }
 *
 * Two transports ship here:
 *   - makeScriptedTransport(goldenByScenario): replays reference transcripts —
 *     the golden dry-run. Zero network, zero model, zero side effects.
 *   - live Ollama transports are NOT constructed in this module; a controlled
 *     campaign builds one in scripts/toolcall-qualification.js behind the
 *     explicit campaign gate (see task constraints).
 *
 * Results separate tool-call/contract outcomes from ordinary response
 * quality: this harness NEVER emits a quality score. Unsupported and
 * no-final runs are explicit classifications, not zeros.
 */

const {
  FIXTURE_VERSION,
  HARNESS_VERSION,
  TOOLBOX_V1,
  SCENARIOS_V1,
  fixtureFingerprint,
  getToolByName
} = require('./toolCallFixtures');
const { createMockToolExecutor } = require('./mockToolExecutor');
const { gradeScenario } = require('./toolCallGrader');

/** Build the Ollama-style tools array offered on a scenario. */
function toolsForScenario(scenario) {
  return (scenario.tools || [])
    .map((name) => getToolByName(name))
    .filter(Boolean)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
}

/**
 * Run one scenario against a transport.
 * Loop: ask transport → if toolCalls, execute each via the mock executor and
 * append tool results to the message history → repeat until content (final)
 * or maxTurns. Deterministic by construction when the transport is scripted.
 */
async function runScenario(transport, scenario) {
  const executor = createMockToolExecutor(scenario);
  const messages = [{ role: 'user', content: scenario.prompt }];
  const calls = [];
  let finalText = null;
  let toolSupport = true;
  let turns = 0;

  while (turns < (scenario.maxTurns || 3)) {
    turns += 1;
    const reply = await transport({ scenario, messages: messages.slice(), tools: toolsForScenario(scenario) });

    if (reply && reply.toolSupport === false) {
      toolSupport = false;
      break;
    }
    if (reply && Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: '', tool_calls: reply.toolCalls });
      for (const call of reply.toolCalls) {
        calls.push({ name: call.name, args: call.args || {} });
        const result = executor.execute({ name: call.name, args: call.args || {} });
        messages.push({ role: 'tool', name: call.name, content: JSON.stringify(result) });
      }
      continue;
    }
    finalText = (reply && reply.content) || '';
    messages.push({ role: 'assistant', content: finalText });
    break;
  }

  const transcript = { calls, executions: executor.getTrace(), finalText, toolSupport };
  const grade = gradeScenario(transcript, scenario);
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    turns,
    transcript,
    ...grade
  };
}

/**
 * Run the full fixture suite.
 * @param {Function} transport
 * @param {Object} opts — {
 *   artifact: { model, digest, host },     identity from the capability contract
 *   contractSnapshot: Object|null,         deployed artifact+host contract, verbatim
 *   scenarios: [ids]|undefined             subset filter
 * }
 */
async function runHarness(transport, opts = {}) {
  const selected = opts.scenarios
    ? SCENARIOS_V1.filter((s) => opts.scenarios.includes(s.id))
    : SCENARIOS_V1;

  const perScenario = [];
  for (const scenario of selected) {
    // eslint-disable-next-line no-await-in-loop
    perScenario.push(await runScenario(transport, scenario));
  }

  const dimensionNames = ['selection', 'schemaValid', 'argsCorrect', 'execution', 'recovery', 'visibleFinal'];
  const byDimension = {};
  for (const d of dimensionNames) {
    const graded = perScenario.filter((r) => r.dimensions);
    byDimension[d] = {
      pass: graded.filter((r) => r.dimensions[d].pass).length,
      total: graded.length
    };
  }
  const classificationCounts = {};
  for (const r of perScenario) {
    classificationCounts[r.classification] = (classificationCounts[r.classification] || 0) + 1;
  }
  const gradedRuns = perScenario.filter((r) => r.dimensions);
  const passedRuns = gradedRuns.filter((r) => r.pass);

  return {
    harnessVersion: HARNESS_VERSION,
    fixtureVersion: FIXTURE_VERSION,
    fixtureFingerprint: fixtureFingerprint(),
    generatedAt: new Date().toISOString(),
    artifact: opts.artifact || { model: null, digest: null, host: null },
    contractSnapshot: opts.contractSnapshot || null,
    toolbox: TOOLBOX_V1.map((t) => t.name),
    // Tool-call/contract outcomes — deliberately separate from any quality
    // scoring surface; this harness does not produce quality numbers.
    toolCallOutcomes: {
      scenarios: perScenario.map(({ transcript, ...rest }) => rest),
      transcripts: perScenario.map((r) => ({ scenarioId: r.scenarioId, ...r.transcript })),
      byDimension,
      classificationCounts,
      reliability: {
        passed: passedRuns.length,
        graded: gradedRuns.length,
        ratio: gradedRuns.length ? Number((passedRuns.length / gradedRuns.length).toFixed(4)) : null
      }
    },
    quality: null // ordinary response quality is out of scope by design (0468)
  };
}

/**
 * Golden transport: replays each scenario's reference transcript. Used by the
 * dry-run and by unit tests; also the template for adversarial scripted
 * transports (pass a custom map to override any scenario's turns).
 */
function makeScriptedTransport(turnsByScenario = null) {
  const cursors = new Map();
  return async function scriptedTransport({ scenario }) {
    const script = (turnsByScenario && turnsByScenario[scenario.id]) || scenario.golden;
    const at = cursors.get(scenario.id) || 0;
    cursors.set(scenario.id, at + 1);
    const turn = script[Math.min(at, script.length - 1)];
    if (!turn) return { content: '' };
    return turn.toolSupport === false
      ? { toolSupport: false }
      : turn.toolCalls
        ? { toolCalls: turn.toolCalls }
        : { content: turn.content || '' };
  };
}

module.exports = {
  runScenario,
  runHarness,
  makeScriptedTransport,
  toolsForScenario
};
