// vonBuschOS — JustIn-ERP-Gatekeeper: MCP-Server (VON-1804 / K3)
//
// Streamable-HTTP-MCP-Endpoint für Agenten/Gadgets. Kapselt das JustIn-ERP als
// capability-basierte Ressourcen. LESEN geht direkt (read-only, `readOnlyHint: true`);
// "Angebot erstellen" wird nie direkt ausgeführt, sondern als Vorschlag in die
// Freigabe-Queue gelegt (menschliche Bestätigung → worker.ts ruft `adapter.createQuote`).
//
// Exponierte Tools:
//   Lesen (direkt, readOnlyHint):
//     - list_invoices([search],[customerId],[status],[limit],[offset])   → Rechnungen
//     - list_orders([search],[customerId],[status],[limit],[offset])     → Aufträge
//     - get_order_status(orderId)                                        → Auftragsstatus prüfen
//     - list_inventory([search],[limit],[offset])                        → Bestände
//   Schreiben (approval-pflichtig):
//     - propose_quote(customerId, lines, [note], [validUntil], [reason]) → Angebot erstellen (queued)
//     - list_my_proposals()                                             → Status eigener Vorschläge
//
// Kein cloudflare:workers-Import → in Node testbar.

import type { ErpAdapter, ReadOptions } from "./erp-adapter.ts";
import type { QuoteApprovalQueue } from "./quote-queue.ts";

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
function toolError(payload: unknown): unknown {
  return { ...toolContent(payload), isError: true };
}

export interface McpContext {
  queue: QuoteApprovalQueue;
  erp: ErpAdapter;
  /** Identität des aufrufenden Agenten (aus Header). */
  callerId: string;
}

function readOpts(args: Record<string, unknown>): ReadOptions {
  return {
    search: typeof args.search === "string" ? args.search : undefined,
    customerId: typeof args.customerId === "string" ? args.customerId : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    offset: typeof args.offset === "number" ? args.offset : undefined,
  };
}

const readFilterProps = {
  search: { type: "string", description: "Freitext (Nummer/Kunde/SKU)" },
  customerId: { type: "string" },
  status: { type: "string" },
  limit: { type: "number", description: "max. Anzahl (Cap 200, Default 50)" },
  offset: { type: "number" },
};

const TOOLS = [
  {
    name: "list_invoices",
    description: "Listet ERP-Rechnungen (read-only). Optional Freitext/Kunde/Status-Filter.",
    inputSchema: { type: "object", properties: readFilterProps },
    annotations: { readOnlyHint: true, title: "Rechnungen lesen" },
  },
  {
    name: "list_orders",
    description: "Listet ERP-Aufträge (read-only). Optional Freitext/Kunde/Status-Filter.",
    inputSchema: { type: "object", properties: readFilterProps },
    annotations: { readOnlyHint: true, title: "Aufträge lesen" },
  },
  {
    name: "get_order_status",
    description:
      "Prüft den Status eines Auftrags (read-only, kein Seiteneffekt). Reine Leseauskunft — " +
      "daher direkt erlaubt und NICHT approval-pflichtig.",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
    annotations: { readOnlyHint: true, title: "Auftragsstatus prüfen" },
  },
  {
    name: "list_inventory",
    description: "Listet Bestände (read-only). Optional Freitext über SKU/Bezeichnung.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
    annotations: { readOnlyHint: true, title: "Bestände lesen" },
  },
  {
    name: "propose_quote",
    description:
      "Schlägt das Erstellen eines Angebots zur menschlichen Freigabe vor. Erstellt NICHT direkt — " +
      "die Aktion landet in der Freigabe-Queue und wird erst nach Bestätigung im ERP angelegt.",
    inputSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Kundennummer/-ID im ERP" },
        lines: {
          type: "array",
          description: "Positionen: [{ sku, qty, [unitPrice] }]",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              qty: { type: "number" },
              unitPrice: { type: "number", description: "optional; sonst ERP-Stammpreis" },
            },
            required: ["sku", "qty"],
          },
        },
        note: { type: "string" },
        validUntil: { type: "string", description: "Gültig-bis (ISO-Datum)" },
        reason: { type: "string", description: "Kurze Begründung für den freigebenden Menschen" },
      },
      required: ["customerId", "lines"],
    },
    annotations: { readOnlyHint: false, title: "Angebot erstellen (Freigabe nötig)" },
  },
  {
    name: "list_my_proposals",
    description: "Listet die Angebots-Vorschläge des aufrufenden Agenten mit aktuellem Status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "Eigene Vorschläge lesen" },
  },
] as const;

async function handleToolCall(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_invoices":
      return toolContent(await ctx.erp.listInvoices(readOpts(args)));
    case "list_orders":
      return toolContent(await ctx.erp.listOrders(readOpts(args)));
    case "get_order_status": {
      const st = await ctx.erp.getOrderStatus(String(args.orderId ?? ""));
      return st ? toolContent(st) : toolError({ message: "Auftrag nicht gefunden." });
    }
    case "list_inventory":
      return toolContent(await ctx.erp.listInventory(readOpts(args)));
    case "propose_quote": {
      const result = await ctx.queue.propose({
        customerId: args.customerId,
        lines: args.lines,
        note: args.note,
        validUntil: args.validUntil,
        proposedBy: ctx.callerId,
        reason: args.reason,
      });
      if (!result.ok) return toolError({ status: "rejected", message: result.message });
      return toolContent({
        status: "pending",
        id: result.value.id,
        message: "Angebots-Vorschlag angelegt und wartet auf menschliche Freigabe.",
      });
    }
    case "list_my_proposals": {
      const all = await ctx.queue.list();
      const mine = all.filter((i) => i.action.proposedBy === ctx.callerId);
      return toolContent(
        mine.map((i) => ({
          id: i.id,
          customerId: i.action.customerId,
          lines: i.action.lines.length,
          status: i.status,
          resultId: i.resultId,
          resultNumber: i.resultNumber,
        })),
      );
    }
    default:
      throw new Error(`Unbekanntes Tool: ${name}`);
  }
}

/** Verarbeitet einen einzelnen JSON-RPC-Request (eine MCP-Methode). */
export async function handleMcpMessage(ctx: McpContext, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "gatekeeper-justin-erp", version: "0.1.0" },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return ok(req.id, { tools: TOOLS });
    case "tools/call": {
      const name = req.params?.name as string;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return ok(req.id, await handleToolCall(ctx, name, args));
      } catch (e) {
        return err(req.id, -32602, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return err(req.id, -32601, `Methode nicht unterstützt: ${req.method}`);
  }
}

export { TOOLS };
