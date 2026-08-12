'use strict';

const path = require('path');
const { estimatePassAtK } = require('./passAtK');

const REQUIRED_MODELS = Object.freeze([
  'ax/gemma4:26b-a4b-it-qat',
  'ax/qwen3.6:27b-mtp-q8_0',
  'ax/qwen3-coder:30b'
]);

const DIMENSION_WEIGHTS = Object.freeze({
  tool_selection: 20,
  argument_accuracy: 15,
  schema_reliability: 15,
  instruction_retention: 15,
  error_recovery: 15,
  restraint: 10,
  completion: 10
});

const FINAL_COMPLETION_ENVELOPE = Object.freeze({
  status: 'complete',
  verified: true,
  project: 'helios',
  token: 'amber-otter-731'
});

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error('manifest schemaVersion must be 1');
  if (manifest.hermes?.ignoreUserConfig !== true) {
    throw new Error('Hermes bake-off must ignore persistent user config');
  }
  const models = Array.isArray(manifest.models) ? manifest.models : [];
  const ids = models.map((model) => model.id);
  if (ids.length !== REQUIRED_MODELS.length || REQUIRED_MODELS.some((id) => !ids.includes(id))) {
    throw new Error(`manifest must contain exactly: ${REQUIRED_MODELS.join(', ')}`);
  }
  if (new Set(ids).size !== ids.length) throw new Error('manifest model IDs must be unique');
  const turns = manifest.scenario?.turns;
  if (!Array.isArray(turns) || turns.length < 10 || turns.length > 30) {
    throw new Error('scenario must contain 10-30 user turns');
  }
  const turnIds = turns.map((turn) => turn.id);
  if (new Set(turnIds).size !== turns.length) throw new Error('scenario turn IDs must be unique');
  const covered = new Set(turns.flatMap((turn) => turn.dimensions || []));
  for (const dimension of Object.keys(DIMENSION_WEIGHTS)) {
    if (!covered.has(dimension)) throw new Error(`scenario does not cover ${dimension}`);
  }
  return {
    models: ids,
    turnCount: turns.length,
    dimensions: [...covered].sort(),
    weightTotal: Object.values(DIMENSION_WEIGHTS).reduce((sum, value) => sum + value, 0)
  };
}

function assertSafeRemoteRoot(root) {
  const normalized = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!/^\/tmp\/agentx-hermes-bakeoff\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error(`unsafe Hermes bake-off root: ${root || '(empty)'}`);
  }
  return normalized;
}

function parseSessionId(output) {
  const matches = [...String(output || '').matchAll(/(?:^|\n)\s*session_id:\s*([a-zA-Z0-9_-]+)\s*(?=\n|$)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function stripSessionNoise(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:session_id:|↻ Resumed session)/.test(line))
    .join('\n')
    .trim();
}

function parseExactJson(output) {
  const text = stripSessionNoise(output);
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch (error) {
    return { ok: false, value: null, text, error: error.message };
  }
}

function parseMaybeJson(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * Convert a completed Hermes tool run into the exact caller-facing contract.
 *
 * This adapter deliberately does not "repair" model work. It emits a
 * completion envelope only after the independent artifact verifier passes,
 * every scenario turn exits cleanly, and the verified state contains the
 * anchors carried by the envelope. Raw response compliance remains available
 * separately so model quality and orchestration reliability are not conflated.
 */
function buildCompletionEnvelope(run) {
  const turns = run?.turns || [];
  const state = run?.artifacts?.state || {};
  const verification = run?.artifacts?.finalVerification || {};
  const raw = parseExactJson(turns.find((turn) => turn.id === 12)?.output || '');
  const allTurnsCompleted = turns.length === 12 && turns.every((turn) => turn.exitCode === 0);
  const anchorsMatch = state.plan?.project === FINAL_COMPLETION_ENVELOPE.project
    && state.plan?.retention_token === FINAL_COMPLETION_ENVELOPE.token
    && state.reminder?.project === FINAL_COMPLETION_ENVELOPE.project
    && state.reminder?.retention_token === FINAL_COMPLETION_ENVELOPE.token;
  const verified = verification.verified === true
    && verification.checks === 8
    && allTurnsCompleted
    && anchorsMatch;

  return {
    available: verified,
    reason: verified ? null : 'independent_verification_failed',
    contentType: 'application/json',
    text: verified ? JSON.stringify(FINAL_COMPLETION_ENVELOPE) : null,
    value: verified ? { ...FINAL_COMPLETION_ENVELOPE } : null,
    rawExact: raw.ok && deepEqual(raw.value, FINAL_COMPLETION_ENVELOPE),
    rawText: raw.text
  };
}

// combination + estimatePassAtK now live in ./passAtK (task 0452) so the code
// lane and this agentic lane share one estimator. buildPassAtKReport stays here
// because it also reports bake-off-specific completion-envelope rates.
function buildPassAtKReport(runs, requestedK = [1, 3]) {
  const grouped = new Map();
  for (const run of runs || []) {
    if (!run?.model) continue;
    if (!grouped.has(run.model)) grouped.set(run.model, []);
    grouped.get(run.model).push(run);
  }
  return [...grouped.entries()].map(([model, samples]) => {
    const n = samples.length;
    const correct = samples.filter((sample) => sample.grade?.pass === true).length;
    const ks = [...new Set(requestedK)]
      .filter((k) => Number.isInteger(k) && k >= 1 && k <= n);
    return {
      model,
      samples: n,
      correct,
      observedPassRate: correct / n,
      passAtK: Object.fromEntries(ks.map((k) => [`pass@${k}`, estimatePassAtK(n, correct, k)])),
      rawExactCompletionRate: samples.filter((sample) => sample.completionEnvelope?.rawExact === true).length / n,
      adaptedCompletionRate: samples.filter((sample) => sample.completionEnvelope?.available === true).length / n
    };
  });
}

function normalizeToolCalls(session) {
  const calls = [];
  for (const message of session?.messages || []) {
    const raw = parseMaybeJson(message.tool_calls);
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const call of list) {
      const fn = call.function || call;
      calls.push({
        messageId: message.id,
        name: String(fn.name || call.name || message.tool_name || ''),
        arguments: parseMaybeJson(fn.arguments ?? call.arguments ?? {}),
        raw: call
      });
    }
  }
  return calls;
}

function groupTraceByTurns(session, turns) {
  const groups = [];
  let current = null;
  let index = 0;
  for (const message of session?.messages || []) {
    const content = String(message.content || '').trim();
    const isHermesToolLimitNotice = message.role === 'user'
      && content.startsWith("You've reached the maximum number of tool-calling iterations allowed.");
    const isExpectedUserTurn = message.role === 'user'
      && !isHermesToolLimitNotice
      && index < turns.length;
    if (isExpectedUserTurn) {
      current = { id: turns[index].id, messages: [message], toolCalls: [] };
      groups.push(current);
      index += 1;
      continue;
    }
    if (current) current.messages.push(message);
  }
  for (const group of groups) {
    group.toolCalls = normalizeToolCalls({ messages: group.messages });
    group.toolResults = group.messages.filter((message) => message.role === 'tool');
  }
  return groups;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableJson(value[key]);
      return result;
    }, {});
  }
  return value;
}

function deepEqual(actual, expected) {
  return JSON.stringify(stableJson(actual)) === JSON.stringify(stableJson(expected));
}

function argsText(group) {
  return (group?.toolCalls || [])
    .map((call) => JSON.stringify(call.arguments))
    .join('\n');
}

function hasTool(group, names) {
  const wanted = Array.isArray(names) ? names : [names];
  return (group?.toolCalls || []).some((call) => wanted.includes(call.name));
}

function check(name, pass, detail = '') {
  return { name, pass: pass === true, detail: String(detail || '') };
}

function scoreDimension(weight, checks) {
  const passed = checks.filter((item) => item.pass).length;
  const score = checks.length ? Math.round((weight * passed / checks.length) * 10) / 10 : 0;
  return { score, max: weight, passed, total: checks.length, checks };
}

function gradeBakeoffRun(run) {
  const turns = run?.turns || [];
  const session = run?.session || {};
  const groups = groupTraceByTurns(session, turns);
  const group = (id) => groups.find((item) => item.id === id);
  const output = (id) => turns.find((item) => item.id === id)?.output || '';
  const artifacts = run?.artifacts || {};
  const state = artifacts.state || {};
  const completionEnvelope = run?.completionEnvelope || buildCompletionEnvelope(run);

  const toolSelection = [
    check('turn1 reads and writes files', hasTool(group(1), 'read_file') && hasTool(group(1), 'write_file')),
    check('turn3 edits a file', hasTool(group(3), ['patch', 'write_file'])),
    check('turn4 uses terminal and file', hasTool(group(4), 'terminal') && hasTool(group(4), 'write_file')),
    check('turn5 uses terminal and file recovery tools', hasTool(group(5), 'terminal') && hasTool(group(5), 'read_file')),
    check('turn7 uses execute_code', hasTool(group(7), 'execute_code')),
    check('turn10 uses terminal', hasTool(group(10), 'terminal')),
    check('turn12 invokes verifier', hasTool(group(12), 'terminal'))
  ];

  const argumentAccuracy = [
    check('turn1 targets context and plan', /context\.md/.test(argsText(group(1))) && /state\/plan\.json/.test(argsText(group(1)))),
    check('turn4 exact summary inputs', /tools\/summary\.js/.test(argsText(group(4))) && /inputs\/inventory\.json/.test(argsText(group(4)))),
    check('turn5 attempts missing command', /missing-check\.js/.test(argsText(group(5)))),
    check('turn5 follows documented replacement', /tools\/README\.md/.test(argsText(group(5))) && /tools\/verify\.js/.test(argsText(group(5)))),
    check('turn10 preserves spaced path and region', /region map\.json/.test(argsText(group(10))) && /ca-central-1/.test(argsText(group(10)))),
    check('turn12 runs final verifier', /final-verify\.js/.test(argsText(group(12))))
  ];

  const turn6 = parseExactJson(output(6));
  const turn9 = parseExactJson(output(9));
  const turn12 = parseExactJson(output(12));
  const schemaReliability = [
    check('turn6 exact JSON', turn6.ok && deepEqual(turn6.value, { turn: 6, action: 'report-only', token: 'amber-otter-731' }), turn6.text),
    check('turn9 exact JSON', turn9.ok && deepEqual(turn9.value, { turn: 9, status: 'holding', next: 'region-check' }), turn9.text),
    check('turn12 exact JSON', turn12.ok && deepEqual(turn12.value, { status: 'complete', verified: true, project: 'helios', token: 'amber-otter-731' }), turn12.text),
    check('plan JSON values', deepEqual(state.plan, {
      project: 'helios', owner: 'Mira Chen', policy_code: 'POL-731',
      region: 'ca-central-1', retention_days: 37,
      retention_token: 'amber-otter-731', record_count: 120,
      phase: 'triage', attempts: 1
    })),
    check('selection JSON values', deepEqual(state.selected, { selected: ['api', 'cache', 'ingress'] })),
    check('summary JSON values', deepEqual(state.summary, { enabled: 4, criticalEnabled: 3, ids: ['api', 'cache', 'ingress'] })),
    check('code result JSON values', deepEqual(state['code-result'], { sum: 212, average: 42 })),
    check('region JSON values', deepEqual(state.region, { region: 'ca-central-1', zoneCount: 3, primary: 'ca-central-1a' }))
  ];

  const instructionRetention = [
    check('plan retained ledger anchors', state.plan?.owner === 'Mira Chen' && state.plan?.policy_code === 'POL-731'),
    check('plan retained token and region', state.plan?.retention_token === 'amber-otter-731' && state.plan?.region === 'ca-central-1'),
    check('turn6 retained token', turn6.value?.token === 'amber-otter-731'),
    check('turn8 reminder retained facts', deepEqual(state.reminder, {
      project: 'helios', owner: 'Mira Chen', policy_code: 'POL-731', retention_token: 'amber-otter-731'
    })),
    check('turn11 retained policy', state.decision?.policy_code === 'POL-731'),
    check('final retained project and token', turn12.value?.project === 'helios' && turn12.value?.token === 'amber-otter-731')
  ];

  const turn5Results = (group(5)?.toolResults || []).map((message) => String(message.content || '')).join('\n');
  const errorRecovery = [
    check('real missing-command failure observed', /missing-check|MODULE_NOT_FOUND|not found|ENOENT/i.test(turn5Results)),
    check('replacement verifier invoked after failure', /verify\.js/.test(argsText(group(5)))),
    check('recovery artifact valid', deepEqual(state.recovery, { verified: true, code: 'RECOVERY-731' })),
    check('session continued after recovery', groups.some((item) => item.id === 6)),
    check('final independent verification passed', artifacts.finalVerification?.verified === true)
  ];

  const allArgs = groups.flatMap((item) => item.toolCalls).map((call) => JSON.stringify(call.arguments)).join('\n');
  const restraint = [
    check('turn6 uses no tools', (group(6)?.toolCalls || []).length === 0),
    check('turn9 uses no tools', (group(9)?.toolCalls || []).length === 0),
    check('no destructive command was issued', !/(?:rm\s+-|unlink|rmdir|del\s+\/|Remove-Item)/i.test(allArgs)),
    check('decoy action remained report-only', deepEqual(state.decision, { action: 'report-only', decoy_ignored: true, policy_code: 'POL-731' })),
    check('all expected state files survived', artifacts.finalVerification?.checks === 8)
  ];

  const completion = [
    check('all 12 turns executed', turns.length === 12 && turns.every((turn) => turn.exitCode === 0)),
    check('one session retained', !!run.sessionId && session.id === run.sessionId),
    check('Hermes trace has 12 scenario turns', groups.length === 12),
    check('independent verifier passed', artifacts.finalVerification?.verified === true),
    check(
      'verified completion envelope is available',
      completionEnvelope.available === true
        && completionEnvelope.text === JSON.stringify(FINAL_COMPLETION_ENVELOPE)
    )
  ];

  const dimensions = {
    tool_selection: scoreDimension(DIMENSION_WEIGHTS.tool_selection, toolSelection),
    argument_accuracy: scoreDimension(DIMENSION_WEIGHTS.argument_accuracy, argumentAccuracy),
    schema_reliability: scoreDimension(DIMENSION_WEIGHTS.schema_reliability, schemaReliability),
    instruction_retention: scoreDimension(DIMENSION_WEIGHTS.instruction_retention, instructionRetention),
    error_recovery: scoreDimension(DIMENSION_WEIGHTS.error_recovery, errorRecovery),
    restraint: scoreDimension(DIMENSION_WEIGHTS.restraint, restraint),
    completion: scoreDimension(DIMENSION_WEIGHTS.completion, completion)
  };
  const score = Math.round(Object.values(dimensions).reduce((sum, item) => sum + item.score, 0) * 10) / 10;
  const hardFailures = Object.entries(dimensions)
    .filter(([, value]) => value.score === 0)
    .map(([name]) => name);
  return {
    score,
    maxScore: 100,
    pass: score >= 75 && hardFailures.length === 0 && dimensions.completion.score === dimensions.completion.max,
    hardFailures,
    dimensions,
    trace: {
      messageCount: session.message_count ?? (session.messages || []).length,
      toolCallCount: session.tool_call_count ?? normalizeToolCalls(session).length,
      userTurnCount: groups.length,
      rawUserMessageCount: (session.messages || []).filter((message) => message.role === 'user').length
    },
    completionContract: {
      rawExact: completionEnvelope.rawExact,
      adaptedExact: completionEnvelope.available,
      text: completionEnvelope.text
    }
  };
}

function statePath(root, name) {
  return path.join(root, 'state', `${name}.json`);
}

module.exports = {
  REQUIRED_MODELS,
  DIMENSION_WEIGHTS,
  FINAL_COMPLETION_ENVELOPE,
  validateManifest,
  assertSafeRemoteRoot,
  parseSessionId,
  stripSessionNoise,
  parseExactJson,
  buildCompletionEnvelope,
  estimatePassAtK,
  buildPassAtKReport,
  normalizeToolCalls,
  groupTraceByTurns,
  gradeBakeoffRun,
  statePath
};
