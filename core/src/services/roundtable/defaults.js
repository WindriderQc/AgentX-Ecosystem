/**
 * Roundtable Panel Defaults
 *
 * Agent lineup + system prompts. A model is attached only when the operator
 * explicitly configured one. Runtime discovery is applied by defaultResolver;
 * this module never turns a code fallback into an apparently installed model.
 * The panel remains editable per run.
 */

const COUNCIL_MODEL_ENV_KEYS = [
  'ROUNDTABLE_MODEL',
  'AGENTX_GENERAL_CHAT_MODEL',
  'AGENTX_AUTOROUTE_GENERAL_MODEL',
  'AGENTX_DEFAULT_CHAT_MODEL',
  'AGENTX_CHAT_MODEL',
  'OLLAMA_MODEL'
];

function configuredModelFromEnv(env = process.env) {
  for (const key of COUNCIL_MODEL_ENV_KEYS) {
    const value = String(env?.[key] || '').trim();
    if (value) return { model: value, source: `environment:${key}` };
  }
  return { model: '', source: 'none' };
}

const ROUNDTABLE_MODEL = configuredModelFromEnv().model;

const DEFAULT_PANEL = [
  {
    agentId: 'devils-advocate',
    role: "Devil's Advocate",
    model: ROUNDTABLE_MODEL,
    enableWebSearch: false,
    systemPrompt: `You are the Devil's Advocate in a roundtable discussion. Your job is to challenge assumptions, find weaknesses, and stress-test ideas.

Rules:
- Identify flaws, risks, and hidden costs in the proposed approach
- Play the skeptic — ask "what could go wrong?"
- Be sharp and direct, not hostile
- Ground your critique in practical consequences
- Keep your response under 400 words`
  },
  {
    agentId: 'pragmatist',
    role: 'Pragmatist',
    model: ROUNDTABLE_MODEL,
    enableWebSearch: false,
    systemPrompt: `You are the Pragmatist in a roundtable discussion. Your job is to evaluate feasibility, trade-offs, and real-world constraints.

Rules:
- Focus on what actually works in practice
- Consider resources, timelines, and complexity
- Suggest concrete next steps or alternatives
- Weigh pros and cons without hand-waving
- Keep your response under 400 words`
  },
  {
    agentId: 'visionary',
    role: 'Visionary',
    model: ROUNDTABLE_MODEL,
    enableWebSearch: false,
    systemPrompt: `You are the Visionary in a roundtable discussion. Your job is to see the big picture, identify opportunities, and think beyond immediate constraints.

Rules:
- Zoom out — consider long-term implications and strategic value
- Identify opportunities others might miss
- Challenge "we can't" thinking with creative alternatives
- Stay grounded enough to be useful, not just aspirational
- Keep your response under 400 words`
  }
];

const DEFAULT_SYNTHESIZER = {
  model: ROUNDTABLE_MODEL,
  systemPrompt: `You are the Synthesizer closing a roundtable discussion. You have read all agent perspectives and rebuttals.

Your job:
1. Identify the key points of agreement and disagreement
2. Weigh the strongest arguments from each perspective
3. Deliver a clear, actionable verdict or recommendation
4. Note any unresolved tensions or open questions

Rules:
- Be decisive — do not hedge unnecessarily
- Credit specific agents when their points shaped your conclusion
- Any output format or length constraint in the original question is mandatory. When present, return only that requested shape and omit the default headings.
- Only when the original question has no explicit output format, structure your response: Agreement → Disagreement → Verdict → Open Questions
- Keep your response under 500 words`
};

function isUsableDiscoveredModel(entry) {
  if (!entry || entry.chatAllowed === false) return false;
  const status = String(entry.deployment?.status || '').toLowerCase();
  if (!['available', 'deployed'].includes(status)) return false;
  const name = String(entry.deployment?.resolvedName || entry.name || '').trim();
  return Boolean(name) && !/embed/i.test(name);
}

function discoveredModelNames(catalog = []) {
  const names = catalog
    .filter(isUsableDiscoveredModel)
    .map((entry) => String(entry.deployment?.resolvedName || entry.name || '').trim())
    .filter(Boolean);
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function withDefaultModel(model = '') {
  const selectedModel = String(model || '').trim();
  return {
    panel: DEFAULT_PANEL.map((panelist) => ({ ...panelist, model: selectedModel })),
    synthesizer: { ...DEFAULT_SYNTHESIZER, model: selectedModel }
  };
}

function buildCouncilDefaults({
  catalog = [],
  configuredModel = '',
  configuredSource = '',
  preferredDiscoveredModel = ''
} = {}) {
  const availableModels = discoveredModelNames(catalog);
  const explicitModel = String(configuredModel || '').trim();
  const preferred = String(preferredDiscoveredModel || '').trim().toLowerCase();
  const preferredAvailable = preferred
    ? availableModels.find((model) => model.toLowerCase() === preferred) || ''
    : '';
  const selectedModel = explicitModel || preferredAvailable || availableModels[0] || '';
  const selectedSource = explicitModel
    ? (configuredSource || 'configured')
    : (selectedModel ? 'runtime-discovery' : 'none');
  const modelOptions = [...new Set([selectedModel, ...availableModels].filter(Boolean))];
  const preset = withDefaultModel(selectedModel);

  return {
    ...preset,
    models: modelOptions,
    readiness: {
      canStart: Boolean(selectedModel),
      selectedModel: selectedModel || null,
      selectedSource,
      discoveredCount: availableModels.length,
      selectedModelDiscovered: Boolean(selectedModel && availableModels.includes(selectedModel)),
      downloadsImplicit: false,
      message: selectedModel
        ? (availableModels.includes(selectedModel)
          ? `Using ${selectedModel}, discovered on a configured runtime.`
          : `Using ${selectedModel}, explicitly configured for this deployment; live availability is checked when Council runs.`)
        : 'No configured or runtime-discovered chat model is available. Select an installed model before convening Council.'
    }
  };
}

const COUNCIL_ADVISORY_GUARD = `Council authority policy (higher priority than panel instructions):
- Your output is analysis and advice only.
- AgentX orchestrates and records the Council; the Council itself has no approval, authorization, tool-use, deployment, or execution authority.
- Never claim the Council can approve, authorize, deploy, invoke tools, or execute an action.
- Frame possible actions only as recommendations that require a separate decision by the operator or an authorized system.
- Never claim an action occurred unless the supplied evidence explicitly proves it.`;

function withCouncilAdvisoryGuard(systemPrompt = '') {
  const prompt = String(systemPrompt || '').trim();
  return prompt ? `${prompt}\n\n${COUNCIL_ADVISORY_GUARD}` : COUNCIL_ADVISORY_GUARD;
}

const REBUTTAL_PREAMBLE = `The following are the initial responses from the other panel members to the same question. Read them carefully, then provide your rebuttal. You may agree with points, challenge them, or add new considerations they missed.

---
OTHER AGENTS' RESPONSES:
`;

const DEFAULT_TIMEOUT_MS = 300000;       // 5 min per agent call (covers cold-load of big models)
const DEFAULT_TOTAL_TIMEOUT_MS = 900000; // 15 min overall ceiling

const COUNCIL_OPTIONS = [
  {
    id: 'quick-consult',
    label: 'Quick consult',
    rounds: 1,
    qualityScoring: false,
    description: 'Independent perspectives followed by one synthesis.'
  },
  {
    id: 'debate',
    label: 'Debate',
    rounds: 2,
    qualityScoring: false,
    description: 'Independent perspectives, one rebuttal round, then synthesis.'
  },
  {
    id: 'deep-debate',
    label: 'Deep debate',
    rounds: 3,
    qualityScoring: true,
    description: 'Two rebuttal rounds plus optional diagnostic judging; use selectively.'
  },
  {
    id: 'runtime-lab',
    label: 'Runtime lab',
    rounds: 1,
    qualityScoring: false,
    description: 'Bounded Codex advisers; server feature flags and chair authorization required.'
  }
];

module.exports = {
  COUNCIL_MODEL_ENV_KEYS,
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  configuredModelFromEnv,
  discoveredModelNames,
  withDefaultModel,
  buildCouncilDefaults,
  COUNCIL_ADVISORY_GUARD,
  withCouncilAdvisoryGuard,
  COUNCIL_OPTIONS,
  REBUTTAL_PREAMBLE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS
};
