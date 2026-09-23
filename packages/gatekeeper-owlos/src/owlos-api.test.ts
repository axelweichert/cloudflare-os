// Runnable check for the owlOS connect driver: run `pnpm --filter @gadgets/owlos-gatekeeper test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInstanceUrl, verifyCredentials, OwlosError } from "./owlos-api.ts";

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
    "GET https://x.owl-os.cloud/api/me bearer": { status: 401, body: { error: "unauthorized" } },
    "GET https://x.owl-os.cloud/api/me apikey": { status: 200, body: { workspace: "x" } },
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
    "GET https://x.owl-os.cloud/api/me bearer": { status: 401, body: {} },
    "GET https://x.owl-os.cloud/api/me apikey": { status: 401, body: {} },
  }, async () => {
    await assert.rejects(() => verifyCredentials("x.owl-os.cloud", "tok"), OwlosError);
  });
});
