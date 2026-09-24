// vonBuschOS — Robomon-Gatekeeper: MCP-Server (VON-1803 / K6)
//
// Minimaler Streamable-HTTP-MCP-Endpoint, über den Alarm-Triage-Agenten die
// Auth-/Run-Health von von-authmon (VON-1689) LESEN. Rein observierend — es gibt
// keine schreibenden Tools, keine Actions. Alle Tools tragen `readOnlyHint: true`
// (adressiert die fehlende Annotation aus VON-1797, Kind-Issue a602fff9).
//
// Exponierte Tools (alle read-only):
//   - get_health          → vollständige Health-Observation
//   - get_run_activity    → Run-Kennzahlen (heute + Fenster + Fehlerquote)
//   - get_token_status    → OAuth-Ablauf (informativ)
//   - get_active_alarm    → offener von-authmon-Alarm für Triage
//
// Kein cloudflare:workers-Import → in Node 24 / tsx testbar.

import type { RobomonSession } from "./session.ts";

type JsonRpcRequest = { jsonrpc: "2.0"; id: string | number | null; method: string; params?: any };
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const PROTOCOL_VERSION = "2025-06-18";

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function toolContent(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export interface McpContext {
  session: RobomonSession;
}

// readOnlyHint: true auf JEDEM Tool — der Baustein ist rein observierend, ein
// Client darf ohne Rückfrage aufrufen (kein State-Change, keine Nebenwirkung).
const TOOLS = [
  {
    name: "get_health",
    description:
      "Liefert die aktuelle Auth-/Run-Health-Observation (Level, Art, Detail, Heartbeat-Alter, " +
      "Token-Rest, Run-Zähler). Rein lesend — spiegelt den von-authmon-Zustand.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "Health-Snapshot lesen" },
  },
  {
    name: "get_run_activity",
    description:
      "Run-Kennzahlen: heutige Kumulativzähler, rollierendes Delta-Fenster und Fehlerquote im Fenster.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "Run-Aktivität lesen" },
  },
  {
    name: "get_token_status",
    description:
      "OAuth-Token-Ablauf (Ablaufzeit, Reststunden, abgelaufen?). Rein informativ — Near-Expiry ist kein Incident.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "Token-Status lesen" },
  },
  {
    name: "get_active_alarm",
    description:
      "Der aktuell offene von-authmon-Alarm (falls einer besteht) plus frisch abgeleitete Bewertung — für Alarm-Triage.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "Aktiven Alarm lesen" },
  },
] as const;

async function handleToolCall(ctx: McpContext, name: string): Promise<unknown> {
  switch (name) {
    case "get_health":
      return toolContent(await ctx.session.getSnapshot());
    case "get_run_activity":
      return toolContent(await ctx.session.getRunActivity());
    case "get_token_status":
      return toolContent((await ctx.session.getTokenStatus()) ?? { token: null });
    case "get_active_alarm":
      return toolContent(await ctx.session.getActiveAlarm());
    default:
      throw new Error(`Unbekanntes Tool: ${name}`);
  }
}

/** Verarbeitet einen einzelnen JSON-RPC-Request (eine MCP-Methode). */
export async function handleMcpMessage(
  ctx: McpContext,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "gatekeeper-robomon", version: "0.1.0" },
      });
    case "notifications/initialized":
      return null; // Notification — keine Antwort.
    case "tools/list":
      return ok(req.id, { tools: TOOLS });
    case "tools/call": {
      const name = req.params?.name as string;
      try {
        return ok(req.id, await handleToolCall(ctx, name));
      } catch (e) {
        return err(req.id, -32602, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return err(req.id, -32601, `Methode nicht unterstützt: ${req.method}`);
  }
}
