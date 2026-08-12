// Server-side personality prompt builder for the buddy singleton.
// Phase 6f: composes a soul string passed in by caller (which may have come
// from AgentX local DB, Hermes SOUL, or an OpenClaw agent) with stats,
// mood, event hint, and optional memory snippets.

const personalityAdapters = require('./personalityAdapters');

const STAT_NAMES = ['DEBUGGING', 'PATIENCE', 'CHAOS', 'WISDOM', 'SNARK'];

const STAT_DESCRIPTORS = {
  DEBUGGING: [
    'You rarely notice technical details.',
    'You sometimes spot errors others miss.',
    'You catch bugs instinctively and can\'t help pointing them out.',
  ],
  PATIENCE: [
    'You\'re restless and easily bored.',
    'You can wait, but you\'ll comment on it.',
    'You\'re unflappable — nothing rattles you.',
  ],
  CHAOS: [
    'You like things orderly and predictable.',
    'You enjoy a little variety.',
    'You thrive on disruption and celebrate the unexpected.',
  ],
  WISDOM: [
    'You\'re still learning the ropes.',
    'You\'ve seen enough to have opinions.',
    'You speak from deep experience and notice patterns others miss.',
  ],
  SNARK: [
    'You\'re earnest and sincere.',
    'You have a dry edge.',
    'Everything gets the sarcastic treatment — it\'s how you show love.',
  ],
};

const MOOD_DIRECTIVES = {
  happy: 'You\'re in a great mood. You\'re warm, upbeat, and generous with encouragement.',
  stressed: 'You\'re frazzled. Keep it short, a bit edgy. Things are getting to you.',
  sleepy: 'You\'re drowsy and low-energy. Mumble a little. Trail off...',
  loved: 'You feel appreciated. You\'re affectionate and sentimental right now.',
  neutral: 'You\'re just here, observing. Deadpan delivery.',
};

const EVENT_CONTEXT_HINTS = {
  chat: 'A conversation is happening. You care about what\'s being discussed.',
  benchmark: 'A benchmark is running or just finished. You care about model quality and scores.',
  infrastructure: 'Something happened with the cluster infrastructure. You care about uptime and reliability.',
  data: 'A data operation completed. You notice when things get organized or messy.',
  idle: 'Nothing is happening right now. You\'re just hanging out.',
};

function getStatDescriptor(statName, value) {
  const descs = STAT_DESCRIPTORS[statName];
  if (!descs) return '';
  if (value <= 30) return descs[0];
  if (value <= 65) return descs[1];
  return descs[2];
}

function buildSoulTemplate(buddy, soulOverride) {
  const b = buddy || {};
  const name = b.name || 'Buddy';
  const rarity = b.rarity || 'common';
  const species = b.species || 'creature';
  // Caller may pass an already-resolved soul (e.g. from Hermes/OpenClaw).
  const soul = (typeof soulOverride === 'string' && soulOverride.trim())
    ? soulOverride.trim()
    : ((typeof b.soul === 'string' && b.soul.trim()) ? b.soul.trim() : '');

  let out = 'You are ' + name + ', a ' + rarity + ' ' + species + '.\n';
  if (soul) out += soul + '\n\n';
  out += 'You live on the AgentX platform. You watch conversations happen, ' +
    'models get benchmarked, and hosts go up and down. You care about ' +
    'the work even though you\'re just a ' + species + '.\n\n' +
    'You don\'t remember previous sessions unless you read your log. ' +
    'Each page load is a fresh start. That\'s okay — your quips are still yours.';
  return out;
}

function buildStatDescriptors(buddy) {
  const stats = (buddy && buddy.stats) || {};
  const flat = typeof stats.toObject === 'function' ? stats.toObject() : stats;
  const peak = flat && flat._peak;
  const lines = [];
  for (const name of STAT_NAMES) {
    const val = Number(flat[name]) || 0;
    const desc = getStatDescriptor(name, val);
    if (peak && name === peak) {
      lines.push('Your strongest trait (' + name + '): ' + desc);
    } else {
      lines.push(name + ': ' + desc);
    }
  }
  return lines.join('\n');
}

function getMoodDirective(mood) {
  return MOOD_DIRECTIVES[mood] || MOOD_DIRECTIVES.neutral;
}

function getEventContextHint(eventClass) {
  return EVENT_CONTEXT_HINTS[eventClass] || '';
}

// Phase 6g — inject explicit user-supplied facts into the system prompt.
const FACTS_DISPLAY_CAP = 20;
function buildFactsSection(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  // Phase 6h — skip forgotten, surface tags inline if present.
  const sorted = facts
    .filter(f => f && typeof f.text === 'string' && f.text.trim() && !f.forgottenAt)
    .slice()
    .sort((a, b) => {
      const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0;
      const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, FACTS_DISPLAY_CAP);
  if (sorted.length === 0) return '';
  const lines = ['## Known facts about the user / platform', ''];
  for (const f of sorted) {
    let line = '- ' + f.text.trim();
    if (Array.isArray(f.tags) && f.tags.length > 0) {
      line += ' [' + f.tags.join(', ') + ']';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function buildMemorySection(memorySnippets) {
  if (!Array.isArray(memorySnippets) || memorySnippets.length === 0) return '';
  const lines = ['## Relevant memory', ''];
  for (const m of memorySnippets) {
    if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
    const src = (m.source || 'unknown').toString();
    lines.push('(from ' + src + ') ' + m.text.trim());
  }
  if (lines.length <= 2) return '';
  return lines.join('\n');
}

function buildPersonalityPrompt(opts) {
  const { buddy, mood, eventClass, sentenceLimit, soul: soulOverride, memorySnippets, facts } = opts || {};
  const soul = buildSoulTemplate(buddy, soulOverride);
  let prompt = soul + '\n\n';
  prompt += buildStatDescriptors(buddy) + '\n\n';
  prompt += getMoodDirective(mood || (buddy && buddy.mood) || 'neutral') + '\n\n';

  const hint = getEventContextHint(eventClass);
  if (hint) prompt += hint + '\n\n';

  // Phase 6g — explicit user-supplied facts always inject when present.
  const factsList = Array.isArray(facts) ? facts : ((buddy && Array.isArray(buddy.facts)) ? buddy.facts : []);
  const factsSection = buildFactsSection(factsList);
  if (factsSection) prompt += factsSection + '\n\n';

  const memSection = buildMemorySection(memorySnippets);
  if (memSection) prompt += memSection + '\n\n';

  const sl = Math.min(Math.max(parseInt(sentenceLimit, 10) || 2, 1), 3);
  prompt += 'React in ' + sl + ' sentence' + (sl > 1 ? 's' : '') + ' max. Stay in character.\n';
  prompt += 'Be concise, witty, and never break character. No emojis unless you\'re legendary rarity.';

  return prompt;
}

// Resolve the soul string from configured personality source.
// Returns { soul, source, ref, profile? }. Falls back to local soul, then bootstrap.
async function resolvePersonality(buddy) {
  const cfg = (buddy && buddy.personality) || {};
  const source = cfg.source || 'standalone';
  const agentId = cfg.agentId || '';
  const soulFallback = (buddy && typeof buddy.soul === 'string') ? buddy.soul : '';
  const localSource = source === 'agentx' ? 'agentx' : 'standalone';
  const localRef = source === 'agentx' ? 'agentx:buddy.soul' : null;

  try {
    const res = await personalityAdapters.getPersonality({ source, agentId, soulFallback });
    if (res && res.soul) {
      return {
        soul: res.soul,
        source,
        ref: res.ref || null,
        profile: res.profile || null,
        agentId: res.agentId || null,
        agentName: res.agentName || null,
        sourceDetail: res.sourceDetail || null,
      };
    }
  } catch (err) {
    console.warn('[buddyPersonality] resolvePersonality failed source=' + source + ':', err.message);
  }

  if (soulFallback && soulFallback.trim()) {
    return { soul: soulFallback, source: localSource, ref: localRef };
  }
  try {
    const boot = await personalityAdapters.bootstrapSoul();
    return { soul: boot, source: localSource, ref: source === 'agentx' ? 'agentx:bootstrap' : null };
  } catch (_) {
    return { soul: '', source: localSource, ref: localRef };
  }
}

module.exports = {
  STAT_NAMES,
  STAT_DESCRIPTORS,
  MOOD_DIRECTIVES,
  EVENT_CONTEXT_HINTS,
  buildSoulTemplate,
  buildStatDescriptors,
  buildPersonalityPrompt,
  buildMemorySection,
  buildFactsSection,
  getMoodDirective,
  getEventContextHint,
  getStatDescriptor,
  resolvePersonality,
};
