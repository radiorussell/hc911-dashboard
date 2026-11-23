// Congestion minimap for the main board — Waze jams plus TDOT congestion/closure
// events only. Cameras, signs and hazards stay on traffic.html.
// Data: same-origin data/traffic.json (written by scripts/fetch_traffic.py).

const MINIMAP_DATA = 'data/traffic.json';
const MINIMAP_REFRESH_MS = 120_000;

(() => {
  const el = document.getElementById('minimap');
  if (!el || typeof L === 'undefined') return;

  const css = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const RED = css('--red', '#ff5d5d');
  const AMBER = css('--amber', '#ffb02e');
  const ACCENT = css('--accent', '#4ea1ff');
  const MUTED = css('--muted', '#8b98ad');

  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false, // don't hijack page scroll; drag/zoom buttons still work
    dragging: true,
    doubleClickZoom: true,
  }).setView([35.0456, -85.3097], 10);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  const jams = L.layerGroup().addTo(map);
  const events = L.layerGroup().addTo(map);

  // Waze severity: standstill is the only red thing on this map.
  const jamColor = (sub = '') =>
    /STAND_STILL/.test(sub) ? RED : /HEAVY/.test(sub) ? AMBER : ACCENT;
  const jamRadius = (sub = '') => (/STAND_STILL/.test(sub) ? 8 : /HEAVY/.test(sub) ? 7 : 5);

  function draw(data) {
    jams.clearLayers();
    events.clearLayers();

    const waze = (data.waze || []).filter((w) => w.type === 'JAM');
    const standstill = waze.filter((w) => /STAND_STILL/.test(w.sub || '')).length;

    for (const w of waze) {
      const color = jamColor(w.sub);
      L.circleMarker([w.lat, w.lng], {
        radius: jamRadius(w.sub),
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.28,
      })
        .bindPopup(`<strong>${w.sub === 'JAM_STAND_STILL_TRAFFIC' ? 'Standstill' : 'Heavy traffic'}</strong><br>${w.street || ''}`)
        .addTo(jams);
    }

    // TDOT side: only what is plausibly congestion or a closure, and only what TDOT
    // has touched in the last 48 h — the feed carries months-old work orders.
    const active = (data.events || []).filter((e) => {
      const stamp = e.revised || e.began;
      const fresh = stamp && (Date.now() - new Date(stamp).getTime()) / 3.6e6 < 48;
      return fresh && (e.closure || /congestion/i.test(e.subtype || '') || e.kind === 'Incident');
    });

    for (const e of active) {
      if (e.lat == null) continue;
      const color = e.closure ? RED : AMBER;
      for (const seg of e.lines || []) L.polyline(seg, { color, weight: 3, opacity: 0.45 }).addTo(events);
      L.circleMarker([e.lat, e.lng], { radius: 5, color, fillColor: color, fillOpacity: 0.9, weight: 1 })
        .bindPopup(`<strong>${e.subtype}</strong><br>${e.impact || ''}`)
        .addTo(events);
    }

    const note = document.getElementById('cong-note');
    if (note) note.textContent = `${waze.length} jam${waze.length === 1 ? '' : 's'} · ${active.length} TDOT`;
    const legend = document.getElementById('cong-legend');
    if (legend) {
      const heavy = waze.length - standstill;
      const parts = [];
      if (standstill) parts.push(`<i class="dot-key" style="background:${RED}"></i>${standstill} standstill`);
      if (heavy) parts.push(`<i class="dot-key" style="background:${AMBER}"></i>${heavy} heavy`);
      if (!parts.length) parts.push(`<i class="dot-key" style="background:${MUTED}"></i>no jams reported`);
      if (active.length) parts.push(`<i class="dot-key" style="background:${MUTED}"></i>${active.length} TDOT`);
      legend.innerHTML = parts.join(' ');
    }
  }

  async function load() {
    try {
      const res = await fetch(`${MINIMAP_DATA}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      draw(await res.json());
    } catch (err) {
      const note = document.getElementById('cong-note');
      if (note) note.textContent = 'traffic feed unavailable';
      console.error('minimap: traffic.json load failed', err);
    }
  }

  // Leaflet needs a size recalc once the grid gives the panel its column width.
  setTimeout(() => map.invalidateSize(), 400);
  window.addEventListener('resize', () => map.invalidateSize());

  load();
  setInterval(load, MINIMAP_REFRESH_MS);
})();
