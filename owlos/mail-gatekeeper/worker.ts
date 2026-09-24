// vonBuschOS — Mail-Gatekeeper Worker (VON-1802 / K5)
//
// CF-Email-Outbound mit menschlicher Freigabe-Queue. Gadgets/Agenten schlagen über /mcp Mails
// vor; ein Mensch (hinter CF Access) sieht die Queue unter / und gibt frei oder lehnt ab. Erst
// bei Freigabe wird real über die CF `send_email`-Bindung an noreply@vonbusch.app versendet.
//
// Routen:
//   POST /mcp                      — MCP: propose_email / list_my_proposals (Agenten)
//   GET  /                         — HTML-Freigabe-UI (Mensch, CF-Access-gated)
//   GET  /api/queue[?status=...]   — JSON-Liste der Vorschläge
//   POST /api/queue/:id/approve    — freigeben → versenden
//   POST /api/queue/:id/reject     — ablehnen
//
// Bindings (wrangler.jsonc):
//   EMAIL           send_email-Bindung (Absender noreply@vonbusch.app)
//   MailGatekeeper  Durable Object (hält Queue + Config)
//   vars.ALLOWED_FROM / vars.DEFAULT_FROM

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import {
  MailApprovalQueue,
  type QueueItem,
  type QueueStatus,
  type QueueStore,
  type QueueConfig,
} from "./approval-queue.ts";
import { handleMcpMessage, type McpContext } from "./mcp-server.ts";
import { makeCloudflareMailer, type Mailer } from "./mailer.ts";
import { renderQueuePage } from "./ui.ts";

type Env = {
  EMAIL: { send(message: unknown): Promise<void> };
  MailGatekeeper: DurableObjectNamespace<MailGatekeeper>;
  ALLOWED_FROM?: string; // Kommaliste
  DEFAULT_FROM?: string;
};

function parseAllowedFrom(env: Env): string[] {
  const raw = env.ALLOWED_FROM ?? env.DEFAULT_FROM ?? "noreply@vonbusch.app";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function defaultFrom(env: Env): string {
  return (env.DEFAULT_FROM ?? parseAllowedFrom(env)[0] ?? "noreply@vonbusch.app").trim();
}

// ---------------------------------------------------------------------------
// DO-Storage-gestützter QueueStore.
class DoQueueStore implements QueueStore {
  constructor(private storage: DurableObjectStorage) {}
  private key(id: string) { return `item:${id}`; }
  async get(id: string): Promise<QueueItem | undefined> {
    return this.storage.get<QueueItem>(this.key(id));
  }
  async put(item: QueueItem): Promise<void> {
    await this.storage.put(this.key(item.id), item);
  }
  async list(): Promise<QueueItem[]> {
    const map = await this.storage.list<QueueItem>({ prefix: "item:" });
    return [...map.values()];
  }
}

// ---------------------------------------------------------------------------
// Durable Object: eine Instanz hält die gesamte Firmen-Queue (Singleton per idFromName).
export class MailGatekeeper extends DurableObject<Env> {
  private queue: MailApprovalQueue;
  private mailer: Mailer;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config: QueueConfig = { allowedFrom: parseAllowedFrom(env) };
    this.queue = new MailApprovalQueue(new DoQueueStore(ctx.storage), config);
    this.mailer = makeCloudflareMailer(env.EMAIL);
  }

  /** Testhaken: erlaubt Injektion eines Fake-Mailers. */
  _setMailer(m: Mailer) { this.mailer = m; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- MCP (Agenten) ---
    if (path === "/mcp" && request.method === "POST") {
      return this.handleMcp(request);
    }

    // --- Freigabe-UI (Mensch) ---
    if (path === "/" && request.method === "GET") {
      const items = await this.queue.list();
      return new Response(renderQueuePage(items), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/queue" && request.method === "GET") {
      const status = (url.searchParams.get("status") ?? undefined) as QueueStatus | undefined;
      const items = await this.queue.list(status);
      return json({ items });
    }

    const decide = /^\/api\/queue\/([^/]+)\/(approve|reject)$/.exec(path);
    if (decide && request.method === "POST") {
      return this.handleDecision(request, decode(decide[1]), decide[2] as "approve" | "reject");
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleMcp(request: Request): Promise<Response> {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const ctx: McpContext = {
      queue: this.queue,
      defaultFrom: defaultFrom(this.env),
      callerId:
        request.headers.get("X-Agent-Id") ??
        request.headers.get("Cf-Access-Authenticated-User-Email") ??
        "unknown-agent",
    };
    const resp = await handleMcpMessage(ctx, body);
    if (resp === null) return new Response(null, { status: 202 });
    return json(resp);
  }

  private async handleDecision(request: Request, id: string, decision: "approve" | "reject"): Promise<Response> {
    // Freigebender Mensch = CF-Access-Identität (Fallback für lokalen Dev).
    const decidedBy =
      request.headers.get("Cf-Access-Authenticated-User-Email") ?? "local-dev@vonbusch.app";
    let note: string | undefined;
    try {
      const b = (await request.json()) as { note?: string };
      note = b?.note;
    } catch { /* Body optional */ }

    const decided = await this.queue.decide(id, decision, decidedBy, note);
    if (!decided.ok) return json({ ok: false, message: decided.message }, 409);

    if (decision === "reject") return json({ ok: true, item: decided.value });

    // approve → real versenden.
    try {
      const { id: messageId } = await this.mailer.send(decided.value.proposal);
      const sent = await this.queue.markSent(id, messageId);
      return json({ ok: sent.ok, item: sent.ok ? sent.value : decided.value, messageId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.queue.markFailed(id, msg);
      return json({ ok: false, message: `Versand fehlgeschlagen: ${msg}` }, 502);
    }
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// Worker: alle Requests an die Singleton-DO-Instanz "default" routen.
export default class MailGatekeeperWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const id = this.env.MailGatekeeper.idFromName("default");
    return this.env.MailGatekeeper.get(id).fetch(request);
  }
}
