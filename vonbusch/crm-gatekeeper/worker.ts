// vonBuschOS — CRM-Gatekeeper Worker (VON-1800 / K2)
//
// CRM-Lesen/Schreiben mit menschlicher Freigabe. Agenten/Gadgets LESEN direkt über /mcp und
// SCHLAGEN Schreibaktionen vor; ein Mensch (hinter CF Access) sieht die Schreib-Queue unter /
// und gibt frei oder lehnt ab. Erst bei Freigabe wird die parametrisierte D1-Mutation gegen
// vonbusch-crm-eu ausgeführt.
//
// Routen:
//   POST /mcp                      — MCP: list_*/get_* (direkt) + propose_* (queued)
//   GET  /                         — HTML-Freigabe-UI (Mensch, CF-Access-gated)
//   GET  /api/queue[?status=...]   — JSON-Liste der Schreib-Vorschläge
//   POST /api/queue/:id/approve    — freigeben → D1-Mutation ausführen
//   POST /api/queue/:id/reject     — ablehnen
//
// Bindings (wrangler.jsonc):
//   CRM_DB          D1 (vonbusch-crm-eu)
//   CrmGatekeeper   Durable Object (hält Schreib-Queue)
//   API_KEY         (secret) interner API-Key für Agenten-Auth an /mcp

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import {
  WriteApprovalQueue,
  type WriteQueueItem,
  type WriteQueueStatus,
  type WriteQueueStore,
} from "./write-queue.ts";
import { D1CrmStore, type D1Like, type CrmStore } from "./crm-store.ts";
import { handleMcpMessage, type McpContext } from "./mcp-server.ts";
import { renderQueuePage } from "./ui.ts";

type Env = {
  CRM_DB: D1Like;
  CrmGatekeeper: DurableObjectNamespace<CrmGatekeeper>;
  /** Interner API-Key; Agenten müssen ihn als Bearer/`X-API-Key` mitschicken. */
  API_KEY?: string;
};

// ---------------------------------------------------------------------------
// DO-Storage-gestützter WriteQueueStore.
class DoWriteQueueStore implements WriteQueueStore {
  constructor(private storage: DurableObjectStorage) {}
  private key(id: string) { return `item:${id}`; }
  async get(id: string): Promise<WriteQueueItem | undefined> {
    return this.storage.get<WriteQueueItem>(this.key(id));
  }
  async put(item: WriteQueueItem): Promise<void> {
    await this.storage.put(this.key(item.id), item);
  }
  async list(): Promise<WriteQueueItem[]> {
    const map = await this.storage.list<WriteQueueItem>({ prefix: "item:" });
    return [...map.values()];
  }
}

// ---------------------------------------------------------------------------
// Durable Object: eine Instanz hält die gesamte Firmen-Schreib-Queue (Singleton per idFromName).
// Die D1-Bindung liegt am Worker; das DO bekommt sie über env (DOs teilen sich env).
export class CrmGatekeeper extends DurableObject<Env> {
  private queue: WriteApprovalQueue;
  private crm: CrmStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.queue = new WriteApprovalQueue(new DoWriteQueueStore(ctx.storage));
    this.crm = new D1CrmStore(env.CRM_DB);
  }

  /** Testhaken: erlaubt Injektion eines Fake-CRM-Stores (z.B. In-Memory). */
  _setCrm(store: CrmStore) { this.crm = store; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/mcp" && request.method === "POST") {
      return this.handleMcp(request);
    }

    if (path === "/" && request.method === "GET") {
      const items = await this.queue.list();
      return new Response(renderQueuePage(items), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/queue" && request.method === "GET") {
      const status = (url.searchParams.get("status") ?? undefined) as WriteQueueStatus | undefined;
      return json({ items: await this.queue.list(status) });
    }

    const decide = /^\/api\/queue\/([^/]+)\/(approve|reject)$/.exec(path);
    if (decide && request.method === "POST") {
      return this.handleDecision(request, decode(decide[1]), decide[2] as "approve" | "reject");
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleMcp(request: Request): Promise<Response> {
    // Agenten-Auth: interner API-Key (falls konfiguriert). CF Access schützt die /-UI separat.
    if (this.env.API_KEY) {
      const auth = request.headers.get("Authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const apiKey = request.headers.get("X-API-Key") ?? bearer;
      if (apiKey !== this.env.API_KEY) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
      }
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const ctx: McpContext = {
      queue: this.queue,
      crm: this.crm,
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

    // approve → parametrisierte D1-Mutation ausführen.
    try {
      const { id: resultId } = await this.crm.applyWrite(decided.value.action, () => crypto.randomUUID());
      const applied = await this.queue.markApplied(id, resultId);
      return json({ ok: applied.ok, item: applied.ok ? applied.value : decided.value, resultId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.queue.markFailed(id, msg);
      return json({ ok: false, message: `Schreiben fehlgeschlagen: ${msg}` }, 502);
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
export default class CrmGatekeeperWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const id = this.env.CrmGatekeeper.idFromName("default");
    return this.env.CrmGatekeeper.get(id).fetch(request);
  }
}
