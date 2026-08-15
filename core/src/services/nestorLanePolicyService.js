'use strict';

const AUTO_LANE = 'auto';
const ANSWER_LIGHT_LANE = 'answer_light';
const FRONT_DOOR_LANE = 'front_door';

const COMPLETE_RULES = [
  {
    reason: 'explicit-complete',
    pattern: /\b(nestor\s+complet|complete\s+nestor|use\s+(?:your\s+)?tools?|avec\s+tes\s+outils?)\b/iu
  },
  {
    reason: 'action-or-secretary',
    pattern: /\b(ajoute(?:r)?|rappelle(?:-moi)?|planifie(?:r)?|cr[eé]e(?:r)?|sauvegarde(?:r)?|enregistre(?:r)?|oublie(?:r)?|supprime(?:r)?|annule(?:r)?|ach[eè]te(?:r)?|mets?|marque|add|remind|schedule|create|save|remember|forget|delete|cancel|buy|mark|(?:ma|mes)\s+(?:liste|t[âa]ches?)|(?:liste|t[âa]ches?)\s+personnelles?|personal\s+(?:list|tasks?|errands?))\b/iu
  },
  {
    reason: 'memory',
    pattern: /\b(tu\s+te\s+souviens|souviens-toi|m[eé]moire|memory|what\s+do\s+you\s+know\s+about\s+me|qu['’]est-ce\s+que\s+tu\s+sais\s+de\s+moi)\b/iu
  },
  {
    reason: 'live-platform',
    pattern: /\b(agentx|pipeline|ollama|qdrant|mongo(?:db)?|voix|service\s+health|system\s+status|statut\s+(?:du\s+)?syst[eè]me)\b/iu
  },
  {
    reason: 'deep-or-council',
    pattern: /\b(council|d[eé]bat|debate|architecture|strat[eé]gie|strategy|plan\s+exhaustif|analyse\s+approfondie|deep\s+analysis|compare\s+in\s+depth)\b/iu
  },
  {
    reason: 'high-stakes',
    pattern: /\b(urgence|urgent|suicide|self[- ]harm|m[eé]dical|medical|juridique|legal\s+advice|diagnostic|overdose|poison|empoisonnement)\b/iu
  }
];

function selectNestorLane(text, requestedLane) {
  const requested = String(requestedLane || FRONT_DOOR_LANE).trim().toLowerCase();
  if (requested !== AUTO_LANE) {
    return {
      requestedLane: requested,
      lane: requested,
      source: 'explicit',
      reason: 'caller-selected'
    };
  }

  const input = String(text || '').trim();
  const matched = COMPLETE_RULES.find((rule) => rule.pattern.test(input));
  if (matched) {
    return {
      requestedLane: AUTO_LANE,
      lane: FRONT_DOOR_LANE,
      source: 'deterministic-policy-v1',
      reason: matched.reason
    };
  }

  return {
    requestedLane: AUTO_LANE,
    lane: ANSWER_LIGHT_LANE,
    source: 'deterministic-policy-v1',
    reason: 'bounded-answer'
  };
}

module.exports = {
  AUTO_LANE,
  ANSWER_LIGHT_LANE,
  FRONT_DOOR_LANE,
  COMPLETE_RULES,
  selectNestorLane
};
