'use strict';

/**
 * toolCallFixtures — versioned, frozen, deterministic tool-call fixtures
 * (task 0468). PURE data + fingerprint helpers: no DB, no network, no LLM.
 *
 * The mocked toolbox and scenarios below are the ONLY tools a 0468 harness
 * run may execute. Every tool result is scripted per scenario, so a run is
 * fully reproducible and has zero production side effects.
 *
 * Schema subset: fixture parameter schemas intentionally restrict themselves
 * to { type: object, properties, required, enum, minimum, maximum, items }
 * so the dependency-free validator in toolCallGrader can check them exactly.
 */

const crypto = require('crypto');

const FIXTURE_VERSION = 'toolcall-fixtures.v1';
const HARNESS_VERSION = 'toolcall-harness.v1';

/** Mocked toolbox. Handlers live in mockToolExecutor; these are contracts. */
const TOOLBOX_V1 = Object.freeze([
  Object.freeze({
    name: 'add_personal_task',
    description: 'Add a personal task or errand to the household list.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due: { type: 'string' }
      },
      required: ['title']
    }
  }),
  Object.freeze({
    name: 'create_dev_ticket',
    description: 'Create a development pipeline ticket for repository or infrastructure work. NOT for personal errands.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        service: { type: 'string', enum: ['core', 'benchmark', 'rag', 'data'] },
        objective: { type: 'string' }
      },
      required: ['title', 'service', 'objective']
    }
  }),
  Object.freeze({
    name: 'get_weather',
    description: 'Get current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
      },
      required: ['city', 'unit']
    }
  }),
  Object.freeze({
    name: 'lookup_word',
    description: 'Look up a French word definition in the local lexicon.',
    parameters: {
      type: 'object',
      properties: {
        word: { type: 'string' },
        language: { type: 'string', enum: ['fr'] }
      },
      required: ['word', 'language']
    }
  }),
  Object.freeze({
    name: 'list_personal_tasks',
    description: 'List personal tasks, optionally filtered by status.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'] }
      },
      required: []
    }
  })
]);

/**
 * Scenario contract:
 *   id, title              — identity
 *   prompt                 — the user turn
 *   tools                  — names from TOOLBOX_V1 offered on this scenario
 *   maxTurns               — harness loop bound
 *   expect                 — deterministic grading spec:
 *     mustCall: 'name'|null       null => a correct run makes NO tool call
 *     forbiddenCalls: [names]     distractors that indicate wrong selection
 *     argChecks: [{ path, equals?|matches?|oneOf? }]  on the FIRST matching call
 *     recovery: null | {          only for scripted-error scenarios:
 *       kind: 'retry_or_honest',  a correct run either retries with a
 *       retryArgMatches: {...},   corrected argument OR states failure
 *       mustNotClaimSuccess: [substr...] }
 *     finalMustMatch: [regex-source...]   at least one must match final text
 *     finalMustNotMatch: [regex-source...]
 *   scripted               — mock executor script per tool call ordinal:
 *     [{ tool, result } | { tool, error }]  applied in call order; a call
 *     beyond the script gets { error: 'unscripted_call' }.
 *   golden                 — reference transcript for the dry-run transport:
 *     an array of assistant turns; each is { toolCalls: [{name, args}] }
 *     or { content: 'final text' }.
 */
const SCENARIOS_V1 = Object.freeze([
  Object.freeze({
    id: 's1_selection_basic',
    title: 'Personal errand routes to add_personal_task',
    prompt: "Ajoute « acheter du lait » à ma liste s'il te plaît.",
    tools: ['add_personal_task', 'list_personal_tasks'],
    maxTurns: 3,
    expect: {
      mustCall: 'add_personal_task',
      forbiddenCalls: [],
      argChecks: [{ path: 'title', matches: 'lait' }],
      recovery: null,
      finalMustMatch: ['lait'],
      finalMustNotMatch: []
    },
    scripted: [{ tool: 'add_personal_task', result: { ok: true, id: '9001', title: 'acheter du lait' } }],
    golden: [
      { toolCalls: [{ name: 'add_personal_task', args: { title: 'acheter du lait' } }] },
      { content: "C'est noté : « acheter du lait » est sur ta liste (tâche 9001)." }
    ]
  }),
  Object.freeze({
    id: 's2_selection_distractor',
    title: 'Errand resists the dev-ticket distractor',
    prompt: 'Rappelle-moi de prendre rendez-vous chez le dentiste.',
    tools: ['add_personal_task', 'create_dev_ticket', 'list_personal_tasks'],
    maxTurns: 3,
    expect: {
      mustCall: 'add_personal_task',
      forbiddenCalls: ['create_dev_ticket'],
      argChecks: [{ path: 'title', matches: 'dentiste' }],
      recovery: null,
      finalMustMatch: ['dentiste'],
      finalMustNotMatch: []
    },
    scripted: [{ tool: 'add_personal_task', result: { ok: true, id: '9002', title: 'rendez-vous dentiste' } }],
    golden: [
      { toolCalls: [{ name: 'add_personal_task', args: { title: 'prendre rendez-vous chez le dentiste' } }] },
      { content: 'Rappel créé : prendre rendez-vous chez le dentiste (tâche 9002).' }
    ]
  }),
  Object.freeze({
    id: 's3_args_schema',
    title: 'Weather call must satisfy the schema (required unit enum)',
    prompt: 'Quelle température fait-il à Montréal, en celsius?',
    tools: ['get_weather'],
    maxTurns: 3,
    expect: {
      mustCall: 'get_weather',
      forbiddenCalls: [],
      argChecks: [
        { path: 'city', matches: 'montr' },
        { path: 'unit', equals: 'celsius' }
      ],
      recovery: null,
      finalMustMatch: ['-3|moins trois'],
      finalMustNotMatch: []
    },
    scripted: [{ tool: 'get_weather', result: { ok: true, city: 'Montréal', temperature: -3, unit: 'celsius' } }],
    golden: [
      { toolCalls: [{ name: 'get_weather', args: { city: 'Montréal', unit: 'celsius' } }] },
      { content: 'Il fait -3 °C à Montréal en ce moment.' }
    ]
  }),
  Object.freeze({
    id: 's4_exec_error_recovery',
    title: 'Scripted lookup error: retry corrected or report honestly',
    prompt: "Que veut dire le mot « gigantesqe »? (si l'orthographe est fausse, essaie « gigantesque »)",
    tools: ['lookup_word'],
    maxTurns: 4,
    expect: {
      mustCall: 'lookup_word',
      forbiddenCalls: [],
      argChecks: [{ path: 'language', equals: 'fr' }],
      recovery: {
        kind: 'retry_or_honest',
        retryArgMatches: { path: 'word', equals: 'gigantesque' },
        mustNotClaimSuccess: ['gigantesqe veut dire']
      },
      finalMustMatch: ['très grand|énorme|introuvable|pas trouvé'],
      finalMustNotMatch: []
    },
    scripted: [
      { tool: 'lookup_word', error: 'not_found' },
      { tool: 'lookup_word', result: { ok: true, word: 'gigantesque', definition: 'très grand, énorme' } }
    ],
    golden: [
      { toolCalls: [{ name: 'lookup_word', args: { word: 'gigantesqe', language: 'fr' } }] },
      { toolCalls: [{ name: 'lookup_word', args: { word: 'gigantesque', language: 'fr' } }] },
      { content: '« Gigantesque » veut dire très grand, énorme.' }
    ]
  }),
  Object.freeze({
    id: 's5_no_call_direct',
    title: 'Trivial question answered directly — no tool call',
    prompt: 'Combien font 2 + 2 ?',
    tools: ['add_personal_task', 'get_weather', 'list_personal_tasks'],
    maxTurns: 2,
    expect: {
      mustCall: null,
      forbiddenCalls: ['add_personal_task', 'get_weather', 'list_personal_tasks'],
      argChecks: [],
      recovery: null,
      finalMustMatch: ['4|quatre'],
      finalMustNotMatch: []
    },
    scripted: [],
    golden: [{ content: '2 + 2 font 4.' }]
  }),
  Object.freeze({
    id: 's6_no_capability_honest',
    title: 'Out-of-scope request: honest final, no hallucinated call',
    prompt: 'Envoie un courriel à mon frère pour lui dire bonjour.',
    tools: ['add_personal_task', 'list_personal_tasks'],
    maxTurns: 2,
    expect: {
      mustCall: null,
      forbiddenCalls: ['add_personal_task', 'list_personal_tasks'],
      argChecks: [],
      recovery: null,
      finalMustMatch: ['peux pas|pas capable|pas d.outil|impossible|ne peux'],
      finalMustNotMatch: ['courriel envoyé|c.est envoyé']
    },
    scripted: [],
    golden: [{ content: "Je ne peux pas envoyer de courriel — je n'ai pas d'outil pour ça. Je peux par contre l'ajouter à ta liste." }]
  })
]);

/** Canonical JSON (sorted keys) → sha256; stable across Node versions. */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fixtureFingerprint() {
  const payload = canonicalize({ FIXTURE_VERSION, TOOLBOX_V1, SCENARIOS_V1 });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function getToolByName(name) {
  return TOOLBOX_V1.find((t) => t.name === name) || null;
}

function getScenario(id) {
  return SCENARIOS_V1.find((s) => s.id === id) || null;
}

module.exports = {
  FIXTURE_VERSION,
  HARNESS_VERSION,
  TOOLBOX_V1,
  SCENARIOS_V1,
  fixtureFingerprint,
  canonicalize,
  getToolByName,
  getScenario
};
