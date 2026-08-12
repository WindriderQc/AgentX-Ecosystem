(function () {
  const byId = (id) => document.getElementById(id);
  const text = (id, value) => { byId(id).textContent = value; };
  const format = (value) => value ? new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : '—';
  const points = [
    ['back-left', 'Arrière gauche', -1, 1], ['back-center', 'Arrière centre', 0, 1], ['back-right', 'Arrière droite', 1, 1],
    ['center-left', 'Centre gauche', -1, 0], ['center', 'Centre', 0, 0], ['center-right', 'Centre droite', 1, 0],
    ['front-left', 'Avant gauche', -1, -1], ['front-center', 'Avant centre', 0, -1], ['front-right', 'Avant droite', 1, -1]
  ].map(([id, label, x, y]) => ({ id, label, x, y }));
  let maps = [];

  const currentPoints = () => points.map((point) => ({ ...point, z: Number(byId(`bed-${point.id}`).value) }));
  const pointMap = (values) => new Map(values.map((point) => [point.id, point]));
  const color = (z) => z > .02 ? '#f59e0b' : z < -.02 ? '#38bdf8' : '#4ade80';
  const project = ({ x, y, z }) => [320 + (x - y) * 115, 198 + (x + y) * 45 - z * 115];

  function renderMap(values) {
    const data = values && values.length === 9 ? values : points.map((point) => ({ ...point, z: 0 }));
    const lookup = pointMap(data);
    const quad = (a, b, c, d) => [a, b, c, d].map((id) => project(lookup.get(id)).join(',')).join(' ');
    const cells = [
      ['back-left', 'back-center', 'center', 'center-left'], ['back-center', 'back-right', 'center-right', 'center'],
      ['center-left', 'center', 'front-center', 'front-left'], ['center', 'center-right', 'front-right', 'front-center']
    ];
    const lines = cells.map((cell) => {
      const average = cell.reduce((total, id) => total + lookup.get(id).z, 0) / 4;
      return `<polygon points="${quad(...cell)}" fill="${color(average)}" fill-opacity=".72" stroke="#cbd5e1" stroke-width="2"/>`;
    }).join('');
    const nodes = data.map((point) => {
      const [x, y] = project(point); const labelY = y - 12;
      return `<circle cx="${x}" cy="${y}" r="7" fill="#f8fafc" stroke="#0f172a" stroke-width="2"/><text x="${x}" y="${labelY}" text-anchor="middle" fill="#e2e8f0" font-size="15">${point.z.toFixed(2)}</text>`;
    }).join('');
    byId('bedMapSurface').innerHTML = `<rect width="640" height="380" fill="#0f172a"/>${lines}${nodes}<text x="320" y="350" text-anchor="middle" fill="#94a3b8" font-size="15">mm · vue isométrique</text>`;
  }

  function addInputs() {
    byId('bedMapInputs').innerHTML = points.map((point) => `<label>${point.label}<input id="bed-${point.id}" type="number" step="0.01" min="-2" max="2" value="${point.id === 'center' ? '0.00' : ''}" required></label>`).join('');
    points.forEach((point) => byId(`bed-${point.id}`).addEventListener('input', () => {
      const values = currentPoints(); if (values.every((value) => Number.isFinite(value.z))) renderMap(values);
    }));
  }

  function useMap(map) {
    pointMap(map.points).forEach((point, id) => { const input = byId(`bed-${id}`); if (input) input.value = point.z.toFixed(2); });
    byId('bedMapNote').value = map.note || '';
    renderMap(map.points); text('bedMapStatus', `Carte du ${format(map.createdAt)}`);
  }

  async function loadMaps() {
    const response = await fetch('/api/printer-vision/bed-maps/anet-a7', { cache: 'no-store' });
    if (!response.ok) throw new Error('bed maps unavailable');
    maps = (await response.json()).data.maps;
    const history = byId('bedMapHistory');
    history.innerHTML = maps.length ? maps.map((map, index) => `<option value="${index}">${format(map.createdAt)} · ${map.mode}</option>`).join('') : '<option value="">Aucune carte enregistrée</option>';
    if (maps.length) useMap(maps[0]); else renderMap();
  }

  async function saveMap(event) {
    event.preventDefault();
    const values = currentPoints();
    if (!values.every((point) => Number.isFinite(point.z))) return text('bedMapStatus', 'Les neuf valeurs sont requises');
    const response = await fetch('/api/printer-vision/bed-maps/anet-a7', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printerName: 'ANET A7', note: byId('bedMapNote').value, points: values }) });
    if (!response.ok) return text('bedMapStatus', 'Enregistrement refusé');
    const map = (await response.json()).data.map; maps.unshift(map);
    const history = byId('bedMapHistory'); history.innerHTML = maps.map((item, index) => `<option value="${index}">${format(item.createdAt)} · ${item.mode}</option>`).join('');
    history.value = '0'; useMap(map);
  }

  async function refresh() {
    try {
      const response = await fetch('/api/printer-vision/status/anet-a7', { cache: 'no-store' });
      if (!response.ok) throw new Error('status unavailable');
      const state = (await response.json()).data.printer; const stale = Date.now() - new Date(state.lastAnalysisAt).getTime() > state.intervalSeconds * 3000;
      const monitor = byId('printerVisionMonitor'); monitor.textContent = stale ? 'Analyse en retard' : 'Analyse active'; monitor.className = `printer-vision-badge ${stale ? 'is-stale' : 'is-active'}`;
      text('printerVisionVerdict', state.status); text('printerVisionConfidence', state.confidence); text('printerVisionObservations', state.observations); text('printerVisionFirst', format(state.firstAnalysisAt)); text('printerVisionLast', format(state.lastAnalysisAt)); text('printerVisionInterval', `${state.intervalSeconds} secondes`); text('printerVisionCaption', `Image analysée à ${format(state.lastAnalysisAt)}`); byId('printerVisionImage').src = `${state.imageUrl}?ts=${Date.now()}`;
    } catch { const monitor = byId('printerVisionMonitor'); monitor.textContent = 'En attente du moniteur'; monitor.className = 'printer-vision-badge is-stale'; }
  }

  addInputs(); renderMap(); refresh(); loadMaps().catch(() => text('bedMapStatus', 'Historique indisponible'));
  byId('bedMapForm').addEventListener('submit', saveMap); byId('bedMapHistory').addEventListener('change', (event) => { if (maps[event.target.value]) useMap(maps[event.target.value]); });
  setInterval(refresh, 3000);
}());
