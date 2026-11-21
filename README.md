# Hamilton County Ops Board

A single-page newsroom dashboard for Chattanooga / Hamilton County: active 9-1-1
incidents, a rolling local-news feed, and the county public-safety scanner.

Static HTML/CSS/JS on GitHub Pages. There is no server: a GitHub Actions job
pulls the data every five minutes and commits it as JSON, and the page reads
those files from its own origin.

## What's on the board

| Panel | Source | Refresh |
| --- | --- | --- |
| Active incidents | `https://hc911server.com/api/calls` (Hamilton County 9-1-1 feed) | 5 min (Action) + 60 s page poll |
| Local news | Chattanooga Times Free Press RSS + Google News RSS queries for WDEF / Local 3 / NewsChannel 9 / Chattanoogan / Nooga | 5 min |
| Scanner | Broadcastify feed 44571 — *Hamilton County Public Safety* (law dispatch), embedded player | live |
| Radar + weather (`weather.html`) | RainViewer radar loop, NWS active alerts, Open-Meteo conditions for 8 DMA cities | 5–10 min |

## Why the data is fetched by the Action and not the browser

The 9-1-1 feed requires the header `X-Frontend-Auth: my-secure-token` and only
answers preflights from `https://www.hamiltontn911.gov`. A browser on another
domain is blocked twice over. A server-side request sends no `Origin` header and
is accepted — so GitHub Actions does the fetching and the browser only ever
loads same-origin JSON.

Note that these gateways answer refusals with **HTTP 200** and a body like
`{"message":"Forbidden: ..."}`, so `scripts/fetch_data.py` validates the payload,
not the status code.

## Layout

```
index.html              dashboard shell (incidents, news, scanner)
weather.html            radar / alerts / conditions board
assets/style.css        dark newsroom theme
assets/app.js           fetch + render, filters, auto-refresh
assets/weather.css      weather board styles
assets/weather.js       Leaflet radar loop, NWS alerts, Open-Meteo
scripts/fetch_data.py   hc911 + news -> data/*.json
data/calls.json         generated (do not edit)
data/news.json          generated (do not edit)
.github/workflows/refresh.yml   cron 5 min, commits data, deploys Pages
```

`calls.json` is grouped by `master_incident_id`: dispatch sends one row per
agency and unit, so a single house fire arrives as several rows. `units` and
`agencies` show the fan-out.

## Weather board (`weather.html`)

Everything on it is browser-side and key-free, so no Action step is involved:

- **Radar** — RainViewer (`api.rainviewer.com/public/weather-maps.json`) supplies the
  frame list and `tilecache.rainviewer.com` the tiles; the page builds a Leaflet
  tile layer per frame, loops them, and refetches the list every 5 minutes.
  Palette 4 (TWC), 256 px tiles, ~13 frames covering the last two hours, plus
  RainViewer's nowcast frames when they exist (labelled *forecast*).
- **Alerts** — `api.weather.gov/alerts/active?area=TN,GA,AL`, filtered to the DMA
  county list in `assets/weather.js` (`DMA_COUNTIES`). Zone-based alerts carry no
  geometry, so the page pulls the `affectedZones` polygons (cached per session) and
  draws those, coloured by severity. Click a polygon or a sidebar row to zoom.
- **Conditions** — Open-Meteo current observations for eight DMA cities, refreshed
  every 10 minutes.
- **DMA bounds** — `DMA_BOUNDS` in `assets/weather.js`; widen it if your county
  list grows.

All three APIs send `Access-Control-Allow-Origin: *`, which is why this page can
skip the proxy the 9-1-1 feed needs.

## Tuning the incident flags

`scripts/fetch_data.py` marks rows `notable` (amber "watch" badge, and the
**Notable** filter) using `NOTABLE_PATTERNS` / `QUIET_PATTERNS`. Edit those lists
to change what the board emphasises — automatic fire alarms, non-injury crashes
and civil matters are deliberately quiet.

## Run it locally

```bash
python3 scripts/fetch_data.py --out data
python3 -m http.server 8000
# open http://127.0.0.1:8000
```

## Setup on GitHub

1. Push this repo.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Run the *Refresh feed and deploy* workflow once by hand (Actions → Run workflow)
   so `data/` is populated before the first scheduled run.
4. Scheduled workflows are best-effort: GitHub often delays them, so expect a
   5–15 minute lag instead of exactly five. Pull requests are the fastest way to
   shorten that — or move the fetch to a Cloudflare Worker cron if one minute
   matters.

## Caveats

- Dispatch text is a caller's or dispatcher's words, not a verified fact. A call
  type of "MVC Injuries" does not mean anyone was hurt.
- The scanner is Broadcastify's own player and audio, embedded (the raw MP3
  endpoints reject anonymous requests). Leave the player to Broadcastify; do not
  re-host or record the audio.
- Incident data is public record. Keep the source link and don't imply agency
  endorsement.
- `data/` commits every five minutes, so the repo history grows. That is
  intentional and cheap; prune occasionally if it bothers you.
- **The hc911 API stamps Eastern local time but appends a `Z`**, as if it were
  UTC. Trusting the `Z` makes every row look five hours stale (a call dispatched
  a minute ago renders as "5 hours ago"). `to_utc()` in `scripts/fetch_data.py`
  strips the bogus zone, reads the value as `America/New_York`, and emits a real
  UTC instant — keep any new timestamp field going through it.
