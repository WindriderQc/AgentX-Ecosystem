/**
 * Live Data → Buddy demo watcher (TODO 0288, Phase 5).
 *
 * Proves the payoff of the central ingestion layer: core consumes the DATA
 * service's quake feed (NOT any external API) and, on a new quake at or above
 * LIVEDATA_BUDDY_QUAKE_MAG, pushes a narration event onto the platform bus
 * (`POST /api/platform-events`, loopback). Core fetches nothing external — that is
 * the whole point: one service ingests, another consumes via the uniform API.
 *
 * Opt-in via LIVEDATA_BUDDY_DEMO=true (default off).
 *
 * Env:
 *   LIVEDATA_BUDDY_DEMO       'true' to enable (default off)
 *   LIVEDATA_BUDDY_QUAKE_MAG  magnitude threshold to narrate (default 6)
 *   LIVEDATA_BUDDY_POLL_MS    poll cadence (default 300000 / 5 min)
 *   DATAAPI_BASE_URL          data service base (default http://localhost:3083)
 *   DATAAPI_API_KEY           sent as x-api-key if set (data ignores it when open)
 *   PORT                      core port for the loopback buddy emit (default 3080)
 */

let timer = null;
const seen = new Set();
let primed = false;

const enabled = () => process.env.LIVEDATA_BUDDY_DEMO === 'true';
const dataBase = () => (process.env.DATAAPI_BASE_URL || 'http://localhost:3083').replace(/\/+$/, '');
const corePort = () => process.env.PORT || 3080;
const threshold = () => Number(process.env.LIVEDATA_BUDDY_QUAKE_MAG || 6);

function quakeId(q) {
  return q.id || q.ids || (q.net && q.code ? `${q.net}${q.code}` : null) || `${q.time}|${q.place}|${q.mag}`;
}

// Consume the data service's quake feed (uniform API — no external source here).
async function fetchQuakes() {
  const headers = {};
  if (process.env.DATAAPI_API_KEY) headers['x-api-key'] = process.env.DATAAPI_API_KEY;
  const r = await fetch(`${dataBase()}/api/v1/livedata/quakes`, { headers });
  if (!r.ok) throw new Error(`data quakes ${r.status}`);
  return r.json();
}

// Push a narration event onto the platform bus (loopback passes the ingress guard).
async function narrate(quake) {
  const summary = `🌍 M${quake.mag} earthquake — ${quake.place}`;
  const body = {
    type: 'livedata.quake',
    class: 'observation',
    summary,
    significance: quake.mag >= 7 ? 'high' : 'medium',
    intent: 'narrate',
    surfaceScope: 'global'
  };
  const r = await fetch(`http://localhost:${corePort()}/api/platform-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

async function tick() {
  try {
    const res = await fetchQuakes();
    const quakes = (res && res.data) || [];
    const t = threshold();
    const fresh = [];
    for (const q of quakes) {
      const id = quakeId(q);
      if (seen.has(id)) continue;
      seen.add(id);
      const mag = parseFloat(q.mag);
      if (Number.isFinite(mag) && mag >= t) fresh.push({ mag: mag.toFixed(1), place: q.place || 'unknown location' });
    }
    // First poll just marks the existing daily backlog as seen — don't narrate it.
    if (!primed) { primed = true; return fresh.length; }
    for (const q of fresh) {
      try { await narrate(q); console.log(`[liveDataWatcher] narrated M${q.mag} — ${q.place}`); }
      catch (e) { console.warn('[liveDataWatcher] emit failed:', e.message); }
    }
    return fresh.length;
  } catch (e) {
    console.warn('[liveDataWatcher] tick failed:', e.message);
    return 0;
  }
}

function start() {
  if (!enabled() || timer) return false;
  const intervalMs = Number(process.env.LIVEDATA_BUDDY_POLL_MS || 300000);
  tick(); // prime (suppresses backlog narration)
  timer = setInterval(tick, intervalMs);
  console.log(`[liveDataWatcher] started — narrating quakes ≥ M${threshold()} from ${dataBase()} every ${Math.round(intervalMs / 1000)}s`);
  return true;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  start,
  stop,
  // exposed for unit tests
  _internals: { tick, narrate, fetchQuakes, quakeId, reset: () => { seen.clear(); primed = false; } }
};
