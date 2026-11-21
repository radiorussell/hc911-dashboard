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
import html
import json
import os
import re
import sys
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


def fetch_calls() -> tuple[list[dict], dict]:
    raw = http_get(CALLS_URL, HC911_HEADERS)
    data = json.loads(raw)
    if isinstance(data, dict):  # {"message": "Forbidden: ..."} arrives as HTTP 200
        raise RuntimeError(f"hc911 feed refused: {data.get('message', data)}")
    if not isinstance(data, list):
        raise RuntimeError("hc911 feed returned unexpected payload")
    return data, {"fetched": len(data)}


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

    print(f"{now}  incidents={len(incidents)} (rows={meta['fetched']})  news={len(news)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
