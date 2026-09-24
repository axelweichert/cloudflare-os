// MCP-Proxy-Handler (VON-1798): der HTTP-Request-Handler des Mailbox-Pinning-Proxys.
//
// Nimmt MCP JSON-RPC (Streamable-HTTP, POST) entgegen und arbeitet als transparenter Proxy zum
// Upstream, der die Mailbox-Verengung durchsetzt:
//   - initialize  → lokal beantwortet, leitet keine Credentials weiter
//   - tools/list  → Upstream-Liste abrufen, buildPinPlan anwenden, verengte Liste zurueckgeben
//   - tools/call  → gateToolCall pruefen, bei Freigabe mit gepinnter Mailbox weiterleiten
//   - alles andere → transparent an Upstream weiterleiten
//
// Kein cloudflare:workers-Import: testbar in Node 24 mit nativem fetch.

import { buildPinPlan, gateToolCall, type McpTool, type PinConfig, type PinPlan } from "./pin-mailbox.ts";

/** JSON-RPC 2.0 Grundtypen (Teilmenge). */
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function errorResponse(id: string | number | null, code: number, message: string): Response {
  const body: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function successResponse(id: string | number | null, result: unknown): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Ruft eine einzelne JSON-RPC-Methode am Upstream ab. */
async function upstreamCall(
  upstreamUrl: string,
  method: string,
  params: unknown,
  sessionId: string | null,
): Promise<{ result: unknown; sessionId: string | null }> {
  const id = `proxy-${Date.now()}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`Upstream HTTP ${res.status} for "${method}".`);

  const newSessionId = res.headers.get("Mcp-Session-Id") ?? sessionId;

  const ct = (res.headers.get("Content-Type") ?? "").toLowerCase();
  let parsed: JsonRpcResponse;
  if (ct.includes("text/event-stream")) {
    parsed = await readSseResponse(res, id);
  } else {
    parsed = JSON.parse(await res.text()) as JsonRpcResponse;
  }
  if (parsed.error) throw new Error(`Upstream "${method}" error: ${parsed.error.message}`);
  return { result: parsed.result, sessionId: newSessionId };
}

/** Minimaler SSE-Reader: findet das Ereignis mit der passenden id. */
async function readSseResponse(res: Response, id: string): Promise<JsonRpcResponse> {
  if (!res.body) throw new Error("Upstream SSE response has no body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { buf += `${decoder.decode()}\n\n`; break; }
    buf += decoder.decode(value, { stream: true });
    const m = /\ndata: ({.*})\n/.exec(buf);
    if (m) {
      const parsed = JSON.parse(m[1]) as JsonRpcResponse;
      if (parsed.id === id) { await reader.cancel().catch(() => undefined); return parsed; }
    }
  }
  throw new Error("SSE response from upstream contained no matching response.");
}

/**
 * Session-Zustand, den der Handler zwischen Requests eines Clients benoetigt.
 * Im Worker liegt das in einem Durable Object; hier als POJO uebergeben (testfreundlich).
 */
export type ProxySession = {
  upstreamSessionId: string | null;
  plan: PinPlan | null;
};

export function emptySession(): ProxySession {
  return { upstreamSessionId: null, plan: null };
}

/**
 * Kernhandler. Verarbeitet einen MCP-POST-Request, prueft/pinnt die Mailbox, reicht an Upstream weiter.
 *
 * @param request  Eingehender HTTP-Request (MCP JSON-RPC POST).
 * @param upstream URL des echten agentic-inbox `/mcp`.
 * @param config   Mailbox-Pinning-Konfiguration.
 * @param session  Veraenderlicher Session-State (wird in-place aktualisiert).
 */
export async function handleMcpRequest(
  request: Request,
  upstream: string,
  config: PinConfig,
  session: ProxySession,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = JSON.parse(await request.text()) as JsonRpcRequest;
  } catch {
    return errorResponse(null, -32700, "Parse error");
  }
  const { id, method, params } = rpc;

  // --- initialize: lokal beantworten, damit der Client unsere Session-ID bekommt und wir
  // unabhaengig vom Upstream eine eigene Session haben. Wir initialisieren aber auch den Upstream,
  // um seine Session zu eroeffnen und sofort den Tool-Katalog zu laden.
  if (method === "initialize") {
    try {
      const { result: serverInfo, sessionId: sid } = await upstreamCall(
        upstream, "initialize", params, null);
      session.upstreamSessionId = sid;
      // Plan noch nicht laden — Tools kommen erst nach initialized-Notification.
      return successResponse(id, serverInfo);
    } catch (err) {
      return errorResponse(id, -32603, `Upstream initialize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- notifications/initialized: weiterleiten + Plan sofort erstellen.
  if (method === "notifications/initialized") {
    try {
      await fetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          ...(session.upstreamSessionId ? { "Mcp-Session-Id": session.upstreamSessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      });
    } catch {
      // Notification: kein Fehler-Rueckgabe per Protokoll.
    }
    // Plan aufbauen — Tools/List einmalig laden.
    try {
      const { result } = await upstreamCall(upstream, "tools/list", {}, session.upstreamSessionId);
      const tools = (result as { tools?: McpTool[] }).tools ?? [];
      session.plan = buildPinPlan(tools, config);
    } catch {
      // Graceful: plan bleibt null, tools/list-Request baut ihn dann on-demand.
    }
    // Notification: kein Response-Body.
    return new Response(null, { status: 202 });
  }

  // --- tools/list: gepinnte Liste zurueckgeben.
  if (method === "tools/list") {
    if (!session.plan) {
      // Lazy init falls initialize/initialized nicht kamen (z.B. direkter Test-Aufruf).
      try {
        const { result } = await upstreamCall(upstream, "tools/list", params, session.upstreamSessionId);
        const tools = (result as { tools?: McpTool[] }).tools ?? [];
        session.plan = buildPinPlan(tools, config);
      } catch (err) {
        return errorResponse(id, -32603, `tools/list upstream error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return successResponse(id, { tools: session.plan.advertised });
  }

  // --- tools/call: Gate pruefen, dann weiterleiten.
  if (method === "tools/call") {
    const callParams = params as { name?: string; arguments?: Record<string, unknown> };
    const toolName = callParams?.name ?? "";
    const args = callParams?.arguments ?? {};

    if (!session.plan) {
      // Plan on-demand.
      try {
        const { result } = await upstreamCall(upstream, "tools/list", {}, session.upstreamSessionId);
        const tools = (result as { tools?: McpTool[] }).tools ?? [];
        session.plan = buildPinPlan(tools, config);
      } catch (err) {
        return errorResponse(id, -32603, `tools/list for plan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const gate = gateToolCall(toolName, args, session.plan, config);
    if (!gate.allowed) {
      return errorResponse(id, -32600, gate.result.content[0]?.text ?? "Refused by mailbox pin.");
    }

    // Weiterleiten mit gepinnten Argumenten.
    try {
      const { result } = await upstreamCall(
        upstream,
        "tools/call",
        { name: toolName, arguments: gate.args },
        session.upstreamSessionId,
      );
      return successResponse(id, result);
    } catch (err) {
      return errorResponse(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  // --- Alles andere: transparent weiterleiten.
  try {
    const { result } = await upstreamCall(upstream, method, params, session.upstreamSessionId);
    return successResponse(id, result);
  } catch (err) {
    return errorResponse(id, -32603, err instanceof Error ? err.message : String(err));
  }
}
