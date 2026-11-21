# AGENTS.md

Working rules for any AI agent (Hermes, Codex, Claude Code, etc.) editing this repo.
`README.md` is the human tour of what the board is and how it looks — read it for
context, but the rules below are the ones that cost real time when broken.

## What this is, in one paragraph

Static HTML/CSS/JS newsroom dashboard for Chattanooga / Hamilton County, served from
GitHub Pages. There is **no server and no build step**. A GitHub Actions workflow pulls
the county 9-1-1 feed and local news every five minutes, commits the result as JSON to
`data/`, and deploys the site. The browser only ever fetches same-origin JSON.

## Golden rules

1. **Never hand-edit `data/calls.json`, `data/news.json`, or `data/counts.json`.** They are
   generated. The refresh Action commits over them every five minutes, so a manual edit is
   silently clobbered — and if it lands first, the next run rebases on top of it.
2. **Every timestamp goes through `to_utc()`** in `scripts/fetch_data.py`. The hc911 API
   stamps Eastern *local* time and appends a `Z` as if it were UTC; trusting it makes
   every row render five hours stale. Any new timestamp field must be normalized the
   same way.
3. **The 9-1-1 fetch stays server-side.** That feed requires `X-Frontend-Auth` and only
   allows preflights from `hamiltontn911.gov`, so a browser on Pages is blocked twice
   over. Don't move fetching into `assets/app.js`.
4. **`refresh.yml` deploys Pages from a separate `deploy` job.** Do not collapse it back
   into a step after the upload: the artifacts API is sometimes not indexed ~0.3 s after
   upload and the run dies with `Found 0 artifact(s)` (actions/deploy-pages#451), leaving
   Pages on the previous build. Same-job deploys failed intermittently on 2026-11-21.
5. **Never commit secrets.** `GH_TOKEN` and `CLOUDFLARE_API_TOKEN` are GitHub/Cloudflare
   secrets and Worker secrets. Nothing in the repo, nothing in `data/`.
6. **No frameworks, no bundler, no npm at the site root.** Vanilla JS and CSS variables
   only; the only `package.json` is `deploy/package.json` for wrangler. Keep the page
   loading from static files.

## How a refresh actually happens

```
Cloudflare Worker (hc911-cron.sanchez-stroud.workers.dev, cron */5 UTC)
  └─ POST workflow_dispatch -> refresh.yml on main
       ├─ job build:  fetch_data.py --out data  ->  commit data  ->  upload-pages-artifact
       └─ job deploy: actions/deploy-pages  (separate job, see rule 4)
```

The Worker exists because **GitHub's own `*/5` schedule for this repo effectively never
fires** (0 scheduled runs in 74 minutes, measured). Don't "fix" the refresh by relying on
the `on: schedule:` trigger; the external clock is the mechanism. The workflow keeps its
schedule block as a fallback.

The Worker never touches data or Pages — it only dispatches, so the whole refresh+deploy
path stays in one place. `deploy-worker.yml` redeploys the Worker on push when
`deploy/` changes; it **skips with a warning** when `CLOUDFLARE_API_TOKEN` is unset rather
than failing, so a green run does not prove the Worker was deployed — read the log.

## Local dev

```bash
python3 scripts/fetch_data.py --out data     # populate data/*.json
python3 -m http.server 8000                  # then open http://127.0.0.1:8000
```

No installs needed: `fetch_data.py` is stdlib-only (`urllib`, `zoneinfo`, `argparse`).

## Verifying a change (do this before saying it works)

- **The feed, not the status code.** These gateways answer refusals with HTTP **200** and
  a body like `{"message":"Forbidden: ..."}`, so check the payload shape, not `200`.
- **The live site, not the repo.** `curl -s https://radiorussell.github.io/hc911-dashboard/data/counts.json`
  and confirm the `updated` field is recent.
- **The Action, not the push.** `gh run list --repo radiorussell/hc911-dashboard --limit 3`
  — a successful push says nothing about a successful deploy.
- **After editing `assets/*.js` or the HTML**, reload with a hard refresh; Pages caches
  aggressively and a stale `app.js` looks like a broken edit.

## Domain quirks worth knowing before debugging

- **HC911's own daily total is broken upstream** (`/api/count` returns a hard `0`). The
  board counts the day itself from sequence numbers (`2026-29665`) minus a pre-midnight
  baseline persisted in `data/counts.json`. Expect `—` right after midnight until an
  anchor exists; that's correct behavior, not a bug.
- **`calls.json` is grouped by `master_incident_id`.** Dispatch sends one row per agency
  and unit, so a single house fire arrives as several rows. Don't paginate or count rows
  as incidents.
- **Broadcastify embeds are dead** (deprecated 2025 for third-party feeds). The page links
  out instead of iframing; `STREAM_URL` in `assets/app.js` is the hook for a native
  `<audio>` player once a mount you control exists. Do not relay their mount — it breaks
  their terms.
- **News ordering** is by timestamp after `to_utc()` normalization; RSS sources disagree
  about zones, so never sort on the raw string.
- **Incident flags:** `NOTABLE_PATTERNS` / `QUIET_PATTERNS` in `fetch_data.py` decide the
  amber "watch" badge. Automatic fire alarms, non-injury crashes and civil matters are
  deliberately quiet — don't "improve" that without asking.

## House style

- Dark newsroom theme; colors live as CSS variables at the top of `assets/style.css`.
  Reuse them, don't hardcode hex in JS.
- Editorial caution is a feature: dispatch text is a caller's words, not a verified fact.
  Never render copy that implies an agency endorsement or asserts an injury from a call
  type.
- Commit style: `data: refresh <ISO8601>` for generated data (the bot does this),
  `ci:`, `fix:`, `docs:` for everything else.
