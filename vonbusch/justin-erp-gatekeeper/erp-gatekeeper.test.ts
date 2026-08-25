// vonBuschOS — JustIn-ERP-Gatekeeper Tests (VON-1804 / K3)
//
// Workerd-frei, kostenfrei:  npx tsx --test vonbusch/justin-erp-gatekeeper/erp-gatekeeper.test.ts
//
// Deckt: ERP-Adapter (Memory + Http gegen Fake-fetch), Angebots-Validierung & -Queue-Lebenszyklus,
// den MCP-Server (read-only Reads + approval-pflichtiges propose_quote) und den Freigabe→ERP-Pfad.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MemoryErpAdapter,
  HttpErpAdapter,
  DEFAULT_JUSTIN_PROFILE,
  clampLimit,
} from "./erp-adapter.ts";
import {
  QuoteApprovalQueue,
  MemoryQuoteQueueStore,
  validateQuote,
} from "./quote-queue.ts";
import { handleMcpMessage, TOOLS, type McpContext } from "./mcp-server.ts";

const T0 = "2026-08-25T00:00:00.000Z";
let idSeq = 0;
const nextId = () => `id_${++idSeq}`;

function seededErp(): MemoryErpAdapter {
  return new MemoryErpAdapter()
    .seedInvoices([
      { id: "inv1", number: "RE-001", customerId: "c1", customerName: "Acme", status: "offen", total: 100 },
      { id: "inv2", number: "RE-002", customerId: "c2", customerName: "Globex", status: "bezahlt", total: 50 },
    ])
    .seedOrders([
      { id: "o1", number: "AB-001", customerId: "c1", customerName: "Acme", status: "in_bearbeitung" },
      { id: "o2", number: "AB-002", customerId: "c2", customerName: "Globex", status: "versandt" },
    ])
    .seedInventory([
      { sku: "SKU-A", name: "Widget", onHand: 42, unit: "Stk" },
      { sku: "SKU-B", name: "Gadget", onHand: 0, unit: "Stk" },
    ]);
}

function freshQueue() {
  return new QuoteApprovalQueue(new MemoryQuoteQueueStore(), {}, () => T0, nextId);
}

function ctx(erp = seededErp(), queue = freshQueue()): McpContext {
  return { erp, queue, callerId: "agent-x" };
}

async function call(c: McpContext, name: string, args: Record<string, unknown> = {}) {
  const resp = await handleMcpMessage(c, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.ok(resp && "result" in resp, `erwartete result für ${name}`);
  return resp!.result as any;
}
function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Adapter — Memory

test("MemoryErpAdapter: Rechnungen lesen + Kunden-/Statusfilter", async () => {
  const erp = seededErp();
  assert.equal((await erp.listInvoices()).length, 2);
  assert.equal((await erp.listInvoices({ customerId: "c1" })).length, 1);
  assert.equal((await erp.listInvoices({ status: "bezahlt" }))[0].number, "RE-002");
  assert.equal((await erp.listInvoices({ search: "acme" })).length, 1);
});

test("MemoryErpAdapter: Auftragsstatus prüfen (read-only)", async () => {
  const erp = seededErp();
  const st = await erp.getOrderStatus("o1");
  assert.equal(st?.status, "in_bearbeitung");
  assert.equal(st?.number, "AB-001");
  assert.equal(await erp.getOrderStatus("nope"), undefined);
});

test("MemoryErpAdapter: Bestände + Freitext", async () => {
  const erp = seededErp();
  assert.equal((await erp.listInventory()).length, 2);
  assert.equal((await erp.listInventory({ search: "widget" }))[0].sku, "SKU-A");
});

test("clampLimit kappt auf 200 und default 50", () => {
  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit(9999), 200);
  assert.equal(clampLimit(-3), 50);
  assert.equal(clampLimit(10), 10);
});

// ---------------------------------------------------------------------------
// Adapter — Http (gegen Fake-fetch)

test("HttpErpAdapter: Bearer-Header + Listen-Extraktion aus {data:[…]}", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ id: "inv9", number: "RE-9" }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const erp = new HttpErpAdapter({ endpoint: "https://erp.example/api/", token: "sekret", fetchImpl: fakeFetch });
  const inv = await erp.listInvoices({ search: "foo", limit: 10 });
  assert.equal(inv[0].id, "inv9");
  const c = calls[0];
  // Trailing-Slash am Endpoint entfernt, Query gebaut:
  assert.match(c.url, /^https:\/\/erp\.example\/api\/invoices\?/);
  assert.match(c.url, /q=foo/);
  assert.match(c.url, /limit=10/);
  assert.equal((c.init!.headers as any).Authorization, "Bearer sekret");
});

test("HttpErpAdapter: getOrderStatus 404 → undefined, Fehler → throw", async () => {
  const fetch404 = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
  const erp404 = new HttpErpAdapter({ endpoint: "https://erp.example", fetchImpl: fetch404 });
  assert.equal(await erp404.getOrderStatus("o1"), undefined);

  const fetch500 = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const erp500 = new HttpErpAdapter({ endpoint: "https://erp.example", fetchImpl: fetch500 });
  await assert.rejects(() => erp500.listOrders(), /ERP-Lesefehler 500/);
});

test("HttpErpAdapter: createQuote POSTet Payload und liest id/number", async () => {
  let body: any;
  const fakeFetch = (async (_url: any, init?: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "q42", number: "AN-42" }), { status: 201 });
  }) as unknown as typeof fetch;
  const erp = new HttpErpAdapter({ endpoint: "https://erp.example", token: "t", fetchImpl: fakeFetch });
  const res = await erp.createQuote({ customerId: "c1", lines: [{ sku: "SKU-A", qty: 2 }] });
  assert.deepEqual(res, { quoteId: "q42", number: "AN-42" });
  assert.equal(body.customerId, "c1");
  assert.equal(body.lines[0].sku, "SKU-A");
});

test("DEFAULT_JUSTIN_PROFILE.extractList erkennt array / {data} / {items}", () => {
  const ex = DEFAULT_JUSTIN_PROFILE.extractList!;
  assert.equal(ex([{ a: 1 }]).length, 1);
  assert.equal(ex({ data: [1, 2] }).length, 2);
  assert.equal(ex({ items: [1] }).length, 1);
  assert.equal(ex({ nix: true }).length, 0);
});

// ---------------------------------------------------------------------------
// Angebots-Validierung

test("validateQuote: gültiges Angebot", () => {
  const v = validateQuote({ customerId: "c1", lines: [{ sku: "A", qty: 3, unitPrice: 9.5 }], proposedBy: "agent" });
  assert.ok(v.ok);
});

test("validateQuote weist Fehler ab", () => {
  assert.equal(validateQuote({ lines: [{ sku: "A", qty: 1 }], proposedBy: "a" }).ok, false); // customerId fehlt
  assert.equal(validateQuote({ customerId: "c", lines: [], proposedBy: "a" }).ok, false); // leere lines
  assert.equal(validateQuote({ customerId: "c", lines: [{ sku: "", qty: 1 }], proposedBy: "a" }).ok, false); // sku leer
  assert.equal(validateQuote({ customerId: "c", lines: [{ sku: "A", qty: 0 }], proposedBy: "a" }).ok, false); // qty 0
  assert.equal(validateQuote({ customerId: "c", lines: [{ sku: "A", qty: -1 }], proposedBy: "a" }).ok, false); // qty neg
  assert.equal(validateQuote({ customerId: "c", lines: [{ sku: "A", qty: 1, unitPrice: -5 }], proposedBy: "a" }).ok, false); // preis neg
  assert.equal(validateQuote({ customerId: "c", lines: [{ sku: "A", qty: 1 }] }).ok, false); // proposedBy fehlt
});

test("validateQuote kappt Obergrenzen (maxQty/maxLines)", () => {
  assert.equal(validateQuote({ customerId: "c", lines: [{ sku: "A", qty: 5 }], proposedBy: "a" }, { maxQty: 4 }).ok, false);
  const many = Array.from({ length: 3 }, () => ({ sku: "A", qty: 1 }));
  assert.equal(validateQuote({ customerId: "c", lines: many, proposedBy: "a" }, { maxLines: 2 }).ok, false);
});

// ---------------------------------------------------------------------------
// Queue-Lebenszyklus

test("Queue: propose → approve → markApplied", async () => {
  const q = freshQueue();
  const p = await q.propose({ customerId: "c1", lines: [{ sku: "A", qty: 1 }], proposedBy: "agent" });
  assert.ok(p.ok);
  const id = (p as any).value.id;

  const dec = await q.decide(id, "approve", "chef@vonbusch.app");
  assert.ok(dec.ok);
  assert.equal((dec as any).value.status, "approved");

  const applied = await q.markApplied(id, "q1", "AN-00001");
  assert.ok(applied.ok);
  assert.equal((applied as any).value.status, "applied");
  assert.equal((applied as any).value.resultNumber, "AN-00001");
});

test("Queue: Doppel-Entscheidung wird verhindert", async () => {
  const q = freshQueue();
  const p = await q.propose({ customerId: "c1", lines: [{ sku: "A", qty: 1 }], proposedBy: "agent" });
  const id = (p as any).value.id;
  await q.decide(id, "approve", "chef@vonbusch.app");
  const second = await q.decide(id, "reject", "chef@vonbusch.app");
  assert.equal(second.ok, false);
});

test("Queue: markApplied nur nach approve", async () => {
  const q = freshQueue();
  const p = await q.propose({ customerId: "c1", lines: [{ sku: "A", qty: 1 }], proposedBy: "agent" });
  const id = (p as any).value.id;
  const bad = await q.markApplied(id, "q1"); // noch pending
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------------------
// MCP-Server

test("MCP: tools/list — alle Reads readOnlyHint, propose_quote nicht", async () => {
  const resp = await handleMcpMessage(ctx(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = (resp as any).result.tools;
  const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
  for (const r of ["list_invoices", "list_orders", "get_order_status", "list_inventory"]) {
    assert.equal(byName[r].annotations.readOnlyHint, true, `${r} muss read-only sein`);
  }
  assert.equal(byName.propose_quote.annotations.readOnlyHint, false);
  assert.equal(TOOLS.find((t) => t.name === "propose_quote")!.inputSchema.required.includes("customerId"), true);
});

test("MCP: Reads liefern ERP-Daten direkt", async () => {
  const c = ctx();
  assert.equal(parse(await call(c, "list_invoices")).length, 2);
  assert.equal(parse(await call(c, "list_orders", { customerId: "c2" }))[0].number, "AB-002");
  assert.equal(parse(await call(c, "get_order_status", { orderId: "o1" })).status, "in_bearbeitung");
  assert.equal(parse(await call(c, "list_inventory", { search: "gadget" }))[0].sku, "SKU-B");
});

test("MCP: get_order_status für unbekannten Auftrag → isError", async () => {
  const res = await call(ctx(), "get_order_status", { orderId: "nope" });
  assert.equal(res.isError, true);
});

test("MCP: propose_quote legt pending an, führt NICHT direkt aus", async () => {
  const erp = seededErp();
  const c = ctx(erp);
  const res = await call(c, "propose_quote", { customerId: "c1", lines: [{ sku: "SKU-A", qty: 2 }] });
  const payload = parse(res);
  assert.equal(payload.status, "pending");
  // Kein Angebot im ERP, solange nicht freigegeben:
  assert.equal(erp.createdQuotes().length, 0);
  // Vorschlag ist über list_my_proposals sichtbar:
  const mine = parse(await call(c, "list_my_proposals"));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "pending");
});

test("MCP: propose_quote mit ungültiger Nutzlast → isError, nichts queued", async () => {
  const c = ctx();
  const res = await call(c, "propose_quote", { customerId: "", lines: [] });
  assert.equal(res.isError, true);
  assert.equal((await c.queue.list()).length, 0);
});

// ---------------------------------------------------------------------------
// End-to-End: Freigabe führt Angebot im ERP aus (simuliert worker.handleDecision)

test("E2E: propose → approve → createQuote im ERP", async () => {
  const erp = seededErp();
  const queue = freshQueue();
  const c: McpContext = { erp, queue, callerId: "agent-x" };

  const proposed = parse(await call(c, "propose_quote", {
    customerId: "c1",
    lines: [{ sku: "SKU-A", qty: 3, unitPrice: 9.9 }],
    note: "Rabattangebot",
  }));
  const id = proposed.id;

  // Menschliche Freigabe (wie worker.handleDecision):
  const decided = await queue.decide(id, "approve", "chef@vonbusch.app");
  assert.ok(decided.ok);
  const { quoteId, number } = await erp.createQuote((decided as any).value.action);
  await queue.markApplied(id, quoteId, number);

  // ERP hat das Angebot real angelegt:
  assert.equal(erp.createdQuotes().length, 1);
  assert.equal(erp.createdQuotes()[0].input.customerId, "c1");
  assert.equal(erp.createdQuotes()[0].input.lines[0].qty, 3);

  const mine = parse(await call(c, "list_my_proposals"));
  assert.equal(mine[0].status, "applied");
  assert.match(mine[0].resultNumber, /^AN-/);
});
