// vonBuschOS — JustIn-ERP-Gatekeeper Worker (VON-1804 / K3)
//
// JustIn ERP als capability-basierte Ressourcen mit menschlicher Freigabe für die einzige
// mutierende Aktion. Agenten/Gadgets LESEN direkt über /mcp (Rechnungen/Aufträge/Bestände/
// Auftragsstatus) und SCHLAGEN "Angebot erstellen" vor; ein Mensch (hinter CF Access) sieht
// die Freigabe-Queue unter / und gibt frei oder lehnt ab. Erst bei Freigabe wird das Angebot
// über den ERP-Adapter real im JustIn-ERP angelegt.
//
// Routen:
//   POST /mcp                      — MCP: list_*/get_order_status (direkt) + propose_quote (queued)
//   GET  /                         — HTML-Freigabe-UI (Mensch, CF-Access-gated)
//   GET  /api/queue[?status=...]   — JSON-Liste der Angebots-Vorschläge
//   POST /api/queue/:id/approve    — freigeben → Angebot im ERP anlegen
//   POST /api/queue/:id/reject     — ablehnen
//
// Bindings (wrangler.jsonc):
//   ErpGatekeeper   Durable Object (hält die Angebots-Queue)
//   ERP_ENDPOINT    (var)     Basis-URL der JustIn-REST-API
//   ERP_TOKEN       (secret)  Bearer-Token für die ERP-API
//   API_KEY         (secret)  interner API-Key für Agenten-Auth an /mcp

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import {
  QuoteApprovalQueue,
  type QuoteQueueItem,
  type QuoteQueueStatus,
  type QuoteQueueStore,
} from "./quote-queue.ts";
import { HttpErpAdapter, type ErpAdapter } from "./erp-adapter.ts";
import { handleMcpMessage, type McpContext } from "./mcp-server.ts";
import { renderQueuePage } from "./ui.ts";

type Env = {
  ErpGatekeeper: DurableObjectNamespace<ErpGatekeeper>;
  ERP_ENDPOINT?: string;
  ERP_TOKEN?: string;
  API_KEY?: string;
};

// ---------------------------------------------------------------------------
// DO-Storage-gestützter QuoteQueueStore.
class DoQuoteQueueStore implements QuoteQueueStore {
  constructor(private storage: DurableObjectStorage) {}
  private key(id: string) { return `item:${id}`; }
  async get(id: string): Promise<QuoteQueueItem | undefined> {
    return this.storage.get<QuoteQueueItem>(this.key(id));
  }
  async put(item: QuoteQueueItem): Promise<void> {
    await this.storage.put(this.key(item.id), item);
  }
  async list(): Promise<QuoteQueueItem[]> {
    const map = await this.storage.list<QuoteQueueItem>({ prefix: "item:" });
    return [...map.values()];
  }
}

// ---------------------------------------------------------------------------
// Durable Object: Singleton per idFromName("default") hält die Firmen-Angebots-Queue.
export class ErpGatekeeper extends DurableObject<Env> {
  private queue: QuoteApprovalQueue;
  private erp: ErpAdapter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.queue = new QuoteApprovalQueue(new DoQuoteQueueStore(ctx.storage));
    this.erp = new HttpErpAdapter({ endpoint: env.ERP_ENDPOINT ?? "", token: env.ERP_TOKEN });
  }

  /** Testhaken: erlaubt Injektion eines Fake-ERP-Adapters (z.B. In-Memory). */
  _setErp(adapter: ErpAdapter) { this.erp = adapter; }

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
      const status = (url.searchParams.get("status") ?? undefined) as QuoteQueueStatus | undefined;
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
      erp: this.erp,
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

    // approve → Angebot real im ERP anlegen.
    try {
      const { quoteId, number } = await this.erp.createQuote(decided.value.action);
      const applied = await this.queue.markApplied(id, quoteId, number);
      return json({ ok: applied.ok, item: applied.ok ? applied.value : decided.value, quoteId, number });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.queue.markFailed(id, msg);
      return json({ ok: false, message: `Angebot fehlgeschlagen: ${msg}` }, 502);
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
export default class ErpGatekeeperWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const id = this.env.ErpGatekeeper.idFromName("default");
    return this.env.ErpGatekeeper.get(id).fetch(request);
  }
}
