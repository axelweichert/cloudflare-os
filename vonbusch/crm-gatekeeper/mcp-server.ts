// vonBuschOS — CRM-Gatekeeper: MCP-Server (VON-1800 / K2)
//
// Streamable-HTTP-MCP-Endpoint für Agenten/Gadgets. LESEN geht direkt (read-only, gefahrlos);
// SCHREIBEN wird nie direkt ausgeführt, sondern als Vorschlag in die Freigabe-Queue gelegt
// (menschliche Bestätigung → worker.ts führt die D1-Mutation aus).
//
// Exponierte Tools:
//   Lesen (direkt):
//     - list_contacts([search],[limit],[offset])            → Kontakte
//     - get_contact(id)                                      → ein Kontakt
//     - list_deals([contactId],[search],[limit],[offset])   → Deals (opt. je Kontakt)
//     - list_activities([contactId],[search],[limit])       → Aktivitäten (opt. je Kontakt)
//   Schreiben (approval-pflichtig):
//     - propose_contact(op, [id], fields, [reason])         → Kontakt anlegen/ändern (queued)
//     - propose_deal(op, [id], fields, [reason])            → Deal anlegen/ändern (queued)
//     - propose_activity(op, [id], fields, [reason])        → Aktivität anlegen/ändern (queued)
//     - list_my_proposals()                                 → Status eigener Vorschläge
//
// Kein cloudflare:workers-Import → in Node 24 testbar.

import type { WriteApprovalQueue, CrmEntity, WriteOp } from "./write-queue.ts";
import { COLUMN_ALLOWLIST } from "./write-queue.ts";
import type { CrmStore, ReadOptions } from "./crm-store.ts";

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
  queue: WriteApprovalQueue;
  crm: CrmStore;
  /** Identität des aufrufenden Agenten (aus Header). */
  callerId: string;
}

function readOpts(args: Record<string, unknown>): ReadOptions {
  return {
    search: typeof args.search === "string" ? args.search : undefined,
    contactId: typeof args.contactId === "string" ? args.contactId : undefined,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    offset: typeof args.offset === "number" ? args.offset : undefined,
  };
}

// Ein wiederverwendbares inputSchema für die drei propose_* Tools.
function proposeSchema(entity: CrmEntity) {
  return {
    type: "object",
    properties: {
      op: { type: "string", enum: ["create", "update"], description: "Anlegen oder Ändern" },
      id: { type: "string", description: "Datensatz-ID (nur bei update)" },
      fields: {
        type: "object",
        description: `Spalte → Wert. Erlaubt: ${COLUMN_ALLOWLIST[entity].join(", ")}`,
      },
      reason: { type: "string", description: "Kurze Begründung für den freigebenden Menschen" },
    },
    required: ["op", "fields"],
  };
}

const TOOLS = [
  {
    name: "list_contacts",
    description: "Listet CRM-Kontakte (read-only). Optional Freitextsuche über Name/E-Mail/Firma.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        limit: { type: "number", description: "max. Anzahl (Cap 200, Default 50)" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "get_contact",
    description: "Liefert einen Kontakt per ID (read-only).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_deals",
    description: "Listet Deals (read-only). Optional gefiltert auf einen Kontakt (contactId).",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        search: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "list_activities",
    description: "Listet Aktivitäten (read-only). Optional gefiltert auf einen Kontakt (contactId).",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string" },
        search: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "propose_contact",
    description:
      "Schlägt das Anlegen/Ändern eines Kontakts zur menschlichen Freigabe vor. Schreibt NICHT direkt — " +
      "die Aktion landet in der Freigabe-Queue und wird erst nach Bestätigung ausgeführt.",
    inputSchema: proposeSchema("contact"),
  },
  {
    name: "propose_deal",
    description: "Schlägt das Anlegen/Ändern eines Deals zur menschlichen Freigabe vor (queued, nicht direkt).",
    inputSchema: proposeSchema("deal"),
  },
  {
    name: "propose_activity",
    description: "Schlägt das Anlegen/Ändern einer Aktivität zur menschlichen Freigabe vor (queued, nicht direkt).",
    inputSchema: proposeSchema("activity"),
  },
  {
    name: "list_my_proposals",
    description: "Listet die Schreib-Vorschläge des aufrufenden Agenten mit aktuellem Status.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

async function propose(
  ctx: McpContext,
  entity: CrmEntity,
  args: Record<string, unknown>,
): Promise<unknown> {
  const op = args.op as WriteOp;
  const fields = (typeof args.fields === "object" && args.fields !== null) ? args.fields : {};
  const result = await ctx.queue.propose({
    entity,
    op,
    targetId: typeof args.id === "string" ? args.id : undefined,
    data: fields,
    proposedBy: ctx.callerId,
    reason: args.reason,
  });
  if (!result.ok) return toolError({ status: "rejected", message: result.message });
  return toolContent({
    status: "pending",
    id: result.value.id,
    entity,
    op,
    message: "Schreib-Vorschlag angelegt und wartet auf menschliche Freigabe.",
  });
}

async function handleToolCall(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_contacts":
      return toolContent(await ctx.crm.read("contact", readOpts(args)));
    case "get_contact": {
      const row = await ctx.crm.getById("contact", String(args.id ?? ""));
      return row ? toolContent(row) : toolError({ message: "Kontakt nicht gefunden." });
    }
    case "list_deals":
      return toolContent(await ctx.crm.read("deal", readOpts(args)));
    case "list_activities":
      return toolContent(await ctx.crm.read("activity", readOpts(args)));
    case "propose_contact":
      return propose(ctx, "contact", args);
    case "propose_deal":
      return propose(ctx, "deal", args);
    case "propose_activity":
      return propose(ctx, "activity", args);
    case "list_my_proposals": {
      const all = await ctx.queue.list();
      const mine = all.filter((i) => i.action.proposedBy === ctx.callerId);
      return toolContent(
        mine.map((i) => ({
          id: i.id,
          entity: i.action.entity,
          op: i.action.op,
          targetId: i.action.targetId,
          status: i.status,
          resultId: i.resultId,
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
        serverInfo: { name: "gatekeeper-vonbusch-crm", version: "0.1.0" },
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
