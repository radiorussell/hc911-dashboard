// TDOT SmartWay traffic panel — feasibility spike.
// Reads same-origin data/traffic.json (written by scripts/fetch_traffic.py).
// No frameworks beyond Leaflet, no build step.

const DATA_URL = 'data/traffic.json';
const CALLS_URL = 'data/calls.json';
const REFRESH_MS = 60_000;
const SHOT_MS = 60_000;

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const relFmt = new Intl.RelativeTimeFormat([], { numeric: 'auto' });

function clockTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : timeFmt.format(d);
}
function ago(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return relFmt.format(-mins, 'minute');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return relFmt.format(-hrs, 'hour');
  return relFmt.format(-Math.round(hrs / 24), 'day');
}
const stamp = (url) => (url ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : '');

const state = {
  data: null,
  calls: [],
  scope: 'hamilton',
  watchScope: 'traffic',
  watchOrder: [],
  showLongTerm: false,
  layers: { events: true, cameras: true, waze: true, signs: true },
  basemap: true,
};

// Straight-line miles — good enough when cameras sit on interchanges and 911 points
// are block-level geocodes. (haversine, not the flat approximation)
function miles(aLat, aLng, bLat, bLng) {
  const R = 3958.8;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Which dispatch calls are worth pointing a camera at. EMS calls, thefts and
// domestics are deliberately excluded from the default view — a newsroom cares
// about the ones that close a road.
const TRAFFIC_RE = /MVC|ACCIDENT|CRASH|ROAD CLOSURE|VEHICLE FIRE|HIT AND RUN|BROKEN DOWN|DISABLED|HAZARD|TRAFFIC/i;
const WATCH_RADIUS_MI = 3;

/* ---------------- map ---------------- */
const map = L.map('traffic-map', { zoomControl: true, attributionControl: true, scrollWheelZoom: true })
  .setView([35.0456, -85.3097], 10);

// CARTO's free dark basemap now stamps "API KEY REQUIRED" over every tile, so the
// spike uses OSM's standard tiles inverted to dark via CSS (no key, attribution kept).
const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
});
tiles.addTo(map);

const groups = {
  events: L.layerGroup().addTo(map),
  cameras: L.layerGroup().addTo(map),
  waze: L.layerGroup().addTo(map),
  signs: L.layerGroup().addTo(map),
};

const markerFor = (item) => ({ events: [], cameras: [], waze: [], signs: [] });

function dot(lat, lng, opts) {
  return L.circleMarker([lat, lng], { radius: 6, weight: 1, fillOpacity: 0.85, ...opts });
}

function drawMap() {
  const d = state.data;
  for (const k of Object.keys(groups)) groups[k].clearLayers();

  for (const ev of d.events) {
    if (ev.lat == null) continue;
    const color = ev.closure ? '#ff5d5d' : ev.kind === 'Incident' ? '#ffb02e' : '#b48cff';
    for (const seg of ev.lines || []) groups.events.addLayer(L.polyline(seg, { color, weight: 4, opacity: 0.55 }));
    groups.events.addLayer(
      dot(ev.lat, ev.lng, { color, fillColor: color, radius: ev.closure ? 7 : 5 }).bindPopup(
        `<strong>${esc(ev.subtype)}</strong><br>${esc(ev.impact || '')}<br><small>${esc(ev.desc || '')}</small>`
      )
    );
  }

  for (const c of d.cameras) {
    groups.cameras.addLayer(
      dot(c.lat, c.lng, { color: '#4ea1ff', fillColor: '#4ea1ff', radius: 4, weight: 1, fillOpacity: 0.9 })
        .bindPopup(`<strong>${esc(c.title)}</strong><br>${esc(c.route || '')} MM ${esc(c.mm || '')}`)
        .on('click', () => openLightbox(c))
    );
  }

  for (const w of d.waze) {
    const color = w.type === 'JAM' ? '#ff5d5d' : '#b48cff';
    groups.waze.addLayer(
      dot(w.lat, w.lng, { color, fillColor: 'transparent', radius: 7, weight: 2 }).bindPopup(
        `<strong>${esc(w.type)}</strong> ${esc(w.sub || '')}<br>${esc(w.street || '')} — ${esc(w.city || '')}`
      )
    );
  }

  for (const s of d.signs) {
    groups.signs.addLayer(
      L.circleMarker([s.lat, s.lng], { radius: 4, color: '#8b98ad', fillColor: '#8b98ad', fillOpacity: 0.6, weight: 1 })
        .bindPopup(`<strong>${esc(s.title)}</strong><br>${esc((s.msg || '(blank)').replace(/\|/g, ' · '))}`)
    );
  }

  for (const [k, g] of Object.entries(groups)) {
    if (state.layers[k]) map.addLayer(g);
    else map.removeLayer(g);
  }
}

/* ---------------- lists ---------------- */
// TDOT keeps months-old work orders in the same feed as live incidents, so "active"
// means revised in the last 48 h. Long-term projects are opt-in behind a chip.
const LONGTERM_H = 48;
const isLongTerm = (e) => {
  const stamp = e.revised || e.began;
  return !stamp || (Date.now() - new Date(stamp).getTime()) / 3.6e6 > LONGTERM_H;
};

function renderEvents() {
  const rows = state.data.events
    .filter((e) => state.scope === 'all' || e.county === 'Hamilton')
    .filter((e) => state.showLongTerm || !isLongTerm(e));
  $('#event-list').innerHTML = rows.length
    ? rows
        .map((e) => {
          const tags = [
            e.closure ? '<span class="tag closure">closure</span>' : '',
            e.severe ? '<span class="tag severe">severe</span>' : '',
            e.kind === 'Incident' ? '<span class="tag incident">incident</span>' : '',
            e.county && e.county !== 'Hamilton' ? `<span class="tag near">${esc(e.county)}</span>` : '',
          ].join('');
          return `<li><span class="ev" data-id="${esc(e.id)}">
            <span class="top"><span class="kind">${esc(e.subtype)}</span>${tags}</span>
            <span class="meta"><span>${clockTime(e.revised)} · ${ago(e.revised)}</span>
              <span class="impact">${esc(e.impact || '')}</span>
              <span>${esc(e.direction || '')}</span></span>
            <span class="where">${esc(e.desc || '')}</span></span></li>`;
        })
        .join('')
    : '<li><p class="empty">No active TDOT events in range.</p></li>';
  const hidden = state.data.events.filter((e) => (state.scope === 'all' || e.county === 'Hamilton') && isLongTerm(e)).length;
  $('#event-note').textContent = `${rows.length} active in ${state.scope === 'all' ? '35-mile box' : 'Hamilton County'}` +
    (state.showLongTerm ? ` · ${hidden} long-term projects shown` : ` · ${hidden} long-term hidden`);
  for (const el of document.querySelectorAll('.ev')) {
    el.addEventListener('click', () => {
      const ev = state.data.events.find((x) => String(x.id) === el.dataset.id);
      if (ev?.lat != null) {
        map.setView([ev.lat, ev.lng], 13);
        for (const layer of groups.events.getLayers()) {
          if (layer.getLatLng && layer.getLatLng().lat === ev.lat) layer.openPopup();
        }
      }
    });
  }
}

function renderWaze() {
  const rows = state.data.waze || [];
  $('#waze-count').textContent = `${rows.length} in view`;
  $('#waze-list').innerHTML = rows.length
    ? rows
        .map(
          (w) => `<li><span class="ev"><span class="top">
            <span class="kind waze-type">${esc((w.type || '').toLowerCase())} · ${esc((w.sub || '').replace(/^(JAM|HAZARD|ROAD_CLOSURE)_/, '').toLowerCase().replace(/_/g, ' '))}</span>
            <span class="tag">${esc(ago(w.at))}</span></span>
            <span class="where">${esc(w.street || '—')}${w.city ? ' · ' + esc(w.city) : ''}${w.desc ? ' · ' + esc(w.desc) : ''}</span></span></li>`
        )
        .join('')
    : '<li><p class="empty">No Waze reports right now.</p></li>';
}

function renderSigns() {
  const signs = state.data.signs || [];
  // Only signs with something actually posted: a blank board is not news, and the
  // list was mostly "BLANK" rows. The count keeps the in-range total for context.
  const rows = signs.filter((s) => (s.msg || '').trim());
  $('#sign-count').textContent = rows.length ? `${rows.length} lit of ${signs.length}` : `${signs.length} in range`;
  $('#sign-list').innerHTML = rows.length
    ? rows
        .map(
          (s) => `<li><span class="ev"><span class="top"><span class="kind">${esc(s.title)}</span></span>
            <span class="where">${esc(s.msg.replace(/\|/g, ' · '))}</span></span></li>`
        )
        .join('')
    : '<li><p class="empty">No message signs showing text right now.</p></li>';
}

/* ---------------- incident watch: nearest cameras to each live call ---------------- */
const pillClass = (s) =>
  ({ Queued: 'queued', Enroute: 'enroute', 'On Scene': 'scene', Transporting: 'transport', 'At Hospital': 'hospital', Stacked: 'queued' }[s] || 'queued');

function watchIncidents() {
  const rows = state.calls
    .filter((c) => c.lat && c.lon && Math.abs(c.lat) > 0.01) // 911 sends 0,0 for ungeocoded rows
    .filter((c) => state.watchScope === 'all' || TRAFFIC_RE.test(c.type || ''))
    .sort((a, b) => new Date(b.created) - new Date(a.created));
  // The feed sometimes carries the same incident twice (block range + exact address,
  // or two callers). Collapse same-type calls within 0.3 mi of one already shown.
  const kept = [];
  for (const c of rows) {
    const dupe = kept.some((k) => k.type === c.type && miles(k.lat, k.lon, c.lat, c.lon) < 0.3);
    if (!dupe) kept.push(c);
  }
  return kept;
}

// For every call, rank cameras by distance and hand out the closest ones. A camera
// already claimed by a nearer call is skipped so four MVCs on the same road don't
// all show the same three intersections.
function computeWatch() {
  const cams = state.data.cameras.filter((c) => c.lat != null);
  const claimed = new Map();
  const rows = [];
  for (const call of watchIncidents()) {
    const ranked = cams
      .map((cam) => ({ cam, d: miles(call.lat, call.lon, cam.lat, cam.lng) }))
      .filter((x) => x.d <= WATCH_RADIUS_MI)
      .sort((a, b) => a.d - b.d);
    const picks = [];
    for (const { cam, d } of ranked) {
      if (picks.length >= 2) break;
      const owner = claimed.get(cam.id);
      if (owner && owner <= d) continue;
      claimed.set(cam.id, d);
      picks.push({ cam, d });
    }
    rows.push({ call, picks });
  }
  state.watchOrder = [...claimed.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  return rows;
}

function renderWatch() {
  const rows = computeWatch();
  const withCams = rows.filter((r) => r.picks.length);
  $('#watch-list').innerHTML = rows.length
    ? rows
        .map(({ call, picks }) => {
          const status = (call.status || '').toLowerCase();
          return `<article class="watch">
            <header>
              <span class="wtype">${esc(call.type)}</span>
              <span class="pill ${pillClass(call.status)}">${esc(call.status || '')}</span>
              <span class="wtime">${clockTime(call.created)} · ${ago(call.created)}</span>
            </header>
            <p class="waddr">${esc(call.address)}${call.cross && !/No Cross Street/.test(call.cross) ? ' <small>· ' + esc(call.cross) + '</small>' : ''}</p>
            ${picks.length
              ? `<div class="wstrip">${picks
                  .map(
                    ({ cam, d }) => `<button class="cam" data-cam="${esc(cam.id)}">
                        <img loading="lazy" src="${stamp(cam.thumb)}" alt="${esc(cam.title)} snapshot">
                        ${cam.hls ? '<i class="cam-live" title="live video available"></i>' : ''}
                        <span>${esc(cam.title)}<small>${d.toFixed(1)} mi away</small></span>
                      </button>`
                  )
                  .join('')}</div>`
              : `<p class="wnone">No TDOT camera within ${WATCH_RADIUS_MI} mi.</p>`}
          </article>`;
        })
        .join('')
    : '<p class="empty">No active calls in this scope.</p>';
  $('#watch-note').textContent = `${rows.length} active call${rows.length === 1 ? '' : 's'} · ${withCams.length} with a camera within ${WATCH_RADIUS_MI} mi · updated ${clockTime(state.calls[0]?.created || null)}`;
  for (const el of document.querySelectorAll('#watch-list [data-cam]')) {
    el.addEventListener('click', () => {
      const cam = state.data.cameras.find((c) => String(c.id) === el.dataset.cam);
      if (cam) openLightbox(cam);
    });
  }
}

// Two grids, Tennessee above Georgia. Cameras nearest a live call float to the top of
// whichever box they belong to.
const CAM_PANELS = [
  { grid: '#cam-grid-tn', count: '#cam-count-tn', match: (c) => c.src !== 'GDOT' },
  { grid: '#cam-grid-ga', count: '#cam-count-ga', match: (c) => c.src === 'GDOT' },
];

function renderCams() {
  const byId = new Map(state.data.cameras.map((c) => [c.id, c]));
  const priority = state.watchOrder.map((id) => byId.get(id)).filter(Boolean);
  const ordered = [...priority, ...state.data.cameras.filter((c) => !state.watchOrder.includes(c.id))];

  for (const panel of CAM_PANELS) {
    const cams = ordered.filter(panel.match);
    const near = cams.filter((c) => state.watchOrder.includes(c.id)).length;
    $(panel.count).textContent = `${cams.length} in range · ${near} near calls`;
    $(panel.grid).innerHTML = cams
      .map((c, i) => `<button class="cam ${state.watchOrder.includes(c.id) ? 'hot' : ''}" data-i="${i}">
          <img loading="lazy" src="${stamp(c.thumb)}" alt="${esc(c.title)} live snapshot">
          ${c.hls ? '<i class="cam-live" title="live video available"></i>' : ''}
          <span>${esc(c.title)}<small>${esc(c.route || '')}${c.mm ? ' · MM ' + esc(c.mm) : ''}${state.watchOrder.includes(c.id) ? ' · near call' : ''}</small></span>
        </button>`)
      .join('');
    for (const el of document.querySelectorAll(`${panel.grid} .cam`)) {
      el.addEventListener('click', () => openLightbox(cams[Number(el.dataset.i)]));
    }
  }
}

/* Collapsible camera boxes — state kept in localStorage so a reload remembers it. */
function setupCollapse() {
  for (const btn of document.querySelectorAll('.chip.collapse')) {
    const panel = document.getElementById(btn.dataset.panel);
    if (!panel) continue;
    const apply = (collapsed) => {
      panel.classList.toggle('collapsed', collapsed);
      btn.textContent = collapsed ? 'show' : 'hide';
      btn.setAttribute('aria-expanded', String(!collapsed));
      try {
        localStorage.setItem(btn.dataset.key, collapsed ? '1' : '0');
      } catch (e) { /* private mode */ }
    };
    let saved = null;
    try {
      saved = localStorage.getItem(btn.dataset.key);
    } catch (e) { /* private mode */ }
    apply(saved === '1');
    btn.addEventListener('click', () => apply(!panel.classList.contains('collapsed')));
  }
}

/* ---------------- lightbox: live HLS video with a snapshot fallback ----------------
   TDOT publishes each camera as an HLS stream (320×240) that answers CORS with `*`,
   so the browser can play it directly. Safari handles the playlist natively; Chrome
   and Firefox need hls.js over MSE. Every open builds a FRESH <video> element: reusing
   one element across streams left the previous MediaSource attached and the next
   play() failed with "NotSupportedError: no supported source". */
let lbTimer = null;
let lbHls = null;
let lbVideo = null;
let lbWatchdog = null;

function teardownPlayer() {
  clearTimeout(lbWatchdog);
  lbWatchdog = null;
  if (lbHls) {
    try { lbHls.destroy(); } catch (e) { /* already torn down */ }
    lbHls = null;
  }
  if (lbVideo) {
    try { lbVideo.pause(); } catch (e) { /* not playing */ }
    lbVideo.remove();
    lbVideo = null;
  }
}

function showSnapshot(cam, note) {
  teardownPlayer();
  clearInterval(lbTimer);
  const img = $('#lb-img');
  img.hidden = false;
  img.src = stamp(cam.thumb);
  $('#lb-mode').textContent = 'snapshot';
  $('#lb-mode').classList.add('muted');
  if (note) $('#lb-meta').textContent = `${cam.route || ''} · MM ${cam.mm || ''} · ${note}`;
  lbTimer = setInterval(() => (img.src = stamp(cam.thumb)), SHOT_MS);
}

function playLive(cam) {
  const stage = document.querySelector('.lb-stage');
  const img = $('#lb-img');
  // Keep the snapshot on screen while the stream negotiates — the player fades in
  // over it on the first frame, so nobody stares at a black rectangle.
  img.hidden = false;
  img.src = stamp(cam.thumb);

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.controls = true;
  video.style.opacity = '0';
  stage.appendChild(video);
  lbVideo = video;

  $('#lb-mode').textContent = 'connecting';
  $('#lb-mode').classList.remove('muted');
  $('#lb-meta').textContent = `${cam.route || ''} · MM ${cam.mm || ''} · live CCTV · 320×240`;

  video.addEventListener('playing', () => {
    clearTimeout(lbWatchdog);
    lbWatchdog = null;
    clearInterval(lbTimer);
    lbTimer = null;
    img.hidden = true;
    video.style.opacity = '1';
    $('#lb-mode').textContent = 'live';
  }, { once: true });

  const beginPlayback = () => {
    const attempt = () => {
      if (lbVideo !== video) return;              // a newer camera took the stage
      video.play().catch(() => {
        if (lbVideo === video && video.readyState === 0) $('#lb-mode').textContent = 'press play';
      });
    };
    attempt();
    // A manifest can parse a hair before the first segment is appendable, which
    // rejects the first play() with NotSupportedError; one retry on canplay sticks.
    video.addEventListener('canplay', attempt, { once: true });
  };

  // A camera whose encoder is down can serve a valid playlist that never produces a
  // frame — hls.js stays quiet, so time out into the snapshot instead of a black box.
  lbWatchdog = setTimeout(() => {
    if (lbVideo === video && video.readyState < 2) {
      showSnapshot(cam, 'live stream offline — showing the latest snapshot');
    }
  }, 12000);

  // Prefer hls.js wherever MediaSource exists, even if the browser claims native HLS:
  // Chrome answers canPlayType('application/vnd.apple.mpegurl') with "maybe" but its
  // native player fails these streams intermittently ("no supported source"). Native
  // is only right for Safari, where Hls.isSupported() is false.
  if (window.Hls && Hls.isSupported()) {
    lbHls = new Hls({ maxBufferLength: 12, backBufferLength: 20, enableWorker: true });
    lbHls.attachMedia(video);
    lbHls.on(Hls.Events.MEDIA_ATTACHED, () => lbHls && lbHls.loadSource(cam.hls));
    lbHls.on(Hls.Events.MANIFEST_PARSED, beginPlayback);
    lbHls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      showSnapshot(cam, 'live stream unavailable — showing the latest snapshot');
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = cam.hls;
    beginPlayback();
  } else {
    showSnapshot(cam, 'this browser cannot play HLS — showing snapshots');
  }
}

function openLightbox(cam) {
  $('#lightbox').hidden = false;
  $('#lb-title').textContent = cam.title;
  $('#lb-meta').textContent = `${cam.route || ''} · MM ${cam.mm || ''} · ${cam.jur || ''}`;
  teardownPlayer();
  clearInterval(lbTimer);
  if (cam.hls) playLive(cam);
  else showSnapshot(cam, 'no live stream for this camera — snapshot only');
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  clearInterval(lbTimer);
  lbTimer = null;
  teardownPlayer();
}

/* ---------------- boot ---------------- */
function applyData(d) {
  state.data = d;
  $('#t-events').textContent = d.counts.events;
  $('#t-closures').textContent = d.counts.closures;
  $('#t-cams').textContent = d.counts.cameras;
  $('#t-updated').textContent = clockTime(d.updated);
  drawMap();
  renderEvents();
  renderWaze();
  renderSigns();
  renderWatch();
  renderCams();
}

function applyCalls(payload) {
  state.calls = Array.isArray(payload) ? payload : payload.incidents || [];
  renderWatch();
  renderCams();
}

async function load() {
  const bust = `?t=${Date.now()}`;
  const [traffic, calls] = await Promise.allSettled([
    fetch(DATA_URL + bust, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    fetch(CALLS_URL + bust, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
  ]);
  if (traffic.status === 'fulfilled') applyData(traffic.value);
  else {
    $('#t-updated').textContent = 'stale';
    console.error('traffic.json load failed', traffic.reason);
  }
  if (calls.status === 'fulfilled') applyCalls(calls.value);
  else console.error('calls.json load failed', calls.reason);
}

$('#layer-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layer]');
  if (!b) return;
  const k = b.dataset.layer;
  state.layers[k] = !state.layers[k];
  b.classList.toggle('active', state.layers[k]);
  if (state.layers[k]) map.addLayer(groups[k]);
  else map.removeLayer(groups[k]);
});

$('#longterm-toggle').addEventListener('click', (e) => {
  state.showLongTerm = !state.showLongTerm;
  e.currentTarget.classList.toggle('active', state.showLongTerm);
  e.currentTarget.textContent = state.showLongTerm ? 'long-term: on' : 'long-term';
  renderEvents();
});

$('#county-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scope]');
  if (!b) return;
  state.scope = b.dataset.scope;
  for (const c of document.querySelectorAll('#county-chips .chip')) c.classList.toggle('active', c === b);
  renderEvents();
});

$('#watch-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scope]');
  if (!b) return;
  state.watchScope = b.dataset.scope;
  for (const c of document.querySelectorAll('#watch-chips .chip')) c.classList.toggle('active', c === b);
  renderWatch();
  renderCams();
});

$('#basemap-toggle').addEventListener('click', (e) => {
  state.basemap = !state.basemap;
  e.currentTarget.textContent = `basemap: ${state.basemap ? 'on' : 'off'}`;
  e.currentTarget.classList.toggle('active', state.basemap);
  if (state.basemap) tiles.addTo(map);
  else map.removeLayer(tiles);
  $('#traffic-map').classList.toggle('no-basemap', !state.basemap);
});

$('#lb-close').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

setupCollapse();
load();
setInterval(load, REFRESH_MS);
setInterval(() => {
  for (const img of document.querySelectorAll('#cam-grid img')) {
    const base = img.src.split('?t=')[0];
    img.src = stamp(base);
  }
}, SHOT_MS);
