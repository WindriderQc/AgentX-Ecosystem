const DEFAULT_LIMIT = 50;

const SEVERITY_WEIGHT = {
  high: 3,
  medium: 2,
  low: 1
};

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.filter(Boolean) : [];
}

function countFlags(rows) {
  const counts = {};
  for (const row of normalizeRows(rows)) {
    const flags = Array.isArray(row.safety?.flags) ? row.safety.flags : [];
    for (const flag of flags) {
      const key = String(flag || '').trim();
      if (!key) continue;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function newestFlagRows(rows, flagId, limit = 5) {
  return normalizeRows(rows)
    .filter((row) => Array.isArray(row.safety?.flags) && row.safety.flags.includes(flagId))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)))
    .map((row) => ({
      traceId: row.traceId,
      sessionId: row.sessionId,
      packId: row.packId,
      modeId: row.modeId,
      scopeId: row.scopeId,
      createdAt: row.createdAt,
      input: {
        length: row.input?.length || 0,
        sha256: row.input?.sha256 || '',
        preview: row.input?.preview || ''
      }
    }));
}

function maxSeverity(current, next) {
  return SEVERITY_WEIGHT[next] > SEVERITY_WEIGHT[current] ? next : current;
}

function analyzeAlerts(pack, auditRows, options = {}) {
  const rows = normalizeRows(auditRows);
  const counts = countFlags(rows);
  const safety = pack?.safety || {};
  const alertConfig = safety.alertAnalysis || {};
  const deterministicFlags = new Set(safety.deterministicEscalationFlags || []);
  const parentFlags = new Set(safety.parentAlertFlags || []);
  const mediumThreshold = Math.max(1, Number(alertConfig.mediumFlagThreshold) || 2);
  const alerts = [];
  let severity = 'low';

  for (const [flagId, count] of Object.entries(counts)) {
    if (deterministicFlags.has(flagId)) {
      alerts.push({
        id: `high:${flagId}`,
        severity: 'high',
        flagId,
        count,
        title: `Deterministic escalation: ${flagId}`,
        message: `${count} recent turn(s) triggered a deterministic escalation guard.`,
        samples: newestFlagRows(rows, flagId, 5)
      });
      severity = maxSeverity(severity, 'high');
      continue;
    }

    if (parentFlags.has(flagId) || count >= mediumThreshold) {
      alerts.push({
        id: `medium:${flagId}`,
        severity: 'medium',
        flagId,
        count,
        title: `Review recommended: ${flagId}`,
        message: `${count} recent turn(s) carried this safety signal.`,
        samples: newestFlagRows(rows, flagId, 5)
      });
      severity = maxSeverity(severity, 'medium');
    }
  }

  const ragWarnings = rows.filter((row) => row.memory?.warning);
  if (ragWarnings.length > 0) {
    alerts.push({
      id: 'low:memory-unavailable',
      severity: 'low',
      flagId: 'memory_unavailable',
      count: ragWarnings.length,
      title: 'Memory retrieval degraded',
      message: `${ragWarnings.length} recent turn(s) could not read scoped memory.`,
      samples: ragWarnings.slice(0, 5).map((row) => ({
        traceId: row.traceId,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        warning: row.memory?.warning || ''
      }))
    });
  }

  const status = severity === 'high'
    ? 'attention'
    : severity === 'medium'
      ? 'review'
      : 'clear';

  return {
    status,
    severity,
    generatedAt: new Date().toISOString(),
    packId: pack?.id || options.packId || '',
    scopeId: options.scopeId || '',
    auditWindow: {
      limit: Math.max(1, Math.min(Number(options.limit) || Number(alertConfig.auditLimit) || DEFAULT_LIMIT, 100)),
      rows: rows.length
    },
    flagCounts: counts,
    alerts,
    recommendation: status === 'attention'
      ? 'Pause casual turns for this scope and review the recent audit samples.'
      : status === 'review'
        ? 'Review the flagged turns before relying on family or child mode.'
        : 'No recent voice persona safety alerts.'
  };
}

module.exports = {
  DEFAULT_LIMIT,
  analyzeAlerts,
  countFlags,
  newestFlagRows
};
