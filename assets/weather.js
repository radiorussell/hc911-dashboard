// Chattanooga DMA weather board: animated radar loop (RainViewer), active NWS
// alerts, and current conditions (Open-Meteo). All three services send
// Access-Control-Allow-Origin: *, so this runs entirely in the browser — no
// server, no API key, works as-is on GitHub Pages.

const DMA_BOUNDS = [[34.28, -86.18], [35.97, -84.08]];
const DMA_CENTER = [35.05, -85.29];
const RADAR_API = 'https://api.rainviewer.com/public/weather-maps.json';
const ALERTS_API = 'https://api.weather.gov/alerts/active?area=TN,GA,AL&status=actual';
const RADAR_COLOR = 4;          // TWC palette
const FRAME_MS = 420;
const RADAR_REFRESH_MS = 5 * 60_000;
const ALERTS_REFRESH_MS = 5 * 60_000;
const CONDITIONS_REFRESH_MS = 10 * 60_000;

// Counties in the Chattanooga DMA — used to keep NWS alerts regional.
const DMA_COUNTIES = [
  'hamilton', 'bradley', 'sequatchie', 'marion', 'grundy', 'franklin', 'bledsoe',
  'meigs', 'rhea', 'polk', 'mcminn', 'coffee', 'warren', 'van buren', 'cumberland', 'white',
  'catoosa', 'walker', 'dade', 'whitfield', 'murray', 'chattooga', 'gordon',
  'jackson', 'dekalb',
];

const CITIES = [
  { name: 'Chattanooga', lat: 35.0456, lon: -85.3097 },
  { name: 'Cleveland', lat: 35.1595, lon: -84.8766 },
  { name: 'Dalton', lat: 34.7698, lon: -84.9702 },
  { name: 'Fort Payne', lat: 34.4443, lon: -85.7196 },
  { name: 'Scottsboro', lat: 34.6723, lon: -85.7161 },
  { name: 'Athens', lat: 35.4429, lon: -84.5919 },
  { name: 'Crossville', lat: 35.9606, lon: -85.0269 },
  { name: 'LaFayette', lat: 34.7048, lon: -85.2819 },
];

const SEVERITY_COLOR = {
  Extreme: '#ff3b30',
  Severe: '#ff7a1a',
  Moderate: '#ffcc00',
  Minor: '#4ea1ff',
  Unknown: '#8b98ad',
};

const state = {
  frames: [],        // [{time, url, forecast}]
  layers: [],
  index: 0,
  playing: false,
  timer: null,
  showRadar: true,
  showAlerts: true,
  alertLayer: null,
  labels: [],
  alerts: [],
};

const $ = (s) => document.querySelector(s);
const pad2 = (n) => String(n).padStart(2, '0');
const localTime = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/* ---------------- map ---------------- */
const map = L.map('map', {
  center: DMA_CENTER,
  zoom: 8,
  minZoom: 6,
  maxZoom: 11,
  zoomControl: true,
  attributionControl: true,
  maxBounds: [[33.6, -87.2], [36.7, -83.2]],
  maxBoundsViscosity: 0.6,
});
map.fitBounds(DMA_BOUNDS);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
}).addTo(map);

// DMA outline
L.rectangle(DMA_BOUNDS, {
  color: '#4ea1ff',
  weight: 1,
  dashArray: '4 6',
  opacity: 0.55,
  fill: false,
  interactive: false,
}).addTo(map);

// Town labels — the dark basemap is sparse at this zoom.
for (const c of CITIES) {
  const icon = L.divIcon({
    className: 'town-label',
    html: `<span>${c.name}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
  const m = L.marker([c.lat, c.lon], { icon, interactive: false, keyboard: false }).addTo(map);
  state.labels.push(m);
}

/* ---------------- radar ---------------- */
async function loadRadar() {
  try {
    const res = await fetch(RADAR_API, { cache: 'no-store' });
    const data = await res.json();
    const host = data.host;
    const past = (data.radar && data.radar.past) || [];
    const nowcast = (data.radar && data.radar.nowcast) || [];

    const frames = [
      ...past.map((f) => ({
        time: f.time * 1000,
        url: `${host}${f.path}/256/{z}/{x}/{y}/${RADAR_COLOR}/1_1.png`,
        forecast: false,
      })),
      ...nowcast.map((f) => ({
        time: f.time * 1000,
        url: `${host}${f.path}/256/{z}/{x}/{y}/${RADAR_COLOR}/1_1.png`,
        forecast: true,
      })),
    ];
    if (!frames.length) throw new Error('no radar frames');

    for (const l of state.layers) map.removeLayer(l);
    state.layers = frames.map((f) =>
      L.tileLayer(f.url, { opacity: 0.75, tileSize: 256, zIndex: 400, attribution: '' })
    );

    state.frames = frames;
    $('#timeline').max = String(frames.length - 1);
    state.index = frames.length - 1;
    showFrame(state.index);
    $('#radar-stamp').textContent = `updated ${localTime(Date.now())}`;
    ['#toggle-radar'].forEach((s) => ($(s).disabled = false));
  } catch (err) {
    console.error('radar failed', err);
    $('#radar-stamp').textContent = 'radar unavailable';
  }
}

function showFrame(i) {
  if (!state.frames.length) return;
  state.index = Math.max(0, Math.min(i, state.frames.length - 1));
  state.layers.forEach((l, idx) => {
    if (idx === state.index) {
      if (!map.hasLayer(l)) l.addTo(map);
    } else if (map.hasLayer(l)) {
      map.removeLayer(l);
    }
  });
  const f = state.frames[state.index];
  $('#timeline').value = String(state.index);
  $('#frame-time').textContent = localTime(f.time);
  const ageMin = Math.round((Date.now() - f.time) / 60000);
  const label = f.forecast ? 'forecast' : ageMin <= 1 ? 'now' : `${ageMin} min ago`;
  $('#frame-mode').textContent = state.showRadar ? label : 'radar off';
  $('#frame-mode').className = f.forecast ? 'forecast' : '';
}

function play() {
  if (state.playing) return;
  state.playing = true;
  $('#play').classList.add('playing');
  $('#play').textContent = '❚❚';
  if (state.index >= state.frames.length - 1) state.index = 0;
  state.timer = setInterval(() => {
    const next = state.index + 1;
    showFrame(next >= state.frames.length ? 0 : next);
  }, FRAME_MS);
}

function pause() {
  state.playing = false;
  $('#play').classList.remove('playing');
  $('#play').textContent = '▶';
  clearInterval(state.timer);
}

/* ---------------- alerts ---------------- */
const zoneCache = new Map();

async function zoneGeometry(url) {
  if (zoneCache.has(url)) return zoneCache.get(url);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/geo+json' } });
    const g = await r.json();
    const geom = g.geometry || null;
    zoneCache.set(url, geom);
    return geom;
  } catch {
    zoneCache.set(url, null);
    return null;
  }
}

function inRegion(props) {
  const area = (props.areaDesc || '').toLowerCase();
  return DMA_COUNTIES.some((c) => area.includes(c));
}

async function loadAlerts() {
  try {
    const res = await fetch(ALERTS_API, { headers: { Accept: 'application/geo+json' }, cache: 'no-store' });
    const data = await res.json();
    const features = (data.features || []).filter((f) => inRegion(f.properties));
    state.alerts = features;

    if (state.alertLayer) {
      map.removeLayer(state.alertLayer);
      state.alertLayer = null;
    }
    const group = L.layerGroup();

    for (const f of features) {
      const p = f.properties;
      const color = SEVERITY_COLOR[p.severity] || SEVERITY_COLOR.Unknown;
      const style = { color, weight: 2, fillColor: color, fillOpacity: 0.12 };
      const popup = `<strong>${escapeHtml(p.event || '')}</strong><br>
        ${escapeHtml(p.areaDesc || '')}<br>
        <em>until ${new Date(p.expires).toLocaleString()}</em>
        ${p.instruction ? `<br><br>${escapeHtml(p.instruction).slice(0, 400)}` : ''}`;

      const geoms = [];
      if (f.geometry) geoms.push(f.geometry);
      else {
        const zones = (p.affectedZones || []).slice(0, 4);
        for (const z of zones) {
          const g = await zoneGeometry(z);
          if (g) geoms.push(g);
        }
      }
      for (const g of geoms) {
        L.geoJSON(g, { style, interactive: true }).bindPopup(popup).addTo(group);
      }
    }

    if (state.showAlerts) group.addTo(map);
    state.alertLayer = group;

    renderAlerts(features);
    $('#alert-count').textContent = features.length;
  } catch (err) {
    console.error('alerts failed', err);
    $('#alerts-note').textContent = 'NWS alerts unavailable right now.';
  }
}

function renderAlerts(features) {
  const list = $('#alerts-list');
  const note = $('#alerts-note');
  if (!features.length) {
    list.innerHTML = '';
    note.textContent = 'No active watches, warnings or advisories in the DMA.';
    return;
  }
  note.textContent = `${features.length} active for the DMA. Click one to zoom.`;
  list.innerHTML = features
    .map((f, i) => {
      const p = f.properties;
      const until = p.ends ? new Date(p.ends).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
      return `<li class="sev-${p.severity || 'Unknown'}" data-idx="${i}">
        <div class="ev">${escapeHtml(p.event || '')}</div>
        <div class="where">${escapeHtml((p.areaDesc || '').split(';').slice(0, 3).join(', '))}</div>
        <div class="until">${until ? 'until ' + until : ''}</div>
      </li>`;
    })
    .join('');
  list.querySelectorAll('li').forEach((el) => {
    el.addEventListener('click', () => {
      const f = features[Number(el.dataset.idx)];
      const layers = [];
      state.alertLayer.eachLayer((l) => {
        if (l.getPopup() && l.getPopup().getContent().includes(f.properties.event)) layers.push(l);
      });
      if (layers.length) {
        const b = layers[0].getBounds();
        map.fitBounds(b.pad(0.2));
        layers[0].openPopup();
      }
    });
  });
}

/* ---------------- conditions ---------------- */
const WMO = {
  0: ['☀️', 'clear'], 1: ['🌤️', 'mostly clear'], 2: ['⛅', 'partly cloudy'], 3: ['☁️', 'overcast'],
  45: ['🌫️', 'fog'], 48: ['🌫️', 'freezing fog'],
  51: ['🌦️', 'light drizzle'], 53: ['🌦️', 'drizzle'], 55: ['🌦️', 'heavy drizzle'],
  61: ['🌧️', 'light rain'], 63: ['🌧️', 'rain'], 65: ['🌧️', 'heavy rain'],
  66: ['🌧️', 'freezing rain'], 67: ['🌧️', 'freezing rain'],
  71: ['🌨️', 'light snow'], 73: ['🌨️', 'snow'], 75: ['❄️', 'heavy snow'], 77: ['🌨️', 'snow grains'],
  80: ['🌦️', 'showers'], 81: ['🌧️', 'showers'], 82: ['⛈️', 'heavy showers'],
  85: ['🌨️', 'snow showers'], 86: ['❄️', 'heavy snow showers'],
  95: ['⛈️', 'thunderstorm'], 96: ['⛈️', 'storm with hail'], 99: ['⛈️', 'severe storm with hail'],
};
const describe = (code) => WMO[code] || ['•', 'n/a'];

async function loadConditions() {
  const lats = CITIES.map((c) => c.lat).join(',');
  const lons = CITIES.map((c) => c.lon).join(',');
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
    '&current=temperature_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,weather_code' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    const rows = Array.isArray(data) ? data : [data];
    $('#conditions').innerHTML = rows
      .map((row, i) => {
        const c = CITIES[i] || {};
        const cur = row.current || {};
        const [icon, label] = describe(cur.weather_code);
        const dir = cur.wind_direction_10m;
        const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((dir % 360) / 45)) % 8] || '';
        return `<li>
          <span class="city"><span class="wmo">${icon}</span>${escapeHtml(c.name || '')}</span>
          <span class="temp">${Math.round(cur.temperature_2m)}°</span>
          <span class="meta">${label} · feels ${Math.round(cur.apparent_temperature)}° · ${Math.round(cur.wind_speed_10m)} mph ${compass}</span>
        </li>`;
      })
      .join('');
  } catch (err) {
    console.error('conditions failed', err);
    $('#conditions').innerHTML = '<li class="meta">Conditions unavailable right now.</li>';
  }
}

/* ---------------- helpers ---------------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- controls ---------------- */
$('#play').addEventListener('click', () => (state.playing ? pause() : play()));

$('#timeline').addEventListener('input', (e) => {
  pause();
  showFrame(Number(e.target.value));
});

$('#toggle-radar').addEventListener('change', (e) => {
  state.showRadar = e.target.checked;
  if (!state.showRadar) {
    state.layers.forEach((l) => map.hasLayer(l) && map.removeLayer(l));
    $('#frame-mode').textContent = 'radar off';
  } else {
    showFrame(state.index);
  }
});

$('#toggle-alerts').addEventListener('change', (e) => {
  state.showAlerts = e.target.checked;
  if (!state.alertLayer) return;
  if (state.showAlerts) state.alertLayer.addTo(map);
  else map.removeLayer(state.alertLayer);
});

$('#toggle-labels').addEventListener('change', (e) => {
  state.labels.forEach((m) => (e.target.checked ? m.addTo(map) : map.removeLayer(m)));
});

setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);
$('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });

/* ---------------- boot ---------------- */
(async function init() {
  await loadRadar();
  play();                       // radar loops on arrival
  loadAlerts();
  loadConditions();
  setInterval(loadRadar, RADAR_REFRESH_MS);
  setInterval(loadAlerts, ALERTS_REFRESH_MS);
  setInterval(loadConditions, CONDITIONS_REFRESH_MS);
})();
