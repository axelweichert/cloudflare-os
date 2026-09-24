// Runnable check for the owlOS connect driver: run `pnpm --filter @gadgets/owlos-gatekeeper test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInstanceUrl, verifyCredentials, OwlosError, OwlosClient } from "./owlos-api.ts";

test("normalizeInstanceUrl strips /api and trailing slashes, adds https", () => {
  assert.equal(normalizeInstanceUrl("demo.owl-os.cloud"), "https://demo.owl-os.cloud");
  assert.equal(normalizeInstanceUrl("https://demo.owl-os.cloud/"), "https://demo.owl-os.cloud");
  assert.equal(normalizeInstanceUrl("https://demo.owl-os.cloud/api"), "https://demo.owl-os.cloud");
  assert.equal(normalizeInstanceUrl("https://demo.owl-os.cloud/api/"), "https://demo.owl-os.cloud");
  assert.throws(() => normalizeInstanceUrl("http://demo.owl-os.cloud"), OwlosError); // https only
  assert.throws(() => normalizeInstanceUrl(""), OwlosError);
});

/** Install a fake global fetch mapping "METHOD url" -> {status, body}. */
function withFetch(routes: Record<string, { status: number; body: any }>, run: () => Promise<void>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const scheme = init?.headers?.Authorization ? "bearer" : init?.headers?.["X-API-Key"] ? "apikey" : "none";
    const r = routes[`${method} ${url} ${scheme}`] ?? routes[`${method} ${url}`];
    if (!r) throw new Error(`unexpected fetch: ${method} ${url} ${scheme}`);
    return { status: r.status, json: async () => r.body } as any;
  }) as any;
  return run().finally(() => { globalThis.fetch = orig; });
}

const HEALTH_OK = { status: 200, body: { ok: true, app: "owlos-cloud-erp" } };

test("verifyCredentials picks the scheme the instance accepts (X-API-Key)", async () => {
  await withFetch({
    "GET https://x.owl-os.cloud/api/health": HEALTH_OK,
    "GET https://x.owl-os.cloud/api/auth/me bearer": { status: 401, body: { error: "unauthorized" } },
    "GET https://x.owl-os.cloud/api/auth/me apikey": { status: 200, body: { workspace: "x" } },
  }, async () => {
    const creds = await verifyCredentials("x.owl-os.cloud", "tok");
    assert.equal(creds.authScheme, "apikey");
    assert.equal(creds.instanceUrl, "https://x.owl-os.cloud");
  });
});

test("verifyCredentials rejects a non-owlOS instance before touching the token", async () => {
  await withFetch({
    "GET https://x.owl-os.cloud/api/health": { status: 200, body: { app: "something-else" } },
  }, async () => {
    await assert.rejects(() => verifyCredentials("x.owl-os.cloud", "tok"), OwlosError);
  });
});

test("verifyCredentials fails when neither scheme authenticates", async () => {
  await withFetch({
    "GET https://x.owl-os.cloud/api/health": HEALTH_OK,
    "GET https://x.owl-os.cloud/api/auth/me bearer": { status: 401, body: {} },
    "GET https://x.owl-os.cloud/api/auth/me apikey": { status: 401, body: {} },
  }, async () => {
    await assert.rejects(() => verifyCredentials("x.owl-os.cloud", "tok"), OwlosError);
  });
});

// ---- OwlosClient.request (S2 CRUD core) ------------------------------------

const BEARER = { instanceUrl: "https://x.owl-os.cloud", apiToken: "tok", authScheme: "bearer" as const };

/** Fetch mock that also records the last request's method/body/content-type for POST/PATCH asserts. */
function withRequestFetch(routes: Record<string, { status: number; body: any }>, run: (seen: any) => Promise<void>) {
  const orig = globalThis.fetch;
  const seen: any = {};
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    seen.method = method;
    seen.url = url;
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    seen.contentType = init?.headers?.["Content-Type"];
    const r = routes[`${method} ${url}`];
    if (!r) throw new Error(`unexpected fetch: ${method} ${url}`);
    return { status: r.status, json: async () => r.body } as any;
  }) as any;
  return run(seen).finally(() => { globalThis.fetch = orig; });
}

test("OwlosClient.request GET returns the parsed body directly", async () => {
  await withRequestFetch({
    "GET https://x.owl-os.cloud/api/erp/quotes": { status: 200, body: [{ id: 1, title: "Q1" }] },
  }, async () => {
    const client = new OwlosClient(BEARER);
    const quotes = await client.request("GET", "/api/erp/quotes");
    assert.deepEqual(quotes, [{ id: 1, title: "Q1" }]);
  });
});

test("OwlosClient.request POST sends a JSON body with Content-Type", async () => {
  await withRequestFetch({
    "POST https://x.owl-os.cloud/api/erp/quotes": { status: 201, body: { id: 7, title: "New" } },
  }, async (seen) => {
    const client = new OwlosClient(BEARER);
    const created = await client.request("POST", "/api/erp/quotes", { title: "New" });
    assert.deepEqual(created, { id: 7, title: "New" });
    assert.equal(seen.method, "POST");
    assert.deepEqual(seen.body, { title: "New" });
    assert.equal(seen.contentType, "application/json");
  });
});

test("OwlosClient.request maps 401/403 to a credentials error, other non-2xx to a route error", async () => {
  await withRequestFetch({
    "GET https://x.owl-os.cloud/api/companies": { status: 401, body: { error: "unauthorized" } },
  }, async () => {
    await assert.rejects(() => new OwlosClient(BEARER).request("GET", "/api/companies"), /no longer valid/);
  });
  await withRequestFetch({
    "POST https://x.owl-os.cloud/api/erp/quotes": { status: 422, body: { error: "Titel ist Pflicht" } },
  }, async () => {
    await assert.rejects(() => new OwlosClient(BEARER).request("POST", "/api/erp/quotes", {}), /HTTP 422.*Titel ist Pflicht/);
  });
});
