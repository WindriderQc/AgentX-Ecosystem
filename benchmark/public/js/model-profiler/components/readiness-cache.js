/**
 * Readiness Cache — fetches model readiness data once, caches for session
 */

let _cache = null;
let _fetching = null;

export async function getReadinessMap() {
  if (_cache) return _cache;
  if (_fetching) return _fetching;

  _fetching = fetch('/api/profiler/models')
    .then(r => r.ok ? r.json() : [])
    .then(json => {
      const models = json?.data ?? json;
      const map = {};
      for (const m of (Array.isArray(models) ? models : [])) {
        const readiness = m.readiness || {};
        const entries = Object.entries(
          readiness instanceof Map ? Object.fromEntries(readiness) : readiness
        );
        const stages = entries.map(([, r]) => r.stage);
        const highest = ['benchmarked', 'profiled', 'available']
          .find(s => stages.includes(s)) || 'available';
        const hostCount = entries.filter(([, r]) => r.stage === highest).length;
        map[m.name] = { stage: highest, hostCount, totalHosts: entries.length };
      }
      _cache = map;
      return map;
    })
    .catch(() => {
      _cache = {};
      return {};
    });

  return _fetching;
}

export function getBadgeHtml(modelName, readinessMap) {
  const info = readinessMap[modelName];
  if (!info || info.stage === 'available') return '';

  const BADGE_CONFIG = {
    profiled:    { label: '✓ Profiled',    bg: '#1a3a5c', color: '#4ecdc4' },
    benchmarked: { label: '★ Benchmarked', bg: '#1a3a2a', color: '#2ecc71' }
  };

  const config = BADGE_CONFIG[info.stage];
  if (!config) return '';

  const hostSuffix = info.totalHosts > 0 ? ` ${info.hostCount}/${info.totalHosts}` : '';
  return `<span class="ax-badge" style="background:${config.bg};color:${config.color};padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;margin-left:6px;white-space:nowrap;">${config.label}${hostSuffix}</span>`;
}
