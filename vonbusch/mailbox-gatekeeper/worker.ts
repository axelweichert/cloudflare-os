// vonBuschOS — Mailbox-Pinning-Proxy Worker (VON-1798)
//
// Dünner WorkerEntrypoint-Wrapper um mcp-proxy-handler.ts. Läuft auf workerd unter wrangler dev
// und exponiert /mcp als MCP-Endpoint, den gatekeeper-mcp als Upstream verbindet.
//
// Konfiguration via wrangler-Bindings:
//   UPSTREAM_MCP_URL  (env var)  — URL der agentic-inbox /mcp (z.B. https://mcp.agentmail.to/mcp)
//   MAILBOX_ID        (env var)  — die eine gepinnte Mailbox (z.B. inbox_ceo@vonbusch.digital)
//   PASSTHROUGH_TOOLS (env var)  — JSON-Array von Tool-Namen ohne Mailbox-Argument, die erlaubt sind

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import { handleMcpRequest, emptySession, type ProxySession } from "./mcp-proxy-handler.ts";

type Env = {
  UPSTREAM_MCP_URL: string;
  MAILBOX_ID: string;
  PASSTHROUGH_TOOLS?: string;
  MailboxPinSession: DurableObjectNamespace<MailboxPinSession>;
};

// ---------------------------------------------------------------------------
// Durable Object: haelt den Session-Zustand (Upstream-Session-ID + Plan) pro Client-Session.

export class MailboxPinSession extends DurableObject<Env> {
  #session: ProxySession = emptySession();

  async fetch(request: Request): Promise<Response> {
    const upstream = this.env.UPSTREAM_MCP_URL;
    const mailbox = this.env.MAILBOX_ID;
    const passthroughTools: string[] = (() => {
      try { return JSON.parse(this.env.PASSTHROUGH_TOOLS ?? "[]"); } catch { return []; }
    })();
    return handleMcpRequest(request, upstream, { mailbox, passthroughTools }, this.#session);
  }
}

// ---------------------------------------------------------------------------
// Worker-Fetch: routet jeden Request an die DO-Instanz der Client-Session.
// Jeder Client bekommt eine eigene DO-Instanz (keyed by Mcp-Session-Id oder erzeugt neue).

export default class MailboxPinWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    // Einfaches Session-Routing: Mcp-Session-Id aus dem Request → DO-Name.
    // Neuer Client bekommt eine neue DO-Instanz (keine Session-ID im Header).
    const incoming = request.headers.get("Mcp-Session-Id") ?? "new";
    const id = this.env.MailboxPinSession.idFromName(incoming === "new" ? crypto.randomUUID() : incoming);
    const stub = this.env.MailboxPinSession.get(id);

    // Session-ID in die DO-Response-Header kopieren (Client merkt sie sich).
    const doRes = await stub.fetch(request);
    const newHeaders = new Headers(doRes.headers);
    newHeaders.set("Mcp-Session-Id", id.toString());
    return new Response(doRes.body, {
      status: doRes.status,
      headers: newHeaders,
    });
  }
}
