// vonBuschOS — Mail-Gatekeeper: MCP-Server (VON-1802 / K5)
//
// Minimaler Streamable-HTTP-MCP-Endpoint, über den Gadgets/Agenten Mails VORSCHLAGEN
// (aber nie direkt versenden). Der Versand ist menschlich freigabepflichtig (siehe worker.ts).
//
// Exponierte Tools:
//   - propose_email(to, subject, text, [from], [reason]) → legt ein `pending` Item an
//   - list_my_proposals()                                 → Status der eigenen Vorschläge
//
// Kein cloudflare:workers-Import → in Node 24 testbar.

import type { MailApprovalQueue } from "./approval-queue.ts";

type JsonRpcRequest = { jsonrpc: "2.0"; id: string | number | null; method: string; params?: any };
type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

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
  queue: MailApprovalQueue;
  /** Standard-Absender, falls der Agent kein `from` angibt. */
  defaultFrom: string;
  /** Identität des aufrufenden Agenten (z.B. aus einem Header). */
  callerId: string;
}

const TOOLS = [
  {
    name: "propose_email",
    description:
      "Schlägt eine ausgehende E-Mail zur menschlichen Freigabe vor. Versendet NICHT direkt — " +
      "die Mail landet in einer Freigabe-Queue und wird erst nach menschlicher Bestätigung gesendet.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Empfänger-Adresse" },
        subject: { type: "string", description: "Betreff" },
        text: { type: "string", description: "Nachrichtentext (plain text)" },
        from: { type: "string", description: "Absender (optional; muss auf der Allowlist stehen)" },
        reason: { type: "string", description: "Kurze Begründung für den freigebenden Menschen" },
      },
      required: ["to", "subject", "text"],
    },
  },
  {
    name: "list_my_proposals",
    description: "Listet die Vorschläge des aufrufenden Agenten mit aktuellem Status.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

async function handleToolCall(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "propose_email") {
    const result = await ctx.queue.propose({
      to: args.to,
      from: (typeof args.from === "string" && args.from.trim()) ? args.from : ctx.defaultFrom,
      subject: args.subject,
      text: args.text,
      proposedBy: ctx.callerId,
      reason: args.reason,
    });
    if (!result.ok) {
      return { ...toolContent({ status: "rejected", message: result.message }), isError: true };
    }
    return toolContent({
      status: "pending",
      id: result.value.id,
      message: "Vorschlag angelegt und wartet auf menschliche Freigabe.",
    });
  }

  if (name === "list_my_proposals") {
    const all = await ctx.queue.list();
    const mine = all.filter((i) => i.proposal.proposedBy === ctx.callerId);
    return toolContent(
      mine.map((i) => ({ id: i.id, to: i.proposal.to, subject: i.proposal.subject, status: i.status })),
    );
  }

  throw new Error(`Unbekanntes Tool: ${name}`);
}

/** Verarbeitet einen einzelnen JSON-RPC-Request (eine MCP-Methode). */
export async function handleMcpMessage(ctx: McpContext, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "gatekeeper-vonbusch-mail", version: "0.1.0" },
      });
    case "notifications/initialized":
      return null; // Notification — keine Antwort.
    case "tools/list":
      return ok(req.id, { tools: TOOLS });
    case "tools/call": {
      const name = req.params?.name as string;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await handleToolCall(ctx, name, args);
        return ok(req.id, result);
      } catch (e) {
        return err(req.id, -32602, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return err(req.id, -32601, `Methode nicht unterstützt: ${req.method}`);
  }
}
