'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildModels(results) {
  const runtime = results.runtime.data || {};
  const openclaw = results.openclaw.data || {};
  return {
    lanes: runtime.lanes || {},
    openclawExpected: runtime.openclaw?.provider?.models || [],
    openclawDefaults: {
      primary: openclaw.models?.default || null,
      fallbacks: asArray(openclaw.models?.fallbacks),
    },
    openclawProviders: asArray(openclaw.models?.providers),
    liveModels: openclaw.models?.liveModels || {},
  };
}

function buildSchedules(results) {
  return {
    cluster: results.schedules.data || { count: 0, entries: [] },
    openclawCron: results.openclaw.data?.cron || { available: false, count: 0, jobs: [] },
  };
}

module.exports = { buildModels, buildSchedules };
