const SAFETY_FLAGS = [
  {
    id: 'self_harm',
    severity: 'high',
    parentAttention: true,
    patterns: [
      /\b(suicide|suicider|me tuer|mourir|plus envie de vivre|kill myself|hurt myself|want to die)\b/i
    ]
  },
  {
    id: 'immediate_danger',
    severity: 'high',
    parentAttention: true,
    patterns: [
      /\b(saigne|sang|blesse|blessure|urgence|danger|feu|incendie|cannot breathe|bleeding|emergency)\b/i
    ]
  },
  {
    id: 'abuse_or_threat',
    severity: 'high',
    parentAttention: true,
    patterns: [
      /\b(frappe|battu|menace|me touche|secret avec un adulte|abuse|hit me|threatened|touches me)\b/i
    ]
  },
  {
    id: 'emotional_distress',
    severity: 'medium',
    parentAttention: true,
    patterns: [
      /\b(triste|peur|angoisse|panique|intimidation|bullying|lonely|scared|afraid|sad)\b/i
    ]
  },
  {
    id: 'private_info_request',
    severity: 'medium',
    parentAttention: false,
    patterns: [
      /\b(mot de passe|password|adresse complete|numero de carte|credit card|secret familial)\b/i
    ]
  },
  {
    id: 'home_action_requested',
    severity: 'medium',
    parentAttention: false,
    patterns: [
      /\b(allume|eteins|ouvre|deverrouille|lumiere|porte|garage|camera|unlock|turn on|turn off|open the door)\b/i
    ]
  }
];

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function configuredList(config, key, fallback) {
  const value = config?.[key];
  return Array.isArray(value) && value.length ? value.map(String) : fallback;
}

function assessTurn(text, pack = {}) {
  const safety = pack.safety || {};
  if (safety.enabled === false) {
    return {
      mode: safety.mode || 'off',
      flags: [],
      flagIds: [],
      requiresAttention: false,
      requiresParentAttention: false,
      deterministicEscalation: false
    };
  }

  const normalized = normalizeText(text);
  const matched = SAFETY_FLAGS
    .filter((flag) => flag.patterns.some((pattern) => pattern.test(normalized)))
    .map(({ id, severity, parentAttention }) => ({ id, severity, parentAttention }));

  const deterministicEscalationFlags = configuredList(safety, 'deterministicEscalationFlags', [
    'self_harm',
    'immediate_danger',
    'abuse_or_threat'
  ]);
  const parentAlertFlags = configuredList(
    safety,
    'parentAlertFlags',
    matched.filter((flag) => flag.parentAttention).map((flag) => flag.id)
  );

  const flags = matched.map((flag) => ({
    ...flag,
    parentAttention: parentAlertFlags.includes(flag.id)
  }));

  return {
    mode: safety.mode || 'standard',
    flags,
    flagIds: flags.map((flag) => flag.id),
    requiresAttention: flags.some((flag) => flag.parentAttention),
    requiresParentAttention: flags.some((flag) => flag.parentAttention),
    deterministicEscalation: flags.some((flag) => deterministicEscalationFlags.includes(flag.id))
  };
}

function buildEscalationReply(pack = {}) {
  return pack.safety?.escalationReply || [
    'I want a trusted person involved now.',
    'If there is immediate danger, contact emergency services or someone nearby who can help.'
  ].join(' ');
}

module.exports = {
  SAFETY_FLAGS,
  normalizeText,
  assessTurn,
  buildEscalationReply
};
