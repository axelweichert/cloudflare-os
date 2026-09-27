// RoboMon Fleet Dashboard — server side.
//
// Serves a read-only dashboard of the von Busch RoboMon fleet.
// Data is fetched from the RoboMon API (viewer role = no token required).
//
// When the workshop wires the ROBOMON gatekeeper binding into this gadget's env, the
// session methods are called directly (this.env.ROBOMON.getSnapshot() etc.). Until then
// the gadget fetches robomon.vonbusch.app directly as an anonymous viewer.
//
// Runtime bindings:
//   env.ROBOMON  — gatekeeper session (RoboMonSession), optional; falls back to direct HTTP
//   env.GADGET_DO — the Gadget DurableObject namespace

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const ROBOMON_BASE = "https://robomon.vonbusch.app";
const TIMEOUT_MS = 15_000;

async function fetchRoboMon(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ROBOMON_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Assemble all dashboard sections in parallel.
async function buildDashboard(env) {
  const session = env?.ROBOMON;

  const [snapshot, alerts, tickets, service, automationRes] = await Promise.allSettled([
    session ? session.getSnapshot() : fetchRoboMon("/api/snapshot"),
    session ? session.getAlerts()   : fetchRoboMon("/api/alerts"),
    session ? session.listTickets() : fetchRoboMon("/api/tickets").then(r => r.tickets ?? r),
    session ? session.getServiceStatus() : fetchRoboMon("/api/service"),
    session ? session.listAutomationRules() : fetchRoboMon("/api/automation/rules").then(r => r.rules ?? r),
  ]);

  const get = (r, fallback = null) => r.status === "fulfilled" ? r.value : fallback;
  const err = (r) => r.status === "rejected" ? String(r.reason?.message ?? r.reason) : null;

  const snap = get(snapshot, { robots: [], kpis: {}, customers: [], ts: null });
  const alertData = get(alerts, { summary: null, alerts: [] });
  const ticketData = Array.isArray(get(tickets, [])) ? get(tickets, []) : get(tickets, {}).tickets ?? [];
  const svcData = get(service, { robots: [], intervals: [] });
  const rules = Array.isArray(get(automationRes, [])) ? get(automationRes, []) : [];

  // Surface any fetch errors so the UI can show them.
  const errors = {
    snapshot: err(snapshot),
    alerts: err(alerts),
    tickets: err(tickets),
    service: err(service),
    automation: err(automationRes),
  };

  return {
    ts: Date.now(),
    kpis: snap.kpis ?? {},
    robots: snap.robots ?? [],
    customers: snap.customers ?? [],
    alerts: alertData,
    tickets: ticketData,
    service: svcData,
    automationRules: rules,
    errors,
  };
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async getDashboard() {
    return buildDashboard(this.env);
  }
}

export default class extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const id = this.env.GADGET_DO.idFromName("singleton");
    const stub = this.env.GADGET_DO.get(id);

    if (url.pathname.endsWith("/dashboard")) {
      try {
        const data = await stub.getDashboard();
        return Response.json(data, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (err) {
        return Response.json(
          { error: String(err?.message ?? err) },
          { status: 500 },
        );
      }
    }

    return new Response(SHELL, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

const SHELL = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RoboMon Fleet Dashboard</title></head>
<body><div id="app"></div><script type="module" src="./client.js"></script></body></html>`;
