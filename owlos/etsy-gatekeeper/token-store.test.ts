// Tests fuer den OAuth-2.0-Token-Lifecycle (OWL-1740). Workerd-frei, kein Netzzugriff:
//   npx tsx --test owlos/etsy-gatekeeper/token-store.test.ts
//
// Deckt den betrieblich haeufigsten Ausfallgrund ab: Access-Token-Ablauf + rotierender
// Refresh-Token. Etsy liefert bei jedem Refresh einen NEUEN refresh_token — der neue muss
// persistiert werden, sonst ist der naechste Refresh tot.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TokenManager,
  MemoryTokenStore,
  KvTokenStore,
  TokenRefreshError,
  type KvLike,
  type StoredToken,
} from "./token-store.ts";

type FetchCall = { url: string; body: string };

/** Fake-fetch, das eine feste (oder sequenzielle) Token-Antwort liefert und Aufrufe zaehlt. */
function fakeTokenFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const status = r.status ?? 200;
    if (r.text !== undefined) return new Response(r.text, { status });
    return new Response(JSON.stringify(r.json ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CONFIG = {
  tokenEndpoint: "https://api.etsy.com/v3/public/oauth/token",
  clientId: "keystring123",
};

test("getAccessToken gibt gueltigen gecachten Token direkt zurueck (kein Refresh)", async () => {
  const now = 1_000_000;
  const store = new MemoryTokenStore({
    accessToken: "acc-1",
    refreshToken: "ref-1",
    expiresAt: now + 3_600_000, // 1h in der Zukunft
  });
  const { fetchImpl, calls } = fakeTokenFetch([{ json: {} }]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => now });
  assert.equal(await tm.getAccessToken(), "acc-1");
  assert.equal(calls.length, 0, "kein Refresh noetig");
});

test("getAccessToken refresht bei Ablauf und persistiert rotierten Refresh-Token", async () => {
  const now = 5_000_000;
  const store = new MemoryTokenStore({
    accessToken: "acc-old",
    refreshToken: "ref-old",
    expiresAt: now - 1, // abgelaufen
  });
  const { fetchImpl, calls } = fakeTokenFetch([
    { json: { access_token: "acc-new", refresh_token: "ref-new", expires_in: 3600, token_type: "Bearer" } },
  ]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => now });
  assert.equal(await tm.getAccessToken(), "acc-new");
  // Request-Form korrekt?
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /grant_type=refresh_token/);
  assert.match(calls[0].body, /refresh_token=ref-old/);
  assert.match(calls[0].body, /client_id=keystring123/);
  // Rotation persistiert?
  const persisted = await store.get();
  assert.equal(persisted?.refreshToken, "ref-new");
  assert.equal(persisted?.accessToken, "acc-new");
  assert.equal(persisted?.expiresAt, now + 3_600_000);
});

test("Skew: refresht kurz VOR Ablauf (60s Puffer)", async () => {
  const now = 9_000_000;
  const store = new MemoryTokenStore({
    accessToken: "acc-soon",
    refreshToken: "ref-soon",
    expiresAt: now + 30_000, // laeuft in 30s ab, < 60s Skew → Refresh
  });
  const { fetchImpl, calls } = fakeTokenFetch([
    { json: { access_token: "acc-fresh", refresh_token: "ref-fresh", expires_in: 3600, token_type: "Bearer" } },
  ]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => now });
  assert.equal(await tm.getAccessToken(), "acc-fresh");
  assert.equal(calls.length, 1);
});

test("Bootstrap aus seedRefreshToken, wenn Store leer ist", async () => {
  const now = 2_000;
  const store = new MemoryTokenStore(); // leer
  const { fetchImpl, calls } = fakeTokenFetch([
    { json: { access_token: "acc-boot", refresh_token: "ref-boot2", expires_in: 3600, token_type: "Bearer" } },
  ]);
  const tm = new TokenManager(store, { ...CONFIG, seedRefreshToken: "seed-ref", fetchImpl, clock: () => now });
  assert.equal(await tm.getAccessToken(), "acc-boot");
  assert.match(calls[0].body, /refresh_token=seed-ref/);
  // danach lebt der rotierte Token im Store — der Seed wird nicht mehr gebraucht.
  assert.equal((await store.get())?.refreshToken, "ref-boot2");
});

test("Fehler, wenn weder Store-Token noch Seed vorhanden", async () => {
  const store = new MemoryTokenStore();
  const { fetchImpl } = fakeTokenFetch([{ json: {} }]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => 0 });
  await assert.rejects(() => tm.getAccessToken(), (e: unknown) => {
    assert.ok(e instanceof TokenRefreshError);
    assert.match((e as Error).message, /Kein Refresh-Token/);
    return true;
  });
});

test("fehlgeschlagener Refresh (HTTP 400) wirft TokenRefreshError mit Status", async () => {
  const now = 1;
  const store = new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: now - 1 });
  const { fetchImpl } = fakeTokenFetch([{ status: 400, text: "invalid_grant" }]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => now });
  await assert.rejects(() => tm.getAccessToken(), (e: unknown) => {
    assert.ok(e instanceof TokenRefreshError);
    assert.equal((e as TokenRefreshError).status, 400);
    assert.match((e as Error).message, /invalid_grant/);
    return true;
  });
});

test("unvollstaendige Refresh-Antwort wirft TokenRefreshError", async () => {
  const now = 1;
  const store = new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: now - 1 });
  const { fetchImpl } = fakeTokenFetch([{ json: { access_token: "only-access" } }]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => now });
  await assert.rejects(() => tm.getAccessToken(), /unvollstaendige Antwort/);
});

test("Single-Flight: parallele getAccessToken teilen EINEN Refresh", async () => {
  const now = 1;
  const store = new MemoryTokenStore({ accessToken: "a", refreshToken: "r", expiresAt: now - 1 });
  const { fetchImpl, calls } = fakeTokenFetch([
    { json: { access_token: "acc-shared", refresh_token: "ref-shared", expires_in: 3600, token_type: "Bearer" } },
  ]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => now });
  const [a, b] = await Promise.all([tm.getAccessToken(), tm.getAccessToken()]);
  assert.equal(a, "acc-shared");
  assert.equal(b, "acc-shared");
  assert.equal(calls.length, 1, "nur ein Netzwerk-Refresh trotz zweier Aufrufe");
});

test("zweiter Refresh nutzt den rotierten Refresh-Token aus dem Store", async () => {
  let now = 1;
  const store = new MemoryTokenStore({ accessToken: "a0", refreshToken: "r0", expiresAt: now - 1 });
  const { fetchImpl, calls } = fakeTokenFetch([
    { json: { access_token: "a1", refresh_token: "r1", expires_in: 3600, token_type: "Bearer" } },
    { json: { access_token: "a2", refresh_token: "r2", expires_in: 3600, token_type: "Bearer" } },
  ]);
  const tm = new TokenManager(store, { ...CONFIG, fetchImpl, clock: () => now });
  assert.equal(await tm.getAccessToken(), "a1");
  now += 3_600_001; // ersten Token ablaufen lassen
  assert.equal(await tm.getAccessToken(), "a2");
  assert.match(calls[1].body, /refresh_token=r1/, "zweiter Refresh nutzt r1, nicht r0");
});

// --- KvTokenStore ----------------------------------------------------------

test("KvTokenStore serialisiert/deserialisiert ueber KV", async () => {
  const map = new Map<string, string>();
  const kv: KvLike = {
    async get(key, _type) { const v = map.get(key); return v ? JSON.parse(v) : null; },
    async put(key, value) { map.set(key, value); },
  };
  const store = new KvTokenStore(kv);
  assert.equal(await store.get(), undefined);
  const t: StoredToken = { accessToken: "a", refreshToken: "r", expiresAt: 42, scope: "listings_r" };
  await store.put(t);
  assert.deepEqual(await store.get(), t);
});
