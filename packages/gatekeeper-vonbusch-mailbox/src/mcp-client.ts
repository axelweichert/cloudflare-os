// Minimaler MCP-over-HTTP-Client (Streamable-HTTP) für den agentic-inbox `/mcp`-Upstream.
//
// 1:1 aus dem VON-1798-Proxy (`vonbusch/mailbox-gatekeeper/mcp-proxy-handler.ts`) übernommen und
// auf das reduziert, was der OS-Port braucht: einen einzelnen `tools/list`/`tools/call`-Roundtrip.
// Kein `cloudflare:workers`-Import → in Node 24 / tsx testbar, im Worker unverändert lauffähig.

/** JSON-RPC-2.0-Antwort (Teilmenge). */
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

/** Persistente MCP-Session gegenüber dem Upstream (eröffnet per initialize). */
export type UpstreamSession = { sessionId: string | null };

/**
 * Ruft eine einzelne JSON-RPC-Methode am Upstream ab und liefert das `result` plus die (ggf.
 * aktualisierte) Session-ID. Wirft bei HTTP- oder Protokollfehlern.
 */
export async function upstreamCall(
  upstreamUrl: string,
  method: string,
  params: unknown,
  session: UpstreamSession,
  authToken?: string,
): Promise<unknown> {
  const id = `os-mailbox-${method}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`Upstream HTTP ${res.status} für "${method}".`);

  const newSessionId = res.headers.get("Mcp-Session-Id");
  if (newSessionId) session.sessionId = newSessionId;

  const ct = (res.headers.get("Content-Type") ?? "").toLowerCase();
  const parsed = ct.includes("text/event-stream")
    ? await readSseResponse(res, id)
    : (JSON.parse(await res.text()) as JsonRpcResponse);
  if (parsed.error) throw new Error(`Upstream "${method}" Fehler: ${parsed.error.message}`);
  return parsed.result;
}

/** Minimaler SSE-Reader: findet das Ereignis mit passender id. */
async function readSseResponse(res: Response, id: string): Promise<JsonRpcResponse> {
  if (!res.body) throw new Error("Upstream-SSE-Antwort hat keinen Body.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const m = /\ndata: ({.*})\n/.exec(buf);
    if (m) {
      const parsed = JSON.parse(m[1]) as JsonRpcResponse;
      if (parsed.id === id) {
        await reader.cancel().catch(() => undefined);
        return parsed;
      }
    }
  }
  throw new Error("SSE-Antwort vom Upstream enthielt keine passende Response.");
}
