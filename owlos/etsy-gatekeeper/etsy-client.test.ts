// Tests fuer den Etsy-Open-API-v3-Client (OWL-1740). Workerd-frei, kein Netzzugriff:
//   npx tsx --test owlos/etsy-gatekeeper/etsy-client.test.ts
//
// Deckt URL-/Header-Erzeugung, 429-Behandlung (klarer Fehler, kein stiller Retry) und die
// Write-Erzeugung (form-urlencoded, Allowlist-Filter) ueber einen Fake-`fetch` ab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EtsyApiClient, EtsyRateLimitError, EtsyApiError } from "./etsy-client.ts";
import type { WriteAction } from "./write-queue.ts";

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(handler: (rec: Recorded) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    const rec: Recorded = { url: String(url), method: init?.method ?? "GET", headers, body: init?.body as string | undefined };
    calls.push(rec);
    const r = handler(rec);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: r.headers,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof EtsyApiClient.prototype.constructor>[0]> = {}) {
  return new EtsyApiClient({
    apiBase: "https://openapi.etsy.com",
    keystring: "keystr",
    sharedSecret: "secret",
    shopId: "42",
    getAccessToken: async () => "access-token-xyz",
    fetchImpl,
    ...overrides,
  } as any);
}

test("getShop: korrekte URL, x-api-key, KEIN Bearer (public)", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ json: { shop_id: 42, shop_name: "MeinShop" } }));
  const client = makeClient(fetchImpl);
  const shop = await client.getShop();
  assert.deepEqual(shop, { shop_id: 42, shop_name: "MeinShop" });
  assert.equal(calls[0].url, "https://openapi.etsy.com/v3/application/shops/42");
  assert.equal(calls[0].headers["x-api-key"], "keystr:secret");
  assert.equal(calls[0].headers["Authorization"], undefined);
});

test("listListings: Bearer gesetzt + Query (state/limit/offset), Limit gedeckelt", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ json: { count: 0, results: [] } }));
  const client = makeClient(fetchImpl);
  await client.listListings({ state: "active", limit: 9999, offset: 5 });
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v3/application/shops/42/listings");
  assert.equal(u.searchParams.get("state"), "active");
  assert.equal(u.searchParams.get("limit"), "100"); // Cap
  assert.equal(u.searchParams.get("offset"), "5");
  assert.equal(calls[0].headers["Authorization"], "Bearer access-token-xyz");
});

test("listReceipts: was_paid/was_shipped als Query", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ json: { count: 0, results: [] } }));
  const client = makeClient(fetchImpl);
  await client.listReceipts({ wasPaid: true, wasShipped: false });
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get("was_paid"), "true");
  assert.equal(u.searchParams.get("was_shipped"), "false");
});

test("getListing: nicht-numerische ID wirft EtsyApiError (kein Request)", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ json: {} }));
  const client = makeClient(fetchImpl);
  await assert.rejects(() => client.getListing("1; DROP"), EtsyApiError);
  assert.equal(calls.length, 0);
});

test("429 → EtsyRateLimitError mit retryAfterSeconds (kein stiller Retry)", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 429, headers: { "Retry-After": "7" } }));
  const client = makeClient(fetchImpl);
  await assert.rejects(() => client.getShop(), (e: unknown) => {
    assert.ok(e instanceof EtsyRateLimitError);
    assert.equal((e as EtsyRateLimitError).retryAfterSeconds, 7);
    return true;
  });
  assert.equal(calls.length, 1, "genau ein Versuch, keine Retry-Schleife");
});

test("sonstiger Fehlerstatus → EtsyApiError mit Status", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 404, json: { error: "not found" } }));
  const client = makeClient(fetchImpl);
  await assert.rejects(() => client.getShop(), (e: unknown) => {
    assert.ok(e instanceof EtsyApiError);
    assert.equal((e as EtsyApiError).status, 404);
    return true;
  });
});

test("applyWrite listing: PATCH, korrekter Pfad, form-urlencoded, nur Allowlist, null uebersprungen", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ json: { listing_id: 777 } }));
  const client = makeClient(fetchImpl);
  const action: WriteAction = {
    target: "listing",
    op: "update",
    targetId: "777",
    data: { state: "inactive", title: "Neuer Titel", shop_section_id: null },
    proposedBy: "agent",
  };
  const { id } = await client.applyWrite(action);
  assert.equal(id, "777");
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].url, "https://openapi.etsy.com/v3/application/shops/42/listings/777");
  assert.equal(calls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].headers["Authorization"], "Bearer access-token-xyz");
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get("state"), "inactive");
  assert.equal(body.get("title"), "Neuer Titel");
  assert.equal(body.get("shop_section_id"), null, "null-Wert wird nicht gesendet");
});

test("applyWrite receipt: PUT auf receipts-Pfad mit was_shipped", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ json: { receipt_id: 555 } }));
  const client = makeClient(fetchImpl);
  const action: WriteAction = {
    target: "receipt",
    op: "update",
    targetId: "555",
    data: { was_shipped: true },
    proposedBy: "agent",
  };
  const { id } = await client.applyWrite(action);
  assert.equal(id, "555");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].url, "https://openapi.etsy.com/v3/application/shops/42/receipts/555");
  assert.equal(new URLSearchParams(calls[0].body).get("was_shipped"), "true");
});

test("applyWrite 429 → EtsyRateLimitError (Write nicht wiederholt)", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 429 }));
  const client = makeClient(fetchImpl);
  const action: WriteAction = {
    target: "receipt", op: "update", targetId: "1", data: { was_paid: true }, proposedBy: "agent",
  };
  await assert.rejects(() => client.applyWrite(action), EtsyRateLimitError);
  assert.equal(calls.length, 1);
});
