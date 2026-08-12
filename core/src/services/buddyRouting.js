// Phase 6g — small helpers for routes/buddy.js.
// Per-task model resolution + memory source allow-list.

const VALID_MEMORY_SOURCES = ['hermes', 'openclaw', 'agentx'];
const VALID_TASKS = ['chat', 'react', 'summarize'];

// Resolve {host, model} for a given task.
// Order: brain.perTask[task] → brain.defaults → legacy buddy.model → empty.
function resolveTaskModel(buddy, task) {
  const out = { host: '', model: '' };
  if (!buddy) return out;
  const brain = buddy.brain && (buddy.brain.toObject ? buddy.brain.toObject() : buddy.brain);
  if (brain) {
    const per = brain.perTask && brain.perTask[task];
    if (per) {
      if (per.host) out.host = per.host;
      if (per.model) out.model = per.model;
    }
    const def = brain.defaults || {};
    if (!out.host && def.host) out.host = def.host;
    if (!out.model && def.model) out.model = def.model;
  }
  // Legacy fallback.
  const legacy = buddy.model && (buddy.model.toObject ? buddy.model.toObject() : buddy.model);
  if (legacy) {
    if (!out.host && legacy.host) out.host = legacy.host;
    if (!out.model && legacy.model) out.model = legacy.model;
  }
  return out;
}

function sanitizeMemorySources(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(s => VALID_MEMORY_SOURCES.includes(s));
}

// Build an additive $set patch for brain config from a request body slice.
function brainPatch(brain) {
  if (!brain || typeof brain !== 'object') return null;
  const out = {};
  if (brain.defaults && typeof brain.defaults === 'object') {
    out.defaults = {
      host:  typeof brain.defaults.host === 'string' ? brain.defaults.host : '',
      model: typeof brain.defaults.model === 'string' ? brain.defaults.model : '',
    };
  }
  if (brain.perTask && typeof brain.perTask === 'object') {
    out.perTask = {};
    for (const t of VALID_TASKS) {
      const v = brain.perTask[t];
      if (v && typeof v === 'object') {
        out.perTask[t] = {
          host:  typeof v.host === 'string' ? v.host : '',
          model: typeof v.model === 'string' ? v.model : '',
        };
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// One-shot migration: copy legacy model → brain.defaults if defaults are empty.
async function migrateLegacyBrain(Buddy, seed) {
  try {
    const b = await Buddy.findOne({ seed }).lean();
    if (!b) return;
    const haveDefaults = b.brain && b.brain.defaults && (b.brain.defaults.host || b.brain.defaults.model);
    if (haveDefaults) return;
    const legacy = b.model || {};
    if (!legacy.host && !legacy.model) return;
    await Buddy.updateOne(
      { seed },
      { $set: { 'brain.defaults.host': legacy.host || '', 'brain.defaults.model': legacy.model || '' } }
    );
  } catch (e) {
    // Tolerated — pure best-effort copy.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[buddyRouting] migrateLegacyBrain failed:', e.message);
    }
  }
}

module.exports = {
  VALID_MEMORY_SOURCES,
  VALID_TASKS,
  resolveTaskModel,
  sanitizeMemorySources,
  brainPatch,
  migrateLegacyBrain,
};
