/**
 * Live Data Dashboard (core data-toolbox → Live Data tab).
 *
 * Registry-driven UI over the data service's uniform consumption API
 * (/api/data/livedata/*, TODO 0285). Renders a feed-health strip, a Leaflet
 * world map (ISS track + satellites + quake circles) over a self-hosted base
 * (no external tiles — operator decision, TODO 0287), and Chart.js time-series
 * for weather/air-quality. Live ISS updates via SSE; everything else polls.
 *
 * Libraries (all from already-CSP-allowed CDNs): Leaflet (jsdelivr js / cdnjs css),
 * satellite.js (jsdelivr), Chart.js (jsdelivr).
 */
const LiveDataPage = (() => {
  const API_BASE = '/api/data/livedata';
  const REFRESH_INTERVAL_MS = 30000;
  const WORLD_BOUNDS = [[-90, -180], [90, 180]];
  const ISS_TRACK_MAX = 60;

  const state = { masterEnabled: false, feeds: [], enabled: {} };
  let refreshTimer = null;
  let map = null, baseDrawn = false, issMarker = null, issTrackLine = null, quakeLayer = null, satLayer = null;
  let issTrack = [];
  const charts = {};
  const sse = {}; // feedId -> EventSource

  /* ── helpers ── */
  const esc = (s) => window.AgentXUtils.escapeHtml(String(s == null ? '' : s));
  const showToast = (msg, type = 'info') => window.AgentXUtils.showToast(msg, type);
  const num = (v, d = 2) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '--');

  function timeAgo(ms) {
    if (ms == null) return 'never';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }
  function formatTime(ts) {
    if (!ts) return '--';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function formatDateTime(ts) {
    if (!ts) return '--';
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function magClass(mag) {
    if (mag < 2) return 'ld-mag-gray';
    if (mag < 4) return 'ld-mag-green';
    if (mag < 5) return 'ld-mag-yellow';
    return 'ld-mag-red';
  }
  const catIcon = { space: 'fa-satellite', seismic: 'fa-mountain', weather: 'fa-cloud-sun', air: 'fa-wind', sensor: 'fa-microchip', finance: 'fa-coins' };

  async function apiFetch(path, options = {}) {
    try { return await DataCommons.apiFetch(`${API_BASE}${path}`, options); }
    catch (err) { showToast(err.message || 'API request failed', 'error'); return null; }
  }

  /* ── master switch ── */
  function updateMasterUI() {
    const el = document.getElementById('ld-master');
    const status = document.getElementById('ld-master-status');
    const toggle = document.getElementById('ld-master-toggle');
    if (!el) return;
    el.classList.toggle('active', state.masterEnabled);
    if (status) status.textContent = state.masterEnabled ? 'All systems online' : 'Offline';
    if (toggle) toggle.checked = state.masterEnabled;
  }

  /* ── feed registry + health strip ── */
  async function loadFeeds() {
    const res = await apiFetch('/feeds');
    if (!res || res.status !== 'success') return;
    state.feeds = res.data || [];
    state.feeds.forEach(f => { state.enabled[f.id] = f.enabled; });
    renderHealthStrip();
  }

  function healthBadge(f) {
    if (!f.enabled) return { cls: 'ld-badge-off', label: 'off' };
    if (f.lastError) return { cls: 'ld-badge-err', label: 'error' };
    if (f.ageMs == null) return { cls: 'ld-badge-stale', label: 'waiting' };
    const stale = f.ageMs > Math.max(f.intervalMs * 2, 120000);
    return stale ? { cls: 'ld-badge-stale', label: timeAgo(f.ageMs) } : { cls: 'ld-badge-ok', label: timeAgo(f.ageMs) };
  }

  function renderHealthStrip() {
    const strip = document.getElementById('ld-health-strip');
    if (!strip) return;
    if (!state.feeds.length) { strip.innerHTML = '<div class="ld-empty" style="grid-column:1/-1">No feeds registered</div>'; return; }
    strip.innerHTML = state.feeds.map(f => {
      const b = healthBadge(f);
      const icon = catIcon[f.category] || 'fa-rss';
      const count = f.count != null ? `${f.count.toLocaleString()} pts` : '';
      return `
        <div class="ld-health-item" id="ld-health-${esc(f.id)}">
          <div class="ld-health-top">
            <div class="ld-health-title"><div class="ld-service-icon ${esc(f.category)}"><i class="fas ${icon}"></i></div>${esc(f.label)}</div>
            <label class="ld-switch"><input type="checkbox" data-service="${esc(f.id)}" ${f.enabled ? 'checked' : ''}><span class="ld-slider"></span></label>
          </div>
          <div class="ld-health-meta">
            <span class="ld-health-badge ${b.cls}">${esc(b.label)}</span>
            <span>${esc(count)}</span>
            ${f.lastError ? `<span title="${esc(f.lastError)}"><i class="fas fa-triangle-exclamation" style="color:#ef4444"></i></span>` : ''}
          </div>
          <svg class="ld-spark" id="ld-spark-${esc(f.id)}" preserveAspectRatio="none"></svg>
        </div>`;
    }).join('');
    // wire toggles (delegated re-bind after re-render)
    strip.querySelectorAll('[data-service]').forEach(input => {
      input.addEventListener('change', (e) => toggleService(e.target.dataset.service, e.target.checked));
    });
    // sparklines for enabled numeric point feeds
    state.feeds.forEach(f => { if (f.enabled && f.store.mode === 'points') loadSparkline(f); });
  }

  /* ── toggles ── */
  async function toggleService(service, enabled) {
    const res = await apiFetch('/config', { method: 'POST', body: JSON.stringify({ service, enabled }) });
    if (!res) return;
    if (service === 'liveDataEnabled') {
      state.masterEnabled = enabled;
      updateMasterUI();
      showToast(enabled ? 'Live data engine started' : 'Live data engine stopped', 'success');
    } else {
      state.enabled[service] = enabled;
      showToast(`${service} ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'success' : 'info');
      if (!enabled) closeStream(service);
    }
    await refreshAll();
  }

  /* ── map ── */
  function ensureMap() {
    if (map || !window.L) return;
    map = L.map('ld-map', { crs: L.CRS.Simple, minZoom: -2, maxZoom: 4, zoomSnap: 0.25, attributionControl: false });
    drawBase();
    map.fitBounds(WORLD_BOUNDS);
    quakeLayer = L.layerGroup().addTo(map);
    satLayer = L.layerGroup().addTo(map);
  }

  function drawBase() {
    // Graticule base: zero assets, fully offline, and no intentional 404 probe
    // for an optional raster image.
    if (baseDrawn) return;
    baseDrawn = true;
    const g = L.layerGroup().addTo(map);
    const grid = { color: '#243049', weight: 1 };
    for (let lat = -60; lat <= 60; lat += 30) L.polyline([[lat, -180], [lat, 180]], grid).addTo(g);
    for (let lon = -120; lon <= 120; lon += 60) L.polyline([[-90, lon], [90, lon]], grid).addTo(g);
    L.polyline([[0, -180], [0, 180]], { color: '#36507a', weight: 1.5, dashArray: '5 5' }).addTo(g); // equator
    L.rectangle(WORLD_BOUNDS, { color: '#36507a', weight: 1, fill: false }).addTo(g);
    const note = document.getElementById('ld-map-note');
    if (note) note.innerHTML = '<i class="fas fa-circle-info"></i> Offline graticule base · no external map requests.';
  }

  function setISSMarker(lat, lon, ts) {
    if (!map) return;
    if (!issMarker) {
      issMarker = L.circleMarker([lat, lon], { radius: 7, color: '#7cf0ff', weight: 2, fillColor: '#7cf0ff', fillOpacity: 0.9 }).addTo(map);
    } else { issMarker.setLatLng([lat, lon]); }
    issMarker.bindPopup(`<div class="ld-quake-popup"><b>ISS</b><br>${num(lat, 2)}, ${num(lon, 2)}<br>${formatTime(ts)}</div>`);
    issTrack.push([lat, lon]);
    if (issTrack.length > ISS_TRACK_MAX) issTrack.shift();
    if (!issTrackLine) issTrackLine = L.polyline(issTrack, { color: '#7cf0ff', weight: 1.5, opacity: 0.5 }).addTo(map);
    else issTrackLine.setLatLngs(issTrack);
  }

  /* ── feeds → views ── */
  async function loadISS() {
    const res = await apiFetch('/iss');
    if (!res || res.status !== 'success') return;
    const records = (res.data || []).filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
    if (!records.length) return;
    issTrack = records.slice(0, ISS_TRACK_MAX).reverse().map(r => [r.latitude, r.longitude]);
    if (issTrackLine) issTrackLine.setLatLngs(issTrack); else if (map) issTrackLine = L.polyline(issTrack, { color: '#7cf0ff', weight: 1.5, opacity: 0.5 }).addTo(map);
    const latest = records[0];
    setISSMarker(latest.latitude, latest.longitude, latest.timeStamp);
  }

  async function loadQuakes() {
    const res = await apiFetch('/quakes');
    if (!res || res.status !== 'success') return;
    const quakes = (res.data || []);
    const count = quakes.length;
    const maxMag = count ? Math.max(...quakes.map(q => parseFloat(q.mag) || 0)) : 0;
    const cEl = document.getElementById('ld-quakes-count'); if (cEl) cEl.textContent = count;
    const mEl = document.getElementById('ld-quakes-max'); if (mEl) mEl.textContent = count ? `M${num(maxMag, 1)}` : '--';

    if (quakeLayer) quakeLayer.clearLayers();
    if (map && quakeLayer) {
      quakes.slice(0, 600).forEach(q => {
        const lat = parseFloat(q.latitude), lon = parseFloat(q.longitude), mag = parseFloat(q.mag) || 0;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const color = mag >= 5 ? '#ef4444' : mag >= 4 ? '#f59e0b' : '#22c55e';
        L.circleMarker([lat, lon], { radius: Math.max(2, mag * 1.6), color, weight: 1, fillColor: color, fillOpacity: 0.35 })
          .bindPopup(`<div class="ld-quake-popup"><b>M${num(mag, 1)}</b> — ${esc(q.place || 'Unknown')}<br>${formatDateTime(q.time)}<br>depth ${num(q.depth, 1)} km</div>`)
          .addTo(quakeLayer);
      });
    }

    const tbody = document.getElementById('ld-quakes-tbody');
    if (tbody) {
      tbody.innerHTML = count ? quakes.slice(0, 50).map(q => {
        const mag = parseFloat(q.mag) || 0;
        return `<tr><td>${formatDateTime(q.time)}</td><td><span class="ld-mag ${magClass(mag)}">${num(mag, 1)}</span></td><td>${esc(q.place || 'Unknown')}</td><td>${num(q.depth, 1)}</td></tr>`;
      }).join('') : '<tr><td colspan="4" class="ld-empty"><i class="fas fa-mountain"></i>No earthquake data</td></tr>';
    }
  }

  async function loadSatellites() {
    if (!satLayer) return;
    satLayer.clearLayers();
    if (!window.satellite) return;
    const res = await apiFetch('/satellites/latest?limit=200');
    if (!res || res.status !== 'success') return;
    // dedupe to the most-recent TLE per satellite
    const byId = new Map();
    (res.data || []).forEach(p => { const id = p.payload?.noradId; if (id && !byId.has(id)) byId.set(id, p.payload); });
    const now = new Date();
    const gmst = window.satellite.gstime(now);
    byId.forEach(tle => {
      try {
        const satrec = window.satellite.twoline2satrec(tle.tle1, tle.tle2);
        const pv = window.satellite.propagate(satrec, now);
        if (!pv.position) return;
        const geo = window.satellite.eciToGeodetic(pv.position, gmst);
        const lat = window.satellite.degreesLat(geo.latitude), lon = window.satellite.degreesLong(geo.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        L.circleMarker([lat, lon], { radius: 4, color: '#a78bfa', weight: 1, fillColor: '#a78bfa', fillOpacity: 0.8 })
          .bindPopup(`<div class="ld-quake-popup"><b>${esc(tle.name)}</b><br>NORAD ${esc(tle.noradId)}<br>${num(lat, 2)}, ${num(lon, 2)}</div>`)
          .addTo(satLayer);
      } catch (e) { /* skip bad TLE */ }
    });
  }

  async function loadSeries(feedId, canvasId, emptyId, label, color, field) {
    const canvas = document.getElementById(canvasId);
    const empty = document.getElementById(emptyId);
    if (!canvas || !window.Chart) return;
    const res = await apiFetch(`/${feedId}/history?limit=200`);
    const rows = (res && res.status === 'success') ? res.data || [] : [];
    const points = rows.map(r => {
      const ts = r.ts || r.timeStamp;
      const v = field.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
      return { x: ts ? new Date(ts).getTime() : null, y: Number(v) };
    }).filter(p => p.x != null && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);

    if (empty) empty.style.display = points.length ? 'none' : 'block';
    canvas.style.display = points.length ? 'block' : 'none';
    const latestEl = document.getElementById(feedId === 'weather' ? 'ld-weather-latest' : 'ld-aqi-latest');
    if (latestEl) latestEl.textContent = points.length ? `${num(points[points.length - 1].y, 1)}` : '';
    if (!points.length) { if (charts[feedId]) { charts[feedId].destroy(); delete charts[feedId]; } return; }

    const labels = points.map(p => formatTime(p.x));
    const data = points.map(p => p.y);
    if (charts[feedId]) {
      charts[feedId].data.labels = labels;
      charts[feedId].data.datasets[0].data = data;
      charts[feedId].update('none');
    } else {
      charts[feedId] = new window.Chart(canvas, {
        type: 'line',
        data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#93a0b5', maxTicksLimit: 6 }, grid: { color: 'rgba(255,255,255,0.04)' } }, y: { ticks: { color: '#93a0b5' }, grid: { color: 'rgba(255,255,255,0.04)' } } } }
      });
    }
  }

  // Lightweight inline-SVG sparkline for numeric point feeds (no Chart instance).
  async function loadSparkline(feed) {
    const svg = document.getElementById(`ld-spark-${feed.id}`);
    if (!svg) return;
    const field = feed.id === 'air_quality' ? 'payload.pm2_5' : 'payload.value';
    const res = await apiFetch(`/${feed.id}/history?limit=40`);
    const rows = (res && res.status === 'success') ? res.data || [] : [];
    const vals = rows.map(r => Number(field.split('.').reduce((o, k) => (o == null ? o : o[k]), r))).filter(Number.isFinite);
    if (vals.length < 2) { svg.innerHTML = ''; return; }
    const w = 220, h = 28, min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`).join(' ');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>`;
  }

  /* ── SSE (live ISS marker) ── */
  function openStream(feedId, onDoc) {
    if (sse[feedId]) return;
    try {
      const es = new EventSource(`${API_BASE}/${feedId}/stream`);
      es.onmessage = (e) => { try { const evt = JSON.parse(e.data); if (evt && evt.doc) onDoc(evt.doc); } catch (_) {} };
      es.onerror = () => { es.close(); delete sse[feedId]; };
      sse[feedId] = es;
    } catch (_) { /* SSE unsupported */ }
  }
  function closeStream(feedId) { if (sse[feedId]) { sse[feedId].close(); delete sse[feedId]; } }

  /* ── orchestration ── */
  async function refreshAll() {
    await loadFeeds();
    const on = (id) => state.masterEnabled && state.enabled[id];
    if (on('iss')) { await loadISS(); openStream('iss', d => { if (Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) setISSMarker(d.latitude, d.longitude, d.timeStamp); }); } else closeStream('iss');
    if (on('quakes')) await loadQuakes(); else if (quakeLayer) quakeLayer.clearLayers();
    if (on('satellites')) await loadSatellites(); else if (satLayer) satLayer.clearLayers();
    if (on('weather')) await loadSeries('weather', 'ld-chart-weather', 'ld-chart-weather-empty', 'Pressure (hPa)', '#8b5cf6', 'pressure');
    if (on('air_quality')) await loadSeries('air_quality', 'ld-chart-aqi', 'ld-chart-aqi-empty', 'PM2.5', '#22c55e', 'payload.pm2_5');
  }

  async function loadConfig() {
    const res = await apiFetch('/state');
    if (res && res.status === 'success') { state.masterEnabled = !!res.data.liveDataEnabled; updateMasterUI(); }
    await refreshAll();
  }

  function startTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (state.masterEnabled) refreshAll(); }, REFRESH_INTERVAL_MS);
  }

  function onTabShown() { ensureMap(); if (map) setTimeout(() => map.invalidateSize(), 60); }

  function bindEvents() {
    const master = document.getElementById('ld-master-toggle');
    if (master) master.addEventListener('change', (e) => toggleService('liveDataEnabled', e.target.checked));
    document.querySelectorAll('[data-toggle-section]').forEach(h => h.addEventListener('click', () => {
      const sec = document.getElementById(`ld-section-${h.dataset.toggleSection}`);
      if (sec) { sec.classList.toggle('collapsed'); if (h.dataset.toggleSection === 'map') onTabShown(); }
    }));
    const tabBtn = document.querySelector('.tab-btn[data-tab="live-data"]');
    if (tabBtn) tabBtn.addEventListener('click', () => setTimeout(onTabShown, 50));
    window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); Object.keys(sse).forEach(closeStream); });
  }

  function init() {
    bindEvents();
    ensureMap();        // create the map BEFORE the first data load so markers land on it
    loadConfig();
    startTimer();
    setTimeout(onTabShown, 120); // invalidateSize once layout settles
  }

  return { init };
})();
