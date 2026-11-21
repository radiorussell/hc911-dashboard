// hc911-dashboard refresh trigger — Cloudflare Worker on a Cron Trigger.
//
// GitHub's own */5 schedule for this repo never fired (0 scheduled runs in 74
// minutes), so an external clock dispatches the workflow instead. The Worker
// does not touch data or Pages: it only POSTs a workflow_dispatch, so the whole
// refresh+deploy path stays in one place (.github/workflows/refresh.yml).
//
// Setup:
//   1. Secret GH_TOKEN = fine-grained PAT, repo radiorussell/hc911-dashboard,
//      permission "Actions: Read and write" (Metadata read is automatic).
//   2. Cron Trigger: */5 * * * *   (Cloudflare cron is UTC)
//   3. Optional secret ALERT_WEBHOOK = a Discord webhook URL to hear about
//      failures instead of having to open the dashboard.
//
// Verify: GET /            -> JSON summary of the last runs (no dispatch)
//         GET /?run=1      -> dispatch now (skips if a run is already live)
//         GET /?run=1&force=1 -> dispatch even if one is running

const REPO = "radiorussell/hc911-dashboard";
const WORKFLOW = "refresh.yml";
const REF = "main";
const API = "https://api.github.com";
const UA = "hc911-cron-worker/1.0";

async function gh(env, path, init = {}) {
  return fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(init.headers || {}),
    },
  });
}

async function refresh(env, { force = false } = {}) {
  if (!env.GH_TOKEN) return { ok: false, error: "GH_TOKEN secret is not set" };

  const busyRes = await gh(env, `/repos/${REPO}/actions/runs?per_page=5`);
  if (!busyRes.ok) {
    return { ok: false, error: `listing runs failed: GitHub ${busyRes.status}` };
  }
  const { workflow_runs = [] } = await busyRes.json();
  const live = workflow_runs.find((r) => r.status === "queued" || r.status === "in_progress");
  if (live && !force) {
    return { ok: true, dispatched: false, reason: `a run is already ${live.status}`, run: live.html_url };
  }

  const res = await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: REF }),
  });
  if (res.status === 204) return { ok: true, dispatched: true };
  const detail = (await res.text()).slice(0, 300);
  return { ok: false, error: `dispatch failed: GitHub ${res.status} ${detail}` };
}

async function alert(env, message) {
  if (!env.ALERT_WEBHOOK) return;
  await fetch(env.ALERT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  }).catch(() => {});
}

export default {
  async scheduled(controller, env, ctx) {
    const out = await refresh(env);
    console.log("cron", controller.cron, JSON.stringify(out));
    if (!out.ok) {
      ctx.waitUntil(alert(env, `**hc911-dashboard cron failed** — ${out.error}`));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.searchParams.get("run") === "1") {
      const out = await refresh(env, { force: url.searchParams.get("force") === "1" });
      return Response.json(out, { status: out.ok ? 200 : 502 });
    }

    if (!env.GH_TOKEN) {
      return Response.json({ ok: false, error: "GH_TOKEN secret is not set" }, { status: 500 });
    }
    const res = await gh(env, `/repos/${REPO}/actions/runs?per_page=5`);
    if (!res.ok) {
      return Response.json({ ok: false, error: `GitHub ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    return Response.json({
      ok: true,
      worker: "hc911-cron",
      cron: "*/5 * * * * (UTC)",
      repo: REPO,
      site: "https://radiorussell.github.io/hc911-dashboard/",
      recent: (data.workflow_runs || []).map((r) => ({
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        at: r.created_at,
      })),
    });
  },
};
