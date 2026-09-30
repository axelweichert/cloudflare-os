// Tests fuer den MCP-Server (OWL-1740). Workerd-frei:
//   npx tsx --test owlos/etsy-gatekeeper/mcp-server.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpMessage, type McpContext } from "./mcp-server.ts";
import { WriteApprovalQueue, MemoryWriteQueueStore } from "./write-queue.ts";
import { EtsyRateLimitError, type EtsyStore } from "./etsy-client.ts";

/** In-Memory-Fake des EtsyStore — zaehlt Writes, um "propose schreibt nicht" zu beweisen. */
class FakeEtsy implements EtsyStore {
  writes = 0;
  rateLimitReads = false;
  async getShop() { return this.maybe({ shop_id: 42, shop_name: "MeinShop" }); }
  async listListings() { return this.maybe({ count: 1, results: [{ listing_id: 1, title: "Vase" }] }); }
  async getListing(id: string) { return this.maybe({ listing_id: Number(id), title: "Vase" }); }
  async getListingInventory() { return this.maybe({ products: [] }); }
  async listReceipts() { return this.maybe({ count: 0, results: [] }); }
  async listReviews() { return this.maybe({ count: 0, results: [] }); }
  async applyWrite() { this.writes++; return { id: "1" }; }
  private maybe(v: unknown) {
    if (this.rateLimitReads) throw new EtsyRateLimitError("Etsy-Rate-Limit erreicht (429).", 5);
    return v;
  }
}

function makeCtx(callerId = "agent-shop") {
  let n = 0;
  const queue = new WriteApprovalQueue(
    new MemoryWriteQueueStore(),
    () => "2026-09-30T00:00:00.000Z",
    () => `id-${++n}`,
  );
  const etsy = new FakeEtsy();
  return { ctx: { queue, etsy, callerId } as McpContext, etsy };
}

function call(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name, arguments: args } };
}
function parse(resp: any) {
  return JSON.parse(resp.result.content[0].text);
}

test("initialize meldet Server-Info", async () => {
  const { ctx } = makeCtx();
  const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(r.result.serverInfo.name, "gatekeeper-etsy");
});

test("tools/list enthaelt Lese- und Schreib-Tools", async () => {
  const { ctx } = makeCtx();
  const r: any = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = r.result.tools.map((t: any) => t.name);
  for (const t of ["get_shop", "list_listings", "get_listing", "get_listing_inventory",
    "list_receipts", "list_reviews", "propose_listing_update", "propose_receipt_update", "list_my_proposals"]) {
    assert.ok(names.includes(t), `Tool ${t} fehlt`);
  }
});

test("get_shop liest direkt (ohne Freigabe)", async () => {
  const { ctx } = makeCtx();
  const r: any = await handleMcpMessage(ctx, call("get_shop"));
  assert.equal(parse(r).shop_name, "MeinShop");
});

test("list_listings liest direkt", async () => {
  const { ctx } = makeCtx();
  const r: any = await handleMcpMessage(ctx, call("list_listings", { state: "active" }));
  assert.equal(parse(r).results[0].title, "Vase");
});

test("propose_listing_update legt pending Vorschlag an — schreibt NICHT direkt", async () => {
  const { ctx, etsy } = makeCtx();
  const r: any = await handleMcpMessage(
    ctx,
    call("propose_listing_update", { id: "777", fields: { state: "inactive" }, reason: "Pause" }),
  );
  const out = parse(r);
  assert.equal(out.status, "pending");
  assert.equal(out.target, "listing");
  assert.equal(etsy.writes, 0, "kein direkter Etsy-Write");
  assert.equal((await ctx.queue.list("pending")).length, 1);
});

test("propose_listing_update mit unerlaubtem Feld → isError", async () => {
  const { ctx } = makeCtx();
  const r: any = await handleMcpMessage(
    ctx,
    call("propose_listing_update", { id: "777", fields: { price: 10 } }),
  );
  assert.equal(r.result.isError, true);
  assert.match(parse(r).message, /nicht erlaubt/);
});

test("propose_receipt_update mit nicht-numerischer ID → isError", async () => {
  const { ctx } = makeCtx();
  const r: any = await handleMcpMessage(
    ctx,
    call("propose_receipt_update", { id: "abc", fields: { was_shipped: true } }),
  );
  assert.equal(r.result.isError, true);
  assert.match(parse(r).message, /numerische Etsy-ID/);
});

test("Lese-Tool bei 429 → isError mit rate_limited (kein stiller Retry)", async () => {
  const { ctx, etsy } = makeCtx();
  etsy.rateLimitReads = true;
  const r: any = await handleMcpMessage(ctx, call("get_shop"));
  assert.equal(r.result.isError, true);
  const out = parse(r);
  assert.equal(out.status, "rate_limited");
  assert.equal(out.retryAfterSeconds, 5);
});

test("list_my_proposals zeigt nur eigene Vorschlaege", async () => {
  const { ctx } = makeCtx("agent-A");
  await handleMcpMessage(ctx, call("propose_listing_update", { id: "1", fields: { state: "inactive" } }));
  const other: McpContext = { ...ctx, callerId: "agent-B" };
  await handleMcpMessage(other, call("propose_receipt_update", { id: "2", fields: { was_shipped: true } }));

  const r: any = await handleMcpMessage(ctx, call("list_my_proposals"));
  const mine = parse(r);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].target, "listing");
});

test("unbekanntes Tool → JSON-RPC-Fehler", async () => {
  const { ctx } = makeCtx();
  const r: any = await handleMcpMessage(ctx, call("delete_shop"));
  assert.ok(r.error);
  assert.match(r.error.message, /Unbekanntes Tool/);
});

test("notifications/initialized wird nicht beantwortet", async () => {
  const { ctx } = makeCtx();
  const r = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: null, method: "notifications/initialized" });
  assert.equal(r, null);
});
