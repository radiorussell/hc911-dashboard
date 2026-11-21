// Hamilton County Ops Board — static dashboard.
// Data comes from data/calls.json and data/news.json, which a GitHub Action
// regenerates from the hc911 feed and local RSS. No CORS involved: same origin.

const REFRESH_MS = 60_000;
const SEEN_CALLS = 'hc911.seenCalls';
const SEEN_NEWS = 'hc911.seenNews';
const SCANNER_HIDDEN = 'hc911.scannerHidden';

const state = {
  incidents: [],
  news: [],
  filter: 'all',
  query: '',
  seenCalls: new Set(JSON.parse(localStorage.getItem(SEEN_CALLS) || '[]')),
  seenNews: new Set(JSON.parse(localStorage.getItem(SEEN_NEWS) || '[]')),
};

const $ = (sel) => document.querySelector(sel);

/* ---------------- formatting ---------------- */
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

const statusClass = (s) =>
  ({ Queued: 'queued', Enroute: 'enroute', 'On Scene': 'scene', Transporting: 'transport', 'At Hospital': 'hospital' }[s] || 'queued');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- rendering ---------------- */
function visibleIncidents() {
  const q = state.query.trim().toLowerCase();
  return state.incidents.filter((i) => {
    if (state.filter === 'notable' && !i.notable) return false;
    if (state.filter !== 'all' && state.filter !== 'notable' && !(i.agency_types || []).includes(state.filter)) return false;
    if (!q) return true;
    return [i.type, i.address, i.city, i.zone, i.jurisdiction, i.sequence]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
}

function renderCalls() {
  const rows = visibleIncidents();
  const tbody = $('#calls-table tbody');
  tbody.innerHTML = rows
    .map((i) => {
      const isNew = !state.seenCalls.has(i.id);
      const map = i.lat && i.lon ? `https://maps.google.com/?q=${i.lat},${i.lon}` : '';
      return `<tr class="${i.notable ? 'notable' : ''} ${isNew ? 'is-new' : ''}">
        <td class="time">${clockTime(i.created)}</td>
        <td><span class="pill ${statusClass(i.status)}">${esc(i.status)}</span></td>
        <td class="event">${esc(i.type)}${i.notable ? '<span class="badge">watch</span>' : ''}<span class="units">${i.units > 1 ? i.units + ' units' : ''}</span></td>
        <td class="addr">${esc(i.jurisdiction)}<small>${esc(i.sequence || '')}</small></td>
        <td class="addr">${map ? `<a class="maplink" href="${map}" target="_blank" rel="noopener">${esc(i.address)}</a>` : esc(i.address)}
          <small>${esc(i.cross || '')}</small></td>
        <td class="area">${esc(i.city)}</td>
        <td class="pri">${/PRI 1/.test(i.priority) ? '<span class="p1">P1</span>' : esc((i.priority || '').replace('PRI ', 'P'))}</td>
      </tr>`;
    })
    .join('');
  $('#calls-empty').hidden = rows.length > 0;
  $('#count-incidents').textContent = state.incidents.length;
  for (const id of rows.map((r) => r.id)) state.seenCalls.add(id);
  localStorage.setItem(SEEN_CALLS, JSON.stringify([...state.seenCalls].slice(-800)));
}

function renderNews() {
  $('#news-list').innerHTML = state.news
    .map((n) => {
      const fresh = !state.seenNews.has(n.link);
      return `<li class="news-item ${fresh ? 'fresh' : ''}">
        <a href="${esc(n.link)}" target="_blank" rel="noopener">
          <div class="headline">${esc(n.title)}</div>
          <div class="meta"><span class="src">${esc(n.source)}</span><span>${ago(n.published)}</span></div>
        </a></li>`;
    })
    .join('');
  $('#news-count').textContent = `${state.news.length} headlines`;
  for (const n of state.news) state.seenNews.add(n.link);
  localStorage.setItem(SEEN_NEWS, JSON.stringify([...state.seenNews].slice(-500)));
}

function renderStamp(iso) {
  $('#stamp').textContent = iso ? ago(iso) : 'unknown';
  $('#stamp').title = iso || '';
}

/* ---------------- data ---------------- */
async function load() {
  try {
    const [calls, news] = await Promise.all([
      fetch('data/calls.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
      fetch('data/news.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
    ]);
    state.incidents = calls.incidents || [];
    state.news = news.items || [];
    const dayEl = $('#count-day');
    const dayVal = calls.counts?.day;
    if (typeof dayVal === 'number' && calls.counts?.day_basis === 'midnight') {
      dayEl.textContent = dayVal.toLocaleString();
      dayEl.title = 'Incidents dispatched since local midnight (counted from HC911 sequence numbers)';
    } else {
      // HC911's own daily total is broken upstream — it reads 0 on their
      // homepage too — so show nothing rather than a wrong number.
      dayEl.textContent = '—';
      dayEl.title = "HC911's daily counter reports 0 upstream; this board counts from the next midnight.";
    }
    $('#count-year').textContent = calls.counts?.year ? calls.counts.year.toLocaleString() : '—';
    renderStamp(calls.updated);
    renderCalls();
    renderNews();
  } catch (err) {
    $('#stamp').textContent = 'feed error';
    console.error('load failed', err);
  }
}

/* ---------------- interactions ---------------- */
$('#type-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll('#type-chips .chip').forEach((c) => c.classList.toggle('active', c === btn));
  renderCalls();
});

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value;
  renderCalls();
});

const scannerBody = $('#scanner-body');
const toggle = $('#scanner-toggle');
const setScanner = (hidden) => {
  scannerBody.classList.toggle('collapsed', hidden);
  toggle.textContent = hidden ? 'show' : 'hide';
  toggle.classList.toggle('active', !hidden);
  localStorage.setItem(SCANNER_HIDDEN, String(hidden));
};
setScanner(localStorage.getItem(SCANNER_HIDDEN) === 'true');
toggle.addEventListener('click', () => setScanner(!scannerBody.classList.contains('collapsed')));

// Live audio: Broadcastify retired third-party embeds in 2025 and its web player
// now requires a free account, so nothing playable can be iframed here. When we
// (or a partner feed provider) host an Icecast mount that allows cross-origin
// playback, set it below — the native <audio> element replaces the notice and
// visitors listen with no account, no embed key, no iframe.
const STREAM_URL = '';
if (STREAM_URL) {
  const audio = $('#scanner-audio');
  audio.src = STREAM_URL;
  audio.hidden = false;
  $('#scanner-notice').hidden = true;
}

setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);
$('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });

load();
setInterval(load, REFRESH_MS);
