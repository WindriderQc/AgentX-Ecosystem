'use strict';

/**
 * toolCallGrader — deterministic per-dimension grading of a tool-call
 * transcript (task 0468). PURE: no DB, no network, no LLM. The LLM judge is
 * NEVER an input; every dimension is decided from the transcript alone.
 *
 * Dimensions (each { pass, reason } — plus a run-level classification):
 *   selection      — called the expected tool (or correctly called nothing);
 *                    never touched a forbidden/unknown tool
 *   schemaValid    — every emitted call's arguments validate against the
 *                    fixture parameter schema (dependency-free subset)
 *   argsCorrect    — expected-argument checks pass on the first expected call
 *   execution      — every scripted-ok call executed without harness errors
 *   recovery       — scripted-error scenarios: retried corrected OR reported
 *                    honestly; never claimed success after a failed call
 *   visibleFinal   — a non-empty final assistant text exists, matches the
 *                    scenario's final contract, and leaks no tool XML
 *
 * Classification (explicit, never silently folded into quality):
 *   'ok' | 'unsupported_no_tool_call_surface' | 'no_final_answer' |
 *   'hallucinated_call' | 'leaked_tool_xml' | 'contract_violation'
 */

const { detectToolXmlLeak } = require('./capabilityGrader');
const { getToolByName } = require('./toolCallFixtures');

/**
 * Dependency-free validator for the fixture schema subset:
 * type object/string/number/integer/boolean/array, properties, required,
 * enum, minimum, maximum, items. Returns { valid, errors: [strings] }.
 */
function validateArgsAgainstSchema(args, schema) {
  const errors = [];

  function typeOf(v) {
    if (Array.isArray(v)) return 'array';
    if (v === null) return 'null';
    return typeof v;
  }

  function check(value, node, path) {
    if (!node || typeof node !== 'object') return;
    const t = node.type;
    const actual = typeOf(value);

    if (t === 'object') {
      if (actual !== 'object') { errors.push(`${path}: expected object, got ${actual}`); return; }
      const props = node.properties || {};
      for (const req of node.required || []) {
        if (value[req] === undefined) errors.push(`${path}.${req}: required property missing`);
      }
      for (const [k, v] of Object.entries(value)) {
        if (props[k]) check(v, props[k], `${path}.${k}`);
        else errors.push(`${path}.${k}: unexpected property`);
      }
      return;
    }
    if (t === 'string') {
      if (actual !== 'string') { errors.push(`${path}: expected string, got ${actual}`); return; }
    } else if (t === 'number') {
      if (actual !== 'number') { errors.push(`${path}: expected number, got ${actual}`); return; }
    } else if (t === 'integer') {
      if (actual !== 'number' || !Number.isInteger(value)) { errors.push(`${path}: expected integer, got ${actual}`); return; }
    } else if (t === 'boolean') {
      if (actual !== 'boolean') { errors.push(`${path}: expected boolean, got ${actual}`); return; }
    } else if (t === 'array') {
      if (actual !== 'array') { errors.push(`${path}: expected array, got ${actual}`); return; }
      if (node.items) value.forEach((item, i) => check(item, node.items, `${path}[${i}]`));
      return;
    }
    if (node.enum && !node.enum.includes(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} not in enum [${node.enum.join(', ')}]`);
    }
    if (node.minimum !== undefined && typeof value === 'number' && value < node.minimum) {
      errors.push(`${path}: ${value} < minimum ${node.minimum}`);
    }
    if (node.maximum !== undefined && typeof value === 'number' && value > node.maximum) {
      errors.push(`${path}: ${value} > maximum ${node.maximum}`);
    }
  }

  check(args || {}, schema, '$');
  return { valid: errors.length === 0, errors };
}

function getPath(obj, path) {
  return String(path).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function argCheckPasses(args, checkSpec) {
  const value = getPath(args, checkSpec.path);
  if (checkSpec.equals !== undefined) return value === checkSpec.equals;
  if (checkSpec.matches !== undefined) {
    return typeof value === 'string' && new RegExp(checkSpec.matches, 'i').test(value);
  }
  if (checkSpec.oneOf !== undefined) return checkSpec.oneOf.includes(value);
  return value !== undefined;
}

/**
 * Grade one scenario transcript.
 * @param {Object} transcript — {
 *   calls: [{ name, args }],            every tool call the model emitted, in order
 *   executions: [trace records],        from mockToolExecutor.getTrace()
 *   finalText: string|null,             the final visible assistant text
 *   toolSupport: boolean                whether the transport reported a
 *                                       tool-call surface for this artifact
 * }
 * @param {Object} scenario — a SCENARIOS_V1 entry
 * @returns {Object} { dimensions, classification, pass, reasons }
 */
function gradeScenario(transcript, scenario) {
  const expect = scenario.expect || {};
  const calls = transcript.calls || [];
  const execs = transcript.executions || [];
  const finalText = (transcript.finalText || '').trim();

  // --- explicit unsupported classification (criterion 3) -----------------
  if (transcript.toolSupport === false) {
    return {
      dimensions: null,
      classification: 'unsupported_no_tool_call_surface',
      pass: false,
      reasons: ['artifact/contract reports no tool-call surface; run is classified, not scored']
    };
  }

  const dims = {};

  // --- selection ----------------------------------------------------------
  const calledNames = calls.map((c) => c.name);
  const forbiddenHit = (expect.forbiddenCalls || []).find((f) => calledNames.includes(f)) || null;
  const unknownHit = calledNames.find((n) => !getToolByName(n)) || null;
  const expectedCalls = expect.mustCall ? calls.filter((c) => c.name === expect.mustCall) : [];
  let selectionPass;
  let selectionReason;
  if (unknownHit) {
    selectionPass = false;
    selectionReason = `hallucinated unknown tool ${unknownHit}`;
  } else if (forbiddenHit) {
    selectionPass = false;
    selectionReason = `called forbidden tool ${forbiddenHit}`;
  } else if (expect.mustCall) {
    selectionPass = expectedCalls.length > 0;
    selectionReason = selectionPass
      ? `called ${expect.mustCall}`
      : `never called ${expect.mustCall} (called: ${calledNames.join(', ') || 'nothing'})`;
  } else {
    selectionPass = calls.length === 0;
    selectionReason = selectionPass
      ? 'correctly made no tool call'
      : `made unnecessary call(s): ${calledNames.join(', ')}`;
  }
  dims.selection = { pass: selectionPass, reason: selectionReason };

  // --- schema validity (every emitted call, known tools only) -------------
  const schemaErrors = [];
  for (const call of calls) {
    const tool = getToolByName(call.name);
    if (!tool) continue; // unknown tools already fail selection
    const { valid, errors } = validateArgsAgainstSchema(call.args, tool.parameters);
    if (!valid) schemaErrors.push(`${call.name}: ${errors.join('; ')}`);
  }
  dims.schemaValid = {
    pass: schemaErrors.length === 0,
    reason: schemaErrors.length === 0
      ? (calls.length ? 'all call arguments validate' : 'no calls to validate')
      : schemaErrors.join(' | ')
  };

  // --- argument correctness (first expected call) --------------------------
  if (expect.mustCall && (expect.argChecks || []).length) {
    const first = expectedCalls[0];
    if (!first) {
      dims.argsCorrect = { pass: false, reason: 'no expected call to check arguments on' };
    } else {
      const failed = expect.argChecks.filter((c) => !argCheckPasses(first.args, c));
      dims.argsCorrect = {
        pass: failed.length === 0,
        reason: failed.length === 0
          ? 'expected argument checks pass'
          : failed.map((c) => `arg ${c.path} failed ${JSON.stringify(c)} against ${JSON.stringify(getPath(first.args, c.path))}`).join(' | ')
      };
    }
  } else {
    dims.argsCorrect = { pass: true, reason: 'no argument checks for this scenario' };
  }

  // --- execution -----------------------------------------------------------
  const harnessFaults = execs.filter((e) => e.error === 'unscripted_call' || e.error === 'unknown_tool' || e.error === 'tool_not_offered');
  dims.execution = {
    pass: harnessFaults.length === 0,
    reason: harnessFaults.length === 0
      ? 'no unscripted/unknown/un-offered executions'
      : harnessFaults.map((e) => `${e.name}: ${e.error}`).join(' | ')
  };

  // --- recovery (scripted-error scenarios only) ----------------------------
  if (expect.recovery) {
    const spec = expect.recovery;
    const erroredOrdinal = execs.findIndex((e) => e.scripted && e.error);
    if (erroredOrdinal === -1) {
      dims.recovery = { pass: false, reason: 'scripted error was never triggered' };
    } else {
      const laterCalls = execs.slice(erroredOrdinal + 1).filter((e) => e.scripted && !e.error);
      const retriedCorrected = spec.retryArgMatches
        ? laterCalls.some((e) => argCheckPasses(e.args, spec.retryArgMatches))
        : laterCalls.length > 0;
      const claimedFalseSuccess = (spec.mustNotClaimSuccess || [])
        .some((s) => finalText.toLowerCase().includes(String(s).toLowerCase()));
      const honestFailure = !retriedCorrected && finalText.length > 0 && !claimedFalseSuccess;
      dims.recovery = {
        pass: (retriedCorrected || honestFailure) && !claimedFalseSuccess,
        reason: claimedFalseSuccess
          ? 'claimed success after a failed tool call'
          : retriedCorrected
            ? 'retried with corrected arguments after the scripted error'
            : honestFailure
              ? 'reported the failure honestly without a retry'
              : 'neither corrected retry nor honest failure report'
      };
    }
  } else {
    dims.recovery = { pass: true, reason: 'no scripted error in this scenario' };
  }

  // --- visible final answer -------------------------------------------------
  const leaked = detectToolXmlLeak(finalText);
  const finalMatchers = (expect.finalMustMatch || []).map((m) => new RegExp(m, 'i'));
  const finalBlockers = (expect.finalMustNotMatch || []).map((m) => new RegExp(m, 'i'));
  const matchOk = finalMatchers.length === 0 || finalMatchers.some((r) => r.test(finalText));
  const blockerHit = finalBlockers.find((r) => r.test(finalText)) || null;
  dims.visibleFinal = {
    pass: finalText.length > 0 && matchOk && !blockerHit && !leaked,
    reason: !finalText.length
      ? 'no visible final answer'
      : leaked
        ? 'tool-call XML leaked into the final answer'
        : blockerHit
          ? `final answer matched a forbidden pattern ${blockerHit}`
          : matchOk
            ? 'final answer present and matches the contract'
            : 'final answer does not match any required pattern'
  };

  // --- classification + verdict ---------------------------------------------
  let classification = 'ok';
  if (!finalText.length) classification = 'no_final_answer';
  else if (leaked) classification = 'leaked_tool_xml';
  else if (unknownHit) classification = 'hallucinated_call';
  else if (!selectionPass || !dims.schemaValid.pass || !dims.argsCorrect.pass || !dims.execution.pass || !dims.recovery.pass || !dims.visibleFinal.pass) {
    classification = 'contract_violation';
  }

  const pass = Object.values(dims).every((d) => d.pass);
  return {
    dimensions: dims,
    classification,
    pass,
    reasons: Object.entries(dims).map(([k, v]) => `${k}: ${v.reason}`)
  };
}

module.exports = {
  gradeScenario,
  validateArgsAgainstSchema,
  argCheckPasses,
  getPath
};
