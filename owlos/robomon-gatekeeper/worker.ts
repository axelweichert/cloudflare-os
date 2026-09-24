// vonBuschOS — Robomon-Gatekeeper Worker (VON-1803 / K6)
//
// Dünner WorkerEntrypoint um RobomonSession. Exponiert die read-only Auth-/Run-
// Health-Observations von von-authmon (VON-1689) als Gadget-Baustein. Rein
// observierend: liest ausschließlich die von-authmon-KV (`AUTHMON_KV`), schreibt
// nie und alarmiert nie.
//
// Bindings (wrangler.jsonc):
//   AUTHMON_KV (KV, read-only)  — von-authmon `STATE`-Namespace (keys: bootAt, hb, alarm)
//
// HTTP (Smoke unter `wrangler dev`; die eigentliche Gadget-Anbindung läuft über die
// RPC-Session bzw. /mcp für Triage-Agenten):
//   GET  /health   → HealthSnapshot
//   GET  /runs     → RunActivityView
//   GET  /token    → TokenObservation | { token: null }
//   GET  /alarm    → { persisted, derivedLevel, derivedKind, detail }
//   GET  /line     → text/plain Ampel-Zeile
//   POST /mcp      → MCP (read-only Tools) für Alarm-Triage-Agenten

import { WorkerEntrypoint } from "cloudflare:workers";
import { RobomonSession, type HealthRepo } from "./session.ts";
import type { AuthmonState } from "./health.ts";
import { handleMcpMessage } from "./mcp-server.ts";

type Env = {
  AUTHMON_KV: KVNamespace;
};

// KV-gestütztes, ausschließlich lesendes Repo. Liest die drei von-authmon-Keys.
class KvHealthRepo implements HealthRepo {
  #kv: KVNamespace;
  constructor(kv: KVNamespace) {
    this.#kv = kv;
  }

  async ladeState(): Promise<AuthmonState> {
    const [bootRaw, hb, alarm] = await Promise.all([
      this.#kv.get("bootAt"),
      this.#kv.get("hb", "json") as Promise<AuthmonState["hb"]>,
      this.#kv.get("alarm", "json") as Promise<AuthmonState["alarm"]>,
    ]);
    const bootAt = bootRaw ? Number(bootRaw) : null;
    return {
      bootAt: bootAt && isFinite(bootAt) ? bootAt : null,
      hb: hb ?? null,
      alarm: alarm ?? null,
    };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default class RobomonWorker extends WorkerEntrypoint<Env> {
  #session(): RobomonSession {
    return new RobomonSession(new KvHealthRepo(this.env.AUTHMON_KV));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const session = this.#session();

    try {
      if (request.method === "GET") {
        switch (url.pathname) {
          case "/health":
            return json(await session.getSnapshot());
          case "/runs":
            return json(await session.getRunActivity());
          case "/token":
            return json((await session.getTokenStatus()) ?? { token: null });
          case "/alarm":
            return json(await session.getActiveAlarm());
          case "/line":
            return new Response(await session.getHealthLine(), {
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          case "/":
            return json({
              service: "gatekeeper-robomon",
              info: "VON-1803 read-only Auth/Run-Health Observations (Quelle: von-authmon KV).",
              routes: ["/health", "/runs", "/token", "/alarm", "/line", "POST /mcp"],
            });
        }
      }

      if (request.method === "POST" && url.pathname === "/mcp") {
        const req = await request.json<any>();
        const res = await handleMcpMessage({ session }, req);
        return res === null ? new Response(null, { status: 202 }) : json(res);
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return json({ fehler: (e as Error).message ?? "Interner Fehler" }, 500);
    }
  }
}
