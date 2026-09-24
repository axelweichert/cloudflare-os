// Runnable check for the MailArchiver connect driver: run
// `pnpm --filter @gadgets/mailarchiver-gatekeeper test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl, verifyCredentials, MailArchiverError } from "./mailarchiver-api.ts";

test("normalizeBaseUrl strips /api and trailing slashes, adds https", () => {
  assert.equal(normalizeBaseUrl("mailarchiver.owl-os.cloud"), "https://mailarchiver.owl-os.cloud");
  assert.equal(normalizeBaseUrl("https://mailarchiver.owl-os.cloud/"), "https://mailarchiver.owl-os.cloud");
  assert.equal(normalizeBaseUrl("https://mailarchiver.owl-os.cloud/api"), "https://mailarchiver.owl-os.cloud");
  assert.equal(normalizeBaseUrl("https://mailarchiver.owl-os.cloud/api/"), "https://mailarchiver.owl-os.cloud");
  assert.throws(() => normalizeBaseUrl("http://mailarchiver.owl-os.cloud"), MailArchiverError); // https only
  assert.throws(() => normalizeBaseUrl(""), MailArchiverError);
});

/** Install a fake global fetch mapping "METHOD url" -> {status, contentType?}. */
function withFetch(
  routes: Record<string, { status: number; contentType?: string }>,
  run: () => Promise<void>,
) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const r = routes[`${method} ${url}`];
    if (!r) throw new Error(`unexpected fetch: ${method} ${url}`);
    return {
      status: r.status,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? r.contentType ?? "application/json" : null) },
      json: async () => ({}),
      text: async () => "",
    } as any;
  }) as any;
  return run().finally(() => {
    globalThis.fetch = orig;
  });
}

test("verifyCredentials returns normalized creds when /api/stats returns 200", async () => {
  await withFetch(
    { "GET https://x.owl-os.cloud/api/stats": { status: 200 } },
    async () => {
      const creds = await verifyCredentials("x.owl-os.cloud", "owl_tok");
      assert.equal(creds.baseUrl, "https://x.owl-os.cloud");
      assert.equal(creds.apiToken, "owl_tok");
      assert.equal(creds.serviceClientId, undefined);
    },
  );
});

test("verifyCredentials rejects a token without the owl_ prefix before fetching", async () => {
  // No routes registered: the fake fetch throws if called, proving verify never hits the network.
  await withFetch({}, async () => {
    await assert.rejects(() => verifyCredentials("x.owl-os.cloud", "nope"), MailArchiverError);
  });
});

test("verifyCredentials rejects when the API token is unauthorized (403)", async () => {
  await withFetch(
    { "GET https://x.owl-os.cloud/api/stats": { status: 403 } },
    async () => {
      await assert.rejects(() => verifyCredentials("x.owl-os.cloud", "owl_tok"), MailArchiverError);
    },
  );
});

test("verifyCredentials rejects when fronted by Cloudflare Access (302 login redirect)", async () => {
  await withFetch(
    { "GET https://x.owl-os.cloud/api/stats": { status: 302, contentType: "text/html; charset=utf-8" } },
    async () => {
      await assert.rejects(() => verifyCredentials("x.owl-os.cloud", "owl_tok"), MailArchiverError);
    },
  );
});
