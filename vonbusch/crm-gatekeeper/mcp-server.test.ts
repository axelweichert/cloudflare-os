// Tests für den MCP-Server (VON-1800 / K2). Workerd-frei:
//   npx tsx --test vonbusch/crm-gatekeeper/mcp-server.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpMessage, type McpContext } from "./mcp-server.ts";
import { WriteApprovalQueue, MemoryWriteQueueStore } from "./write-queue.ts";
import { MemoryCrmStore } from "./crm-store.ts";

function makeCtx(callerId = "agent-vertrieb"): McpContext {
  let n = 0;
  const queue = new WriteApprovalQueue(
    new MemoryWriteQueueStore(), {},
    () => "2026-08-25T00:00:00.000Z",
    () => `id-${++n}`,
  );
  const crm = new MemoryCrmStore();
  crm.seed("contact", [
    { id: "c1", name: "Erika Mustermann", email: "erika@acme.de", company: "ACME" },
  ]);
  crm.seed("deal", [{ id: "d1", title: "ACME Vertrag", contact_id: "c1", stage: "open" }]);
  return { queue, crm, callerId };
}

function call(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name, arguments: args } };
}
function parse(resp: any) {
  return JSON.parse(resp.result.content[0].text);
}

test("initialize meldet Server-Info", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(r.result.serverInfo.name, "gatekeeper-vonbusch-crm");
});

test("tools/list enthält Lese- und Schreib-Tools", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = r.result.tools.map((t: any) => t.name);
  for (const t of ["list_contacts", "get_contact", "list_deals", "list_activities",
    "propose_contact", "propose_deal", "propose_activity", "list_my_proposals"]) {
    assert.ok(names.includes(t), `Tool ${t} fehlt`);
  }
});

test("list_contacts liest direkt (ohne Freigabe)", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(ctx, call("list_contacts", { search: "acme" }));
  const rows = parse(r);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Erika Mustermann");
});

test("get_contact unbekannt → isError", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(ctx, call("get_contact", { id: "nope" }));
  assert.equal(r.result.isError, true);
});

test("propose_contact legt pending Vorschlag an — schreibt NICHT direkt", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(
    ctx,
    call("propose_contact", { op: "create", fields: { name: "Neu", email: "neu@x.de" }, reason: "Lead" }),
  );
  const out = parse(r);
  assert.equal(out.status, "pending");
  // CRM wurde NICHT verändert:
  const contacts = await ctx.crm.read("contact");
  assert.equal(contacts.length, 1);
  // Aber ein pending-Item liegt in der Queue:
  assert.equal((await ctx.queue.list("pending")).length, 1);
});

test("propose_contact mit unerlaubter Spalte → isError", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(
    ctx,
    call("propose_contact", { op: "create", fields: { name: "X", secret: "y" } }),
  );
  assert.equal(r.result.isError, true);
  assert.match(parse(r).message, /nicht erlaubt/);
});

test("propose_deal update ohne id → isError", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(
    ctx,
    call("propose_deal", { op: "update", fields: { stage: "won" } }),
  );
  assert.equal(r.result.isError, true);
  assert.match(parse(r).message, /targetId/);
});

test("list_my_proposals zeigt nur eigene Vorschläge", async () => {
  const ctx = makeCtx("agent-A");
  await handleMcpMessage(ctx, call("propose_contact", { op: "create", fields: { name: "A" } }));
  // Fremder Vorschlag über zweiten Context auf derselben Queue:
  const other: McpContext = { ...ctx, callerId: "agent-B" };
  await handleMcpMessage(other, call("propose_contact", { op: "create", fields: { name: "B" } }));

  const r: any = await handleMcpMessage(ctx, call("list_my_proposals"));
  const mine = parse(r);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].entity, "contact");
});

test("unbekanntes Tool → JSON-RPC-Fehler", async () => {
  const ctx = makeCtx();
  const r: any = await handleMcpMessage(ctx, call("drop_all_tables"));
  assert.ok(r.error);
  assert.match(r.error.message, /Unbekanntes Tool/);
});

test("notifications/initialized wird nicht beantwortet", async () => {
  const ctx = makeCtx();
  const r = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: null, method: "notifications/initialized" });
  assert.equal(r, null);
});
