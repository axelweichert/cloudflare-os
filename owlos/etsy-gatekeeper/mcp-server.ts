// owlOS — Etsy-Gatekeeper: MCP-Server (OWL-1740)
//
// Streamable-HTTP-MCP-Endpoint fuer Agenten. LESEN geht direkt (read-only, gefahrlos);
// SCHREIBEN wird nie direkt ausgefuehrt, sondern als Vorschlag in die Freigabe-Queue gelegt
// (menschliche Bestaetigung → worker.ts fuehrt den Etsy-Write aus).
//
// Exponierte Tools:
//   Lesen (direkt):
//     - get_shop()                                        → Shop-Stammdaten
//     - list_listings([state],[limit],[offset])           → Listings des Shops
//     - get_listing(listingId)                            → eine Listing
//     - get_listing_inventory(listingId)                  → Inventar (Preise/Mengen/Offerings)
//     - list_receipts([limit],[offset],[wasPaid],[wasShipped]) → Bestellungen/Quittungen
//     - list_reviews([limit],[offset])                    → Shop-Bewertungen
//   Schreiben (approval-pflichtig):
//     - propose_listing_update(id, fields, [reason])      → Listing aendern (queued)
//     - propose_receipt_update(id, fields, [reason])      → Bestellstatus aendern (queued)
//     - list_my_proposals()                               → Status eigener Vorschlaege
//
// Kein cloudflare:workers-Import → in Node testbar.

import type { WriteApprovalQueue, EtsyTarget } from "./write-queue.ts";
import { FIELD_ALLOWLIST } from "./write-queue.ts";
import type { EtsyStore } from "./etsy-client.ts";
import { EtsyRateLimitError } from "./etsy-client.ts";

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
  etsy: EtsyStore;
  /** Identitaet des aufrufenden Agenten (aus Header). */
  callerId: string;
}

function numArg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Ein wiederverwendbares inputSchema fuer die propose_* Tools.
function proposeSchema(target: EtsyTarget, idLabel: string) {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: `${idLabel} des zu aendernden Datensatzes` },
      fields: {
        type: "object",
        description: `Feld → Wert. Erlaubt: ${Object.keys(FIELD_ALLOWLIST[target]).join(", ")}`,
      },
      reason: { type: "string", description: "Kurze Begruendung fuer den freigebenden Menschen" },
    },
    required: ["id", "fields"],
  };
}

const TOOLS = [
  {
    name: "get_shop",
    description: "Liefert die Stammdaten des Shops (read-only).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_listings",
    description: "Listet Listings des Shops (read-only). Optional gefiltert auf einen Status (state).",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["active", "inactive", "sold_out", "draft", "expired"] },
        limit: { type: "number", description: "max. Anzahl (Cap 100, Default 25)" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "get_listing",
    description: "Liefert eine Listing per ID (read-only).",
    inputSchema: { type: "object", properties: { listingId: { type: "string" } }, required: ["listingId"] },
  },
  {
    name: "get_listing_inventory",
    description: "Liefert das Inventar einer Listing (Preise, Mengen, Offerings) per ID (read-only).",
    inputSchema: { type: "object", properties: { listingId: { type: "string" } }, required: ["listingId"] },
  },
  {
    name: "list_receipts",
    description: "Listet Bestellungen/Quittungen des Shops (read-only). Optional gefiltert auf bezahlt/versandt.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        offset: { type: "number" },
        wasPaid: { type: "boolean" },
        wasShipped: { type: "boolean" },
      },
    },
  },
  {
    name: "list_reviews",
    description: "Listet die Bewertungen des Shops (read-only).",
    inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" } } },
  },
  {
    name: "propose_listing_update",
    description:
      "Schlaegt das Aendern einer Listing zur menschlichen Freigabe vor. Schreibt NICHT direkt — " +
      "die Aktion landet in der Freigabe-Queue und wird erst nach Bestaetigung ausgefuehrt.",
    inputSchema: proposeSchema("listing", "listing_id"),
  },
  {
    name: "propose_receipt_update",
    description:
      "Schlaegt das Aendern eines Bestellstatus (bezahlt/versandt) zur menschlichen Freigabe vor (queued, nicht direkt).",
    inputSchema: proposeSchema("receipt", "receipt_id"),
  },
  {
    name: "list_my_proposals",
    description: "Listet die Schreib-Vorschlaege des aufrufenden Agenten mit aktuellem Status.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

async function propose(
  ctx: McpContext,
  target: EtsyTarget,
  args: Record<string, unknown>,
): Promise<unknown> {
  const fields = typeof args.fields === "object" && args.fields !== null ? args.fields : {};
  const result = await ctx.queue.propose({
    target,
    op: "update",
    targetId: typeof args.id === "string" ? args.id : "",
    data: fields,
    proposedBy: ctx.callerId,
    reason: args.reason,
  });
  if (!result.ok) return toolError({ status: "rejected", message: result.message });
  return toolContent({
    status: "pending",
    id: result.value.id,
    target,
    targetId: result.value.action.targetId,
    message: "Schreib-Vorschlag angelegt und wartet auf menschliche Freigabe.",
  });
}

/** Uebersetzt Client-Fehler in eine saubere isError-Antwort (429 nicht-still, klar benannt). */
function readError(e: unknown): unknown {
  if (e instanceof EtsyRateLimitError) {
    return toolError({ status: "rate_limited", retryAfterSeconds: e.retryAfterSeconds, message: e.message });
  }
  return toolError({ status: "error", message: e instanceof Error ? e.message : String(e) });
}

async function handleToolCall(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_shop":
      try { return toolContent(await ctx.etsy.getShop()); } catch (e) { return readError(e); }
    case "list_listings":
      try {
        return toolContent(await ctx.etsy.listListings({
          state: typeof args.state === "string" ? (args.state as any) : undefined,
          limit: numArg(args.limit),
          offset: numArg(args.offset),
        }));
      } catch (e) { return readError(e); }
    case "get_listing":
      try { return toolContent(await ctx.etsy.getListing(String(args.listingId ?? ""))); } catch (e) { return readError(e); }
    case "get_listing_inventory":
      try { return toolContent(await ctx.etsy.getListingInventory(String(args.listingId ?? ""))); } catch (e) { return readError(e); }
    case "list_receipts":
      try {
        return toolContent(await ctx.etsy.listReceipts({
          limit: numArg(args.limit),
          offset: numArg(args.offset),
          wasPaid: typeof args.wasPaid === "boolean" ? args.wasPaid : undefined,
          wasShipped: typeof args.wasShipped === "boolean" ? args.wasShipped : undefined,
        }));
      } catch (e) { return readError(e); }
    case "list_reviews":
      try {
        return toolContent(await ctx.etsy.listReviews({ limit: numArg(args.limit), offset: numArg(args.offset) }));
      } catch (e) { return readError(e); }
    case "propose_listing_update":
      return propose(ctx, "listing", args);
    case "propose_receipt_update":
      return propose(ctx, "receipt", args);
    case "list_my_proposals": {
      const all = await ctx.queue.list();
      const mine = all.filter((i) => i.action.proposedBy === ctx.callerId);
      return toolContent(
        mine.map((i) => ({
          id: i.id,
          target: i.action.target,
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
        serverInfo: { name: "gatekeeper-etsy", version: "0.1.0" },
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
      return err(req.id, -32601, `Methode nicht unterstuetzt: ${req.method}`);
  }
}
