// Helper to sanitize Ollama options
function sanitizeOptions(options = {}) {
  // Ollama's native /api/chat accepts Modelfile/runtime parameters.
  // OpenAI-style penalties are kept in UI state for compatibility, but they
  // should not be forwarded to Ollama's native endpoint.
  const numericKeys = [
    'temperature', 'top_k', 'top_p', 'min_p', 'num_ctx', 'repeat_last_n',
    'repeat_penalty', 'seed', 'num_predict', 'typical_p', 'tfs_z',
    'mirostat', 'mirostat_eta', 'mirostat_tau'
  ];
  const clean = {};
  numericKeys.forEach((key) => {
    if (options[key] === 0 || options[key]) {
      const parsed = Number(options[key]);
      if (!Number.isNaN(parsed)) clean[key] = parsed;
    }
  });
  if (Array.isArray(options.stop)) clean.stop = options.stop;
  else if (typeof options.stop === 'string' && options.stop.trim()) {
    clean.stop = options.stop.split(',').map((val) => val.trim()).filter(Boolean);
  }
  if (options.keep_alive) clean.keep_alive = options.keep_alive;
  return clean;
}

// Resolve Ollama Target
function resolveTarget(target) {
    const envHost = process.env.OLLAMA_HOST;
    if (!target || typeof target !== 'string') {
        if (envHost) return envHost.replace(/\/+$/, '');
        throw new Error('Ollama host not configured (OLLAMA_HOST env var missing) and no target provided');
    }
    const trimmed = target.trim();
    if (!trimmed) {
        if (envHost) return envHost.replace(/\/+$/, '');
        throw new Error('Ollama host not configured (OLLAMA_HOST env var missing) and no target provided');
    }
    if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
    return `http://${trimmed.replace(/\/+$/, '')}`;
}

const DEFAULT_OPERATIONAL_NUM_CTX_CAP = 131072;

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function modelLookupNames(modelName) {
  const raw = String(modelName || '').trim().replace(/:latest$/i, '');
  if (!raw) return [];
  const slashIdx = raw.indexOf('/');
  const bare = slashIdx > 0 && slashIdx < raw.length - 1 ? raw.slice(slashIdx + 1) : null;
  return Array.from(new Set([raw, bare].filter(Boolean)));
}

async function findContextProfile(modelName, targetHost, deps = {}) {
  if (!targetHost) return null;
  const ModelContextProfile = deps.ModelContextProfile || require('../../models/ModelContextProfile');
  const profile = await ModelContextProfile.findOne({
    modelName: { $in: modelLookupNames(modelName) },
    hostUrl: resolveTarget(targetHost),
    stale: { $ne: true }
  })
    .select('modelName hostUrl recommendedContext verifiedMaxContext stressCeiling lastValidatedAt')
    .lean();
  const recommendedContext = positiveInteger(profile?.recommendedContext);
  if (!recommendedContext) return null;
  return {
    num_ctx: recommendedContext,
    source: 'model_context_profile',
    targetHost: profile.hostUrl || resolveTarget(targetHost),
    authoritative: true,
    testedAt: profile.lastValidatedAt || null,
    details: {
      verifiedMaxContext: profile.verifiedMaxContext || null,
      stressCeiling: profile.stressCeiling || null,
      matchedName: profile.modelName || null
    }
  };
}

function operationalNumCtxCap(opts = {}) {
  const raw = opts.operationalCap
    ?? process.env.MODEL_CONTEXT_OPERATIONAL_CAP
    ?? process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP
    ?? DEFAULT_OPERATIONAL_NUM_CTX_CAP;
  return positiveInteger(raw);
}

function withOperationalCap(result, opts = {}) {
  if (!result || result.source === 'override' || opts.disableOperationalCap === true) return result;
  const cap = operationalNumCtxCap(opts);
  const numCtx = positiveInteger(result.num_ctx);
  if (!cap || !numCtx || numCtx <= cap) return result;
  return {
    ...result,
    num_ctx: cap,
    source: `${result.source || 'unknown'}_operational_cap`,
    capped: true,
    operational_cap: cap,
    verified_num_ctx: numCtx
  };
}

/**
 * Resolve num_ctx details for a model, aware of the target host's VRAM.
 *
 * Priority:
 *   1. User override from registry (always wins)
 *   2. Dynamic VRAM-based calculation for the target host
 *   3. Benchmark-tested context result (written by agentx-benchmark, read here)
 *   4. Registry auto-detected default
 *   5. Fallback (8192)
 *
 * Note: Context probing and host-test execution are owned by the benchmark
 * service. Core only reads the results stored in ModelRegistry.contextTest
 * for inference routing decisions.
 *
 * @param {string} modelName
 * @param {object} [opts]
 * @param {string} [opts.targetHost] - Ollama host URL the request will be sent to
 * @param {number} [opts.fallback=8192]
 * @param {object} [opts.deps]              - Dependency injection for testability
 * @param {object} [opts.deps.ModelRegistry] - Mongoose model (default: require('../models/ModelRegistry'))
 * @param {object} [opts.deps.ollamaVramService] - VRAM service (default: lazy-require)
 * @param {Function} [opts.deps.detectOptimalNumCtx] - detection fn (default: lazy-require)
 * @returns {Promise<{ num_ctx: number, source: string, targetHost: string|null }>}
 */
async function resolveModelNumCtxDetails(modelName, opts = {}) {
  const fallback = typeof opts === 'number' ? opts : (opts.fallback || 8192);
  const targetHost = typeof opts === 'object' ? opts.targetHost : undefined;
  const deps = (typeof opts === 'object' && opts.deps) || {};

  if (!modelName) {
    return {
      num_ctx: fallback,
      source: 'fallback',
      targetHost: targetHost || null
    };
  }
  try {
    const ModelRegistry = deps.ModelRegistry || require('../../models/ModelRegistry');
    const entry = await ModelRegistry.findOne({ modelName: modelName.replace(/:latest$/, '') })
      .select('executionOverrides executionDefaults parameterSize quantization modelSizeBytes sourceHost contextTest')
      .lean();
    if (!entry) {
      if (targetHost) {
        const profileOnly = await findContextProfile(modelName, targetHost, deps);
        if (profileOnly) return withOperationalCap(profileOnly, opts);
      }
      return { num_ctx: fallback, source: 'fallback', targetHost: targetHost || null };
    }

    const overrides = entry.executionOverrides || {};
    // User override always wins
    if (overrides.num_ctx != null) {
      return {
        num_ctx: overrides.num_ctx,
        source: 'override',
        targetHost: targetHost || null
      };
    }

    const defaults = entry.executionDefaults || {};
    const ct = entry.contextTest || {};

    if (targetHost) {
      try {
        const profile = await findContextProfile(modelName, targetHost, deps);
        if (profile) return withOperationalCap(profile, opts);
      } catch { /* fall through to legacy sources */ }
    }

    // If target host differs from source host, recalculate for target VRAM
    if (targetHost && entry.sourceHost && targetHost !== entry.sourceHost) {
      try {
        const ollamaVramService = deps.ollamaVramService || require('../services/ollamaVramService');
        const vramResult = await ollamaVramService.getHostVram(targetHost);
        if (vramResult.ok && vramResult.memoryTotalMiBTotal > 0) {
          const detectOptimalNumCtx = deps.detectOptimalNumCtx || require('../services/modelSync/parameterDetection').detectOptimalNumCtx;
          const detection = detectOptimalNumCtx({
            parameterSize: entry.parameterSize,
            quantization: entry.quantization,
            modelSizeBytes: entry.modelSizeBytes,
            hostVramMiB: vramResult.memoryTotalMiBTotal
          });
          return withOperationalCap({
            num_ctx: detection.num_ctx,
            source: 'target_host_vram_estimate',
            targetHost
          }, opts);
        }
      } catch { /* fall through to registry default */ }
    }

    // Verified context test result (host-agnostic legacy value)
    const testedCtx = (ct.testedNumCtx != null && ct.status === 'completed') ? ct.testedNumCtx : null;
    if (testedCtx != null) {
      return withOperationalCap({
        num_ctx: testedCtx,
        source: 'context_test',
        targetHost: targetHost || null
      }, opts);
    }

    if (defaults.num_ctx != null) {
      return withOperationalCap({
        num_ctx: defaults.num_ctx,
        source: 'execution_default',
        targetHost: targetHost || null
      }, opts);
    }

    return {
      num_ctx: fallback,
      source: 'fallback',
      targetHost: targetHost || null
    };
  } catch {
    return {
      num_ctx: fallback,
      source: 'fallback',
      targetHost: targetHost || null
    };
  }
}

/**
 * Resolve num_ctx for a model, aware of the target host's VRAM.
 *
 * @param {string} modelName
 * @param {object} [opts]
 * @param {string} [opts.targetHost]
 * @param {number} [opts.fallback=8192]
 * @returns {Promise<number>}
 */
async function resolveModelNumCtx(modelName, opts = {}) {
  const details = await resolveModelNumCtxDetails(modelName, opts);
  return details.num_ctx;
}

module.exports = {
  sanitizeOptions,
  resolveTarget,
  resolveModelNumCtx,
  resolveModelNumCtxDetails
};
