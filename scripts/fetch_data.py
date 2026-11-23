#!/usr/bin/env python3
"""Pull Hamilton County 9-1-1 active incidents + local news into static JSON.

Runs server-side (GitHub Actions or anywhere), so no CORS problem:
the hc911 feed rejects browser origins other than its own site but accepts
a request that sends no Origin header at all.

Usage:
    python scripts/fetch_data.py --out data
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import html
import json
import math
import os
import re
import sys
import time as _time
import urllib.error
import urllib.request
from datetime import datetime, time, timedelta, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")


def to_utc(local_stamp: str | None) -> str | None:
    """hc911 stamps LOCAL Eastern time but appends a 'Z' as if it were UTC.

    Verified against a live pull: a status change seconds old arrived as
    '22:39:43.000Z' while the wall clock in Chattanooga read 22:40 EST — five
    hours ahead of real UTC. Trusting the Z makes every row render five hours
    stale ("5 hours ago" on a call dispatched a minute ago), so strip the
    bogus zone, read the value as Eastern, and emit a real UTC instant.
    """
    if not local_stamp:
        return None
    try:
        dt = datetime.fromisoformat(str(local_stamp).replace("Z", "+00:00"))
    except ValueError:
        return local_stamp
    naive = dt.replace(tzinfo=None)
    return (
        naive.replace(tzinfo=EASTERN)
        .astimezone(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )

CALLS_URL = "https://hc911server.com/api/calls"
COUNT_URL = "https://hc911server.com/api/count"
HC911_HEADERS = {
    "X-Frontend-Auth": "my-secure-token",
    "User-Agent": "hc911-dashboard/1.0 (+newsroom dashboard)",
    "Accept": "application/json",
}
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"

# Local news feeds that answer a server-side request.
NEWS_FEEDS = [
    ("Chattanooga Times Free Press", "https://www.timesfreepress.com/feed/"),
    (
        "Google News",
        "https://news.google.com/rss/search?q=Chattanooga+OR+%22Hamilton+County%22+TN+when:1d&hl=en-US&gl=US&ceid=US:en",
    ),
    (
        "Google News",
        "https://news.google.com/rss/search?q=site:wdef.com+OR+site:local3news.com+OR+site:newschannel9.com+OR+site:nooga.com+OR+site:chattanoogan.com+when:2d&hl=en-US&gl=US&ceid=US:en",
    ),
]

# Headlines that are syndicated tag/archive pages, betting spam or obituaries feed
# noise rather than anything a newsroom would pick up.
NEWS_DROP = [
    r"archives? -", r"^\s*archives", r"predictions?", r"\bpicks\b", r"\bodds\b",
    r"betting", r"\bsportsbook\b", r"today'?s (college|nba|nfl|mlb)",
    r"\bstock\b", r"\bcrypto\b", r"\bcasino\b", r"\bprize\b", r"\bgiveaway\b",
    r"varsity", r"nfhs", r"live & on demand", r"high school (basketball|football) live",
]
# Aggregator noise: sources that only repackage other people's copy.
NEWS_DROP_SOURCES = [r"^wisevoter$", r"^pickdawgz$", r"^yahoo", r"^msn$", r"^flipboard$"]

# Dispatch call types that are worth a reporter's attention. Everything else is
# still shown in the table, just not flagged.
NOTABLE_PATTERNS = [
    r"fire",            # structure / apartment / residential / commercial fires
    r"shoot", r"stab", r"shot",
    r"entrap", r"extricat",
    r"hazmat", r"hazardous",
    r"missing", r"endangered",
    r"bomb", r"explos",
    r"mvc injur", r"vehicle crash injur",
    r"road closure",
    r"assault", r"robber", r"carjack",
    r"drown", r"water rescue",
]
# Automatic alarms and routine traffic are noise on a newsroom board.
QUIET_PATTERNS = [r"^afa ", r"mvc no injur", r"mvc delayed", r"extra job", r"civil matter"]

STATUS_ORDER = ["Queued", "Enroute", "On Scene", "Transporting", "At Hospital"]


def http_get(url: str, headers: dict | None = None, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# The county gateway is flaky: 504s, silent ~30 s stalls, and errors that come
# back as HTTP 200 with a {"message": ...} body. A single bad attempt used to
# fail the whole five-minute refresh cycle and leave the board on stale data, so
# transient failures are retried instead of raised.
#
# Measured 2026-11-21 16:20-16:30Z, four requests 15 s apart: three returned
# `{"message":"Internal Server Error"}` after 15-21 s and one returned 10 KB of
# real calls in 4 s. Roughly one success in four, so three attempts is not
# enough — the loop runs to a wall-clock deadline instead, spaced to avoid
# hammering a gateway that is clearly already unhappy.
CALLS_ATTEMPTS = 6
CALLS_DEADLINE = 100            # total seconds of retrying before giving up
CALLS_BACKOFF = (2, 3, 5, 5, 8)  # sleep before attempt 2..6
CALL_TIMEOUT = 25               # per attempt


def _refusal_text(data) -> str:
    if isinstance(data, dict):
        return str(data.get("message", data))
    return str(data)[:120]


def fetch_calls(attempts: int = CALLS_ATTEMPTS,
                deadline: float = CALLS_DEADLINE) -> tuple[list[dict], dict]:
    last: Exception | None = None
    started = _time.monotonic()
    for n in range(attempts):
        try:
            raw = http_get(CALLS_URL, HC911_HEADERS, timeout=CALL_TIMEOUT)
            data = json.loads(raw)
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            # URLError covers 504/503 and connection resets; ValueError covers a
            # truncated body or an HTML error page.
            last = exc
        else:
            if isinstance(data, list):
                if n:
                    print(f"hc911 feed recovered on attempt {n + 1} "
                          f"after {_time.monotonic() - started:.0f}s", file=sys.stderr)
                return data, {"fetched": len(data)}
            # HTTP 200 with {"message": "Forbidden: ..."} or a gateway error page.
            # A refusal is permanent (bad header/UA) — everything else, including
            # "Internal Server Error" and "Endpoint request timed out", is the
            # gateway being flaky and is worth another attempt.
            text = _refusal_text(data)
            last = RuntimeError(f"hc911 feed refused: {text}")
            if any(k in text.lower() for k in ("forbidden", "unauthori", "invalid auth")):
                break
        if n + 1 < attempts:
            pause = CALLS_BACKOFF[min(n, len(CALLS_BACKOFF) - 1)]
            if _time.monotonic() - started + pause > deadline:
                break
            _time.sleep(pause)
    raise last if last is not None else RuntimeError("hc911 feed unavailable")


def fetch_counts() -> dict:
    """Upstream YTD total, plus a daily total we compute ourselves.

    The county's /api/count endpoint returns [[{"":<yearTotal>}],[{"":<dayTotal>}]],
    and the second value has been stuck on 0 — HC911's own homepage renders that
    same 0 in its "Daily Total Incidents" slot, so the break is upstream, not
    here. The year total is live, so keep it and derive the day ourselves from
    the per-incident sequence numbers on the live call feed (dense, monotonic:
    "2026-29665" is the 29,665th incident of the year) against a baseline we
    persist across runs in data/counts.json.
    """
    try:
        data = json.loads(http_get(COUNT_URL, {"User-Agent": UA}))
        year = next(iter(data[0][0].values()))
        upstream_day = next(iter(data[1][0].values()))
    except Exception as e:  # counters are cosmetic
        print(f"warn: counters unavailable ({e})", file=sys.stderr)
        year, upstream_day = None, None
    return {"year": year, "upstream_day": upstream_day}


def seq_number(row: dict) -> int | None:
    tail = str(row.get("sequencenumber") or "").rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else None


def day_counter(rows: list[dict], out_dir: str) -> dict:
    """Incidents since local midnight, counted from the sequence numbers.

    Sequence numbers are dense and monotonic per incident, so the highest one
    now minus the highest one dispatched before midnight is the day's count —
    it survives calls clearing off the active list. The pre-midnight anchor is
    only trusted when it is close to midnight (a stale road closure from this
    morning would skew the total), so early in the day the value is withheld
    rather than shown wrong. Baseline is persisted in data/counts.json and
    committed by the workflow, which keeps it stable across runs.
    """
    now = datetime.now(timezone.utc)
    today = now.astimezone(EASTERN).date()
    midnight = datetime.combine(today, time(0, 0), tzinfo=EASTERN).astimezone(timezone.utc)

    state_path = os.path.join(out_dir, "counts.json")
    state: dict = {}
    if os.path.exists(state_path):
        try:
            with open(state_path, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            state = {}

    stamped: list[tuple[datetime, int]] = []
    for r in rows:
        seq = seq_number(r)
        when = to_utc(r.get("creation"))
        if seq is None or not when:
            continue
        stamped.append((datetime.fromisoformat(when.replace("Z", "+00:00")), seq))

    today_seqs = [s for dt, s in stamped if dt >= midnight]
    before = [(dt, s) for dt, s in stamped if dt < midnight]

    base = state.get("seq_base") if state.get("local_day") == today.isoformat() else None
    basis = state.get("day_basis") if base is not None else None

    if base is None:
        anchor = max(before, default=None)
        if anchor and (midnight - anchor[0]) <= timedelta(hours=2):
            base, basis = anchor[1], "midnight"
        elif today_seqs:
            base, basis = min(today_seqs) - 1, "bootstrap"
        else:
            base, basis = None, "unknown"

    if base is None:
        day = None
    elif today_seqs:
        day = max(0, max(today_seqs) - base)
    else:
        day = 0

    out = {
        "updated": now.isoformat(timespec="seconds"),
        "local_day": today.isoformat(),
        "seq_base": base,
        "day": day,
        "day_basis": basis,
    }
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return out


def is_notable(call_type: str) -> bool:
    t = (call_type or "").lower()
    if any(re.search(p, t) for p in QUIET_PATTERNS):
        return False
    return any(re.search(p, t) for p in NOTABLE_PATTERNS)


def status_rank(s: str) -> int:
    try:
        return STATUS_ORDER.index(s)
    except ValueError:
        return -1


def group_incidents(rows: list[dict]) -> list[dict]:
    """Collapse unit/agency rows into one record per master incident."""
    groups: dict[str, list[dict]] = {}
    for row in rows:
        key = str(row.get("master_incident_id") or row.get("id"))
        groups.setdefault(key, []).append(row)

    incidents = []
    for key, group in groups.items():
        group.sort(key=lambda r: status_rank(r.get("status", "")), reverse=True)
        lead = group[0]
        earliest = min(group, key=lambda r: r.get("creation") or "")
        incidents.append(
            {
                "id": key,
                "sequence": earliest.get("sequencenumber") or lead.get("sequencenumber"),
                "type": lead.get("type_description") or lead.get("type") or "",
                "status": lead.get("status") or "",
                "status_at": None
                if str(lead.get("statusdatetime", "")).startswith("1900")
                else to_utc(lead.get("statusdatetime")),
                "created": to_utc(earliest.get("creation")),
                "jurisdiction": lead.get("jurisdiction") or "",
                "agencies": sorted({r.get("jurisdiction") or "" for r in group if r.get("jurisdiction")}),
                "agency_type": lead.get("agency_type") or "",
                "agency_types": sorted({r.get("agency_type") or "" for r in group if r.get("agency_type")}),
                "address": lead.get("location") or lead.get("premise") or "",
                "cross": lead.get("crossstreets") or "",
                "city": lead.get("city") or "",
                "zone": lead.get("zone") or "",
                "priority": lead.get("priority") or "",
                "lat": lead.get("latitude"),
                "lon": lead.get("longitude"),
                "units": len(group),
                "stacked": any(bool(r.get("stacked")) for r in group),
                "notable": is_notable(lead.get("type_description") or lead.get("type") or ""),
            }
        )
    incidents.sort(key=lambda i: i.get("created") or "", reverse=True)
    return incidents


def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


# Times Free Press tags everything, so use categories to keep the local news and
# drop cartoons/opinion/box scores instead of shipping the whole paper.
TFP_KEEP = {"local", "local news", "news", "chattanooga", "tennessee", "hamilton county", "crime", "courts", "government", "education", "business"}
TFP_DROP = {"cartoons", "free press cartoons", "opinion", "columnists", "sports", "football", "college", "prep", "nfl", "nba", "mlb", "nascar", "golf", "obituaries"}


def parse_feed(source: str, url: str) -> list[dict]:
    try:
        root = ET.fromstring(http_get(url))
    except Exception as e:
        print(f"warn: feed failed {url} ({e})", file=sys.stderr)
        return []
    items = []
    for item in root.iter("item"):
        title = strip_html(item.findtext("title") or "")
        if not title:
            continue
        if any(re.search(p, title.lower()) for p in NEWS_DROP):
            continue
        cats = {(c.text or "").strip().lower() for c in item.findall("category") if c.text}
        if source.startswith("Chattanooga Times") and cats:
            if not (cats & TFP_KEEP):
                continue
            if cats & TFP_DROP and len(cats & TFP_KEEP) < 2:
                continue
        # Google News appends " - Publisher"; promote that to the source label.
        outlet = source
        if source == "Google News" and " - " in title:
            head, tail = title.rsplit(" - ", 1)
            if 2 < len(tail) < 40:
                title, outlet = head.strip(), tail.strip()
        published = None
        raw_date = item.findtext("pubDate") or ""
        if raw_date:
            try:
                published = parsedate_to_datetime(raw_date).astimezone(timezone.utc)
            except Exception:
                published = None
        if any(re.search(p, outlet.lower()) for p in NEWS_DROP_SOURCES):
            continue
        items.append(
            {
                "title": title,
                "link": (item.findtext("link") or "").strip(),
                "source": outlet,
                "published": published.isoformat() if published else None,
                "summary": strip_html(item.findtext("description") or "")[:280],
            }
        )
    return items


def fetch_news() -> list[dict]:
    seen: dict[str, dict] = {}
    for source, url in NEWS_FEEDS:
        for item in parse_feed(source, url):
            key = re.sub(r"[^a-z0-9]+", "", item["title"].lower())[:90]
            if not key:
                continue
            prior = seen.get(key)
            if prior is None or (item.get("published") or "") > (prior.get("published") or ""):
                seen[key] = item
    items = list(seen.values())
    items.sort(key=lambda i: i.get("published") or "", reverse=True)
    return items[:80]


# --------------------------------------------------------------------------
# TDOT SmartWay traffic (data/traffic.json) — powers traffic.html and the board's
# congestion minimap. The SmartWay SPA ships its API base and a public static app
# key in a runtime config, so read the config each run instead of hardcoding the
# key: TDOT can rotate it and a stale constant would silently 401 every refresh.
# Every endpoint returns the whole statewide snapshot (no bbox/region parameter),
# so filtering to Hamilton County + a 35-mile box happens here.
# --------------------------------------------------------------------------
TDOT_CONFIG_URL = "https://smartway.tn.gov/config/config.prod.json"
TDOT_API_BASE = "https://www.tdot.tn.gov/opendata/api/public/"
TDOT_TRAFFIC_ENDPOINTS = [
    "RoadwayIncidents",
    "RoadwayOperations",
    "RoadwaySpecialEvents",
    "RoadwaySevereImpact",
]
TDOT_WAZE_URL = (
    "https://spatial.tdot.tn.gov/ArcGIS/rest/services/WAZE/Waze_Smartway/MapServer/0/query"
    "?where=1%3D1&geometry={bbox}&geometryType=esriGeometryEnvelope&inSR=4326"
    "&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=geojson"
)
# GDOT publishes its whole CCTV inventory as a public ArcGIS layer (no key, CORS-open).
# Georgia counties are the ones the weather board already counts as the Chattanooga DMA.
GDOT_CAMERAS_URL = (
    "https://enterprisegis.dot.ga.gov/hosting/rest/services/web_trafficcameras/MapServer/0/query"
    "?where=COUNTY_NAME+IN+({counties})&outFields=OBJECTID,DEVICE_NAME,ACTIVE,PRIMARY_ROAD,"
    "CROSS_ROAD_NAME,DIRECTION,COUNTY_NAME,URL,LATITUDE,LONGITUDE"
    "&returnGeometry=true&outSR=4326&f=geojson"
)
GDOT_DMA_COUNTIES = ["Catoosa", "Walker", "Dade", "Whitfield", "Murray", "Chattooga", "Gordon"]

# Both vendors serve the same grey "STREAM NOT AVAILABLE" PNG when an encoder is down.
# It is byte-identical between them (md5 a2f0687d…), which makes a HEAD + Content-Length
# check enough to hide dead nodes. A full sweep is ~250 requests, so the result is cached
# in data/camera-health.json and refreshed a few times a day, not on every 5-minute run.
CAMERA_PLACEHOLDER_BYTES = 21107
CAMERA_HEALTH_HOURS = 6

TDOT_CENTER = (35.0456, -85.3097)          # downtown Chattanooga
TDOT_RADIUS_MI = 35                        # keeps I-24/I-75 approaches in frame
TDOT_BBOX = (-85.70, 34.78, -84.72, 35.42)  # W, S, E, N for signs + Waze
TDOT_COUNTIES = {"Hamilton"}
TDOT_TIMEOUT = 30


def tdot_get(url: str, headers: dict | None = None):
    """GET JSON from TDOT. Two attempts: this feed is reliable, but a refresh cycle
    must never die over it — callers wrap the whole build in try/except anyway."""
    last: Exception | None = None
    for n in range(2):
        try:
            raw = http_get(url, {"User-Agent": UA, "Accept": "application/json", **(headers or {})},
                           timeout=TDOT_TIMEOUT)
            return json.loads(raw) if raw else None   # 204 (nothing active) yields b""
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            last = exc
            if n == 0:
                _time.sleep(2)
    raise last if last is not None else RuntimeError(f"no response from {url}")


def tdot_to_utc(stamp):
    """TDOT timestamps carry a real offset but 7 fractional digits; ArcGIS Waze
    dates arrive as epoch milliseconds. Emit a UTC 'Z' stamp like everything else."""
    if not stamp:
        return None
    if isinstance(stamp, (int, float)):
        return (datetime.fromtimestamp(stamp / 1000, timezone.utc)
                .isoformat(timespec="seconds").replace("+00:00", "Z"))
    try:
        return (datetime.fromisoformat(str(stamp)).astimezone(timezone.utc)
                .isoformat(timespec="seconds").replace("+00:00", "Z"))
    except ValueError:
        return None


def tdot_miles(lat: float, lng: float) -> float:
    return math.hypot((lat - TDOT_CENTER[0]) * 69.0,
                      (lng - TDOT_CENTER[1]) * 69.0 * math.cos(math.radians(TDOT_CENTER[0])))


def _tdot_keep(ev: dict) -> bool:
    for loc in ev.get("locations") or []:
        if loc.get("countyName") in TDOT_COUNTIES:
            return True
        point = loc.get("midPoint") or (loc.get("coordinates") or [{}])[0]
        if point.get("lat") is not None and tdot_miles(point["lat"], point["lng"]) <= TDOT_RADIUS_MI:
            return True
    return False


def _tdot_event(ev: dict) -> dict:
    locs = ev.get("locations") or []
    mid = next((l.get("midPoint") for l in locs if l.get("midPoint")), None)
    lines = [rl for l in locs for rl in (l.get("routeLine") or []) if len(rl) > 1]
    return {
        "id": ev.get("id"),
        "kind": ev.get("eventTypeName"),
        "subtype": ev.get("eventSubTypeDescription") or ev.get("eventTypeName"),
        "status": ev.get("status"),
        "desc": ev.get("description"),
        "direction": ev.get("directionDescription"),
        "impact": ev.get("impactDescription"),
        "closure": bool(ev.get("hasClosure")),
        "severe": bool(ev.get("isSevere")),
        "thp": bool(ev.get("thpReported")),
        "began": tdot_to_utc(ev.get("beginningDate")),
        "revised": tdot_to_utc(ev.get("revisedDate")),
        "county": locs[0].get("countyName") if locs else None,
        "lat": mid.get("lat") if mid else None,
        "lng": mid.get("lng") if mid else None,
        "lines": [[[p["lat"], p["lng"]] for p in seg if p.get("lat") is not None] for seg in lines][:4],
    }


def fetch_gdot_cameras() -> list[dict]:
    """GDOT CCTV nodes for the Georgia side of the DMA — snapshots only; the live
    HLS streams sit behind 511GA's developer key."""
    where = ",".join(f"'{c}'" for c in GDOT_DMA_COUNTIES)
    payload = tdot_get(GDOT_CAMERAS_URL.format(counties=where)) or {}
    cams = []
    for feat in payload.get("features", []):
        prop = feat.get("properties") or {}
        coords = (feat.get("geometry") or {}).get("coordinates") or [None, None]
        lat = prop.get("LATITUDE") or coords[1]
        lng = prop.get("LONGITUDE") or coords[0]
        if lat is None or lng is None:
            continue
        name = (prop.get("DEVICE_NAME") or "").strip()
        road = (prop.get("PRIMARY_ROAD") or "").strip()
        cross = (prop.get("CROSS_ROAD_NAME") or "").strip()
        title = name or (f"{road} @ {cross}" if cross else f"{road} ({prop.get('COUNTY_NAME')})")
        cams.append({
            "id": f"ga-{prop.get('OBJECTID')}",
            "title": title or "GDOT camera",
            "route": road or None,
            "mm": None,
            "jur": prop.get("COUNTY_NAME"),
            "lat": lat,
            "lng": lng,
            "active": bool(prop.get("ACTIVE")),
            "thumb": prop.get("URL"),
            "hls": None,
            "src": "GDOT",
        })
    return [c for c in cams if c["thumb"]]


def camera_health(cameras: list[dict], out_dir: str) -> set[str]:
    """Ids of cameras whose snapshot is the shared placeholder image.

    Cached in data/camera-health.json: the sweep is ~250 HEAD requests, far too much to
    repeat every five minutes, but a camera that dies mid-window simply shows the
    placeholder until the next sweep, which the UI already tolerates.
    """
    path = os.path.join(out_dir, "camera-health.json")
    state = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            state = {}
    try:
        checked = datetime.fromisoformat(str(state.get("updated")).replace("Z", "+00:00"))
    except ValueError:
        checked = None
    fresh = checked and (datetime.now(timezone.utc) - checked) < timedelta(hours=CAMERA_HEALTH_HOURS)
    if fresh:
        return set(state.get("dead") or [])

    def size(cam):
        try:
            req = urllib.request.Request(cam["thumb"], method="HEAD",
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                return int(r.headers.get("Content-Length") or 0)
        except Exception:
            return None

    with futures.ThreadPoolExecutor(max_workers=8) as pool:
        sizes = list(pool.map(size, cameras))

    dead = sorted(c["id"] for c, n in zip(cameras, sizes) if n == CAMERA_PLACEHOLDER_BYTES)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                   "checked": len(cameras), "dead": dead}, f, indent=1)
    print(f"camera health: {len(dead)} of {len(cameras)} serving the placeholder", file=sys.stderr)
    return set(dead)


def fetch_traffic(out_dir: str = "data") -> dict:
    """Hamilton County traffic snapshot: events, cameras, message signs, Waze jams."""
    config = tdot_get(TDOT_CONFIG_URL) or {}
    key = config.get("apiKey")
    if not key:
        raise RuntimeError("SmartWay config carried no apiKey")
    headers = {"X-API-Key": key}

    events: dict = {}
    for endpoint in TDOT_TRAFFIC_ENDPOINTS:
        try:
            rows = tdot_get(TDOT_API_BASE + endpoint, headers) or []
        except Exception as e:
            print(f"warn: tdot {endpoint} unavailable ({e})", file=sys.stderr)
            continue
        for ev in rows:
            if not _tdot_keep(ev):
                continue
            item = _tdot_event(ev)
            prior = events.get(item["id"])
            if prior is None or (item["severe"] and not prior["severe"]):
                events[item["id"]] = item

    cameras = []
    for cam in tdot_get(TDOT_API_BASE + "RoadwayCameras", headers) or []:
        lat, lng = cam.get("lat"), cam.get("lng")
        if lat is None or tdot_miles(lat, lng) > TDOT_RADIUS_MI:
            continue
        cameras.append({
            "id": cam.get("id"),
            "title": cam.get("title"),
            "route": cam.get("route"),
            "mm": cam.get("mileMarker"),
            "jur": cam.get("jurisdiction"),
            "lat": lat,
            "lng": lng,
            "active": str(cam.get("active")).lower() == "true",
            "thumb": cam.get("thumbnailUrl"),
            "hls": cam.get("httpsVideoUrl") or cam.get("httpVideoUrl"),
            "src": "TDOT",
        })
    cameras.sort(key=lambda c: (c["route"] or "", float(c["mm"] or 0)))

    try:
        gdot = fetch_gdot_cameras()
        print(f"  gdot cameras in DMA counties: {len(gdot)}", file=sys.stderr)
        cameras.extend(gdot)
    except Exception as e:
        print(f"warn: gdot cameras unavailable ({e})", file=sys.stderr)

    hidden = camera_health(cameras, out_dir)
    if hidden:
        before = len(cameras)
        cameras = [c for c in cameras if c["id"] not in hidden]
        print(f"  hid {before - len(cameras)} dead cameras", file=sys.stderr)

    signs = []
    for sign in tdot_get(TDOT_API_BASE + "RoadwayMessageSigns", headers) or []:
        coords = (sign.get("location") or {}).get("coordinates") or []
        if not coords:
            continue
        point = coords[0]
        if not (TDOT_BBOX[1] <= point.get("lat", 0) <= TDOT_BBOX[3]
                and TDOT_BBOX[0] <= point.get("lng", 0) <= TDOT_BBOX[2]):
            continue
        signs.append({"id": sign.get("id"), "title": sign.get("title"), "msg": sign.get("message"),
                      "lat": point["lat"], "lng": point["lng"]})

    waze = []
    try:
        payload = tdot_get(TDOT_WAZE_URL.format(bbox=",".join(str(v) for v in TDOT_BBOX))) or {}
        for feature in payload.get("features", []):
            geometry = feature.get("geometry") or {}
            if geometry.get("type") != "Point":
                continue
            props = feature["properties"]
            waze.append({
                "type": props.get("TYPE"), "sub": props.get("SUBTYPE"),
                "street": props.get("STREET"), "city": props.get("CITY"),
                "rating": props.get("REPORT_RATING"),
                "at": tdot_to_utc(props.get("PUBLISH_DATETIME")),
                "lat": geometry["coordinates"][1], "lng": geometry["coordinates"][0],
            })
    except Exception as e:  # the Waze layer is a nice-to-have; never fail the run for it
        print(f"warn: tdot waze layer unavailable ({e})", file=sys.stderr)

    traffic_events = sorted(events.values(),
                            key=lambda e: (not e["closure"], e["revised"] or ""), reverse=True)
    return {
        "source": "TDOT SmartWay",
        "center": {"lat": TDOT_CENTER[0], "lng": TDOT_CENTER[1]},
        "bbox": {"w": TDOT_BBOX[0], "s": TDOT_BBOX[1], "e": TDOT_BBOX[2], "n": TDOT_BBOX[3]},
        "counts": {
            "events": len(traffic_events),
            "closures": sum(1 for e in traffic_events if e["closure"]),
            "cameras": len(cameras),
            "cameras_tdot": sum(1 for c in cameras if c["src"] == "TDOT"),
            "cameras_gdot": sum(1 for c in cameras if c["src"] == "GDOT"),
            "signs": len(signs),
            "waze": len(waze),
        },
        "events": traffic_events,
        "cameras": cameras,
        "signs": signs,
        "waze": waze,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    raw, meta = fetch_calls()
    incidents = group_incidents(raw)
    counts = fetch_counts()
    day = day_counter(raw, args.out)
    counts.update({"day": day["day"], "day_basis": day["day_basis"]})
    news = fetch_news()
    # Traffic is context, not the point of the board: a TDOT outage must not cost us
    # the incidents or the news, so the write is skipped and the last good
    # traffic.json keeps serving.
    try:
        traffic = fetch_traffic(args.out)
        traffic["updated"] = now
        with open(os.path.join(args.out, "traffic.json"), "w", encoding="utf-8") as f:
            json.dump(traffic, f, ensure_ascii=False, separators=(",", ":"))
        traffic_note = f"traffic={traffic['counts']}"
    except Exception as e:
        traffic_note = f"traffic=unavailable ({e})"
        print(f"warn: {traffic_note}", file=sys.stderr)

    with open(os.path.join(args.out, "calls.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "updated": now,
                "counts": counts,
                "raw_rows": meta["fetched"],
                "incidents": incidents,
            },
            f,
            ensure_ascii=False,
            indent=1,
        )
    with open(os.path.join(args.out, "news.json"), "w", encoding="utf-8") as f:
        json.dump({"updated": now, "items": news}, f, ensure_ascii=False, indent=1)

    print(f"{now}  incidents={len(incidents)} (rows={meta['fetched']})  news={len(news)}  {traffic_note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
