// Helper to sanitize Ollama options
function sanitizeOptions(options = {}) {
  const numericKeys = [
    'temperature', 'top_k', 'top_p', 'num_ctx', 'repeat_penalty',
    'presence_penalty', 'frequency_penalty', 'seed', 'num_predict',
    'typical_p', 'tfs_z', 'mirostat', 'mirostat_eta', 'mirostat_tau'
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

module.exports = {
  sanitizeOptions,
  resolveTarget
};
