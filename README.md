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
index.html              dashboard shell
assets/style.css        dark newsroom theme
assets/app.js           fetch + render, filters, auto-refresh
scripts/fetch_data.py   hc911 + news -> data/*.json
data/calls.json         generated (do not edit)
data/news.json          generated (do not edit)
.github/workflows/refresh.yml   cron 5 min, commits data, deploys Pages
```

`calls.json` is grouped by `master_incident_id`: dispatch sends one row per
agency and unit, so a single house fire arrives as several rows. `units` and
`agencies` show the fan-out.

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
