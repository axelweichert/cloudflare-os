// Tests fuer den OAuth-2.0-Authorize-Flow mit PKCE (OWL-1744). Workerd-frei, kein Netz:
//   npx tsx --test owlos/etsy-gatekeeper/oauth.test.ts
//
// Deckt ab: PKCE-Korrektheit (RFC-7636-Testvektor), state-CSRF + Einmal-Charakter,
// Happy-Path, falscher/fehlender state, fehlender Code, Token-Endpoint-Fehler.
// Etsy-Token-Tausch laeuft ueber den echten TokenManager gegen ein Fake-fetch (kein Netz).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlEncode,
  generateCodeVerifier,
  generateState,
  computeCodeChallenge,
  buildAuthorizeUrl,
  KvOAuthStateStore,
  MemoryOAuthStateStore,
  startAuthorize,
  completeCallback,
  ETSY_SCOPES,
  DEFAULT_AUTHORIZE_ENDPOINT,
  type OAuthKv,
} from "./oauth.ts";
import { TokenManager, MemoryTokenStore, type StoredToken } from "./token-store.ts";

// --- Fake-fetch (wie token-store.test.ts) ----------------------------------
function fakeTokenFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: Array<{ url: string; body: string }> = [];
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

function params(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj);
}

const REDIRECT = "https://gatekeeper-etsy.example.workers.dev/oauth/callback";

// --- PKCE -------------------------------------------------------------------

test("computeCodeChallenge = base64url(SHA-256(verifier)) — RFC-7636-Testvektor", async () => {
  // RFC 7636 Appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await computeCodeChallenge(verifier);
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("generateCodeVerifier ist zufaellig, 43 Zeichen, PKCE-Zeichensatz", () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.notEqual(a, b, "zwei Aufrufe → unterschiedliche Verifier");
  assert.equal(a.length, 43, "32 Bytes base64url ohne Padding = 43 Zeichen");
  assert.match(a, /^[A-Za-z0-9\-_]+$/, "nur unreserved base64url-Zeichen (kein Padding)");
});

test("base64UrlEncode: kein +/= , nur URL-sichere Zeichen", () => {
  const bytes = new Uint8Array([251, 255, 191, 0, 16, 131]);
  const out = base64UrlEncode(bytes);
  assert.doesNotMatch(out, /[+/=]/);
});

test("generateState ist unratbar und variiert", () => {
  assert.notEqual(generateState(), generateState());
});

// --- buildAuthorizeUrl ------------------------------------------------------

test("buildAuthorizeUrl setzt PKCE-S256 + exakte Scopes", () => {
  const raw = buildAuthorizeUrl({
    authorizeEndpoint: DEFAULT_AUTHORIZE_ENDPOINT,
    clientId: "keystring123",
    redirectUri: REDIRECT,
    scopes: ETSY_SCOPES,
    state: "st-1",
    codeChallenge: "chal-1",
  });
  const u = new URL(raw);
  assert.equal(u.origin + u.pathname, "https://www.etsy.com/oauth/connect");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "keystring123");
  assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(u.searchParams.get("scope"), "shops_r listings_r transactions_r listings_w transactions_w");
  assert.equal(u.searchParams.get("state"), "st-1");
  assert.equal(u.searchParams.get("code_challenge"), "chal-1");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

// --- State-Store: Einmal-Charakter -----------------------------------------

test("KvOAuthStateStore: save→take liefert Verifier genau einmal, dann geloescht", async () => {
  const map = new Map<string, string>();
  const puts: Array<{ key: string; ttl?: number }> = [];
  const kv: OAuthKv = {
    async get(key) { const v = map.get(key); return v ? JSON.parse(v) : null; },
    async put(key, value, options) { map.set(key, value); puts.push({ key, ttl: options?.expirationTtl }); },
    async delete(key) { map.delete(key); },
  };
  const store = new KvOAuthStateStore(kv);
  await store.save("st-abc", "ver-xyz");
  assert.equal(puts[0].key, "oauth:txn:st-abc", "state-Praefix im KV-Key");
  assert.ok(puts[0].ttl && puts[0].ttl > 0, "kurzlebig: TTL gesetzt");
  assert.equal(await store.take("st-abc"), "ver-xyz");
  assert.equal(await store.take("st-abc"), undefined, "zweiter take → weg (Einmal-Charakter)");
});

test("KvOAuthStateStore: unbekannter state → undefined", async () => {
  const kv: OAuthKv = { async get() { return null; }, async put() {}, async delete() {} };
  assert.equal(await new KvOAuthStateStore(kv).take("nope"), undefined);
});

// --- startAuthorize ---------------------------------------------------------

test("startAuthorize legt Verifier unter state ab und baut korrekte Redirect-URL", async () => {
  const stateStore = new MemoryOAuthStateStore();
  const { location } = await startAuthorize({
    clientId: "keystring123",
    authorizeEndpoint: DEFAULT_AUTHORIZE_ENDPOINT,
    redirectUri: REDIRECT,
    stateStore,
    genVerifier: () => "the-verifier",
    genState: () => "the-state",
  });
  const u = new URL(location);
  assert.equal(u.searchParams.get("state"), "the-state");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  // code_challenge MUSS base64url(SHA-256("the-verifier")) sein.
  assert.equal(u.searchParams.get("code_challenge"), await computeCodeChallenge("the-verifier"));
  // Verifier steht NICHT in der URL (kein Geheimnis-Leak).
  assert.doesNotMatch(location, /the-verifier/);
  // …aber serverseitig unter dem state abgelegt.
  assert.equal(await stateStore.take("the-state"), "the-verifier");
});

// --- completeCallback: Happy-Path ------------------------------------------

function makeTokenManager(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const { fetchImpl, calls } = fakeTokenFetch(responses);
  const store = new MemoryTokenStore();
  const tm = new TokenManager(store, {
    tokenEndpoint: "https://api.etsy.com/v3/public/oauth/token",
    clientId: "keystring123",
    fetchImpl,
    clock: () => 1_000_000,
  });
  return { tm, store, calls };
}

test("Happy-Path: gueltiger state+code → Tausch, Token persistiert, Erfolgsseite", async () => {
  const stateStore = new MemoryOAuthStateStore();
  await stateStore.save("st-ok", "ver-ok");
  const { tm, store, calls } = makeTokenManager([
    { json: { access_token: "acc", refresh_token: "ref-rotated", expires_in: 3600, token_type: "Bearer", scope: ETSY_SCOPES } },
  ]);

  const res = await completeCallback({
    params: params({ state: "st-ok", code: "auth-code-123" }),
    redirectUri: REDIRECT,
    stateStore,
    exchange: (a) => tm.exchangeAuthorizationCode(a),
  });

  assert.equal(res.status, 200);
  assert.match(res.html, /verbunden/i);
  // Request-Form korrekt: authorization_code + verifier + redirect_uri.
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /grant_type=authorization_code/);
  assert.match(calls[0].body, /code=auth-code-123/);
  assert.match(calls[0].body, /code_verifier=ver-ok/);
  assert.match(calls[0].body, /redirect_uri=/);
  // Rotierender Refresh-Token persistiert.
  const persisted = await store.get();
  assert.equal(persisted?.refreshToken, "ref-rotated");
  // Kein Geheimnis in der Erfolgsseite.
  assert.doesNotMatch(res.html, /ver-ok|auth-code-123|ref-rotated|acc/);
});

test("Einmal-Charakter: zweiter Callback mit demselben state schlaegt fehl", async () => {
  const stateStore = new MemoryOAuthStateStore();
  await stateStore.save("st-once", "ver-once");
  const { tm } = makeTokenManager([
    { json: { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer" } },
  ]);
  const exchange = (a: { code: string; codeVerifier: string; redirectUri: string }) =>
    tm.exchangeAuthorizationCode(a);

  const first = await completeCallback({ params: params({ state: "st-once", code: "c1" }), redirectUri: REDIRECT, stateStore, exchange });
  assert.equal(first.status, 200);
  const second = await completeCallback({ params: params({ state: "st-once", code: "c2" }), redirectUri: REDIRECT, stateStore, exchange });
  assert.equal(second.status, 400, "state ist verbraucht");
  assert.match(second.html, /state/i);
});

// --- completeCallback: Fehlerfaelle ----------------------------------------

test("falscher state → 400, kein Token-Tausch", async () => {
  const stateStore = new MemoryOAuthStateStore();
  await stateStore.save("st-real", "ver");
  let exchanged = false;
  const res = await completeCallback({
    params: params({ state: "st-FORGED", code: "c" }),
    redirectUri: REDIRECT,
    stateStore,
    exchange: async () => { exchanged = true; return { expiresAt: 0 }; },
  });
  assert.equal(res.status, 400);
  assert.equal(exchanged, false, "kein Tausch bei unbekanntem state");
});

test("fehlender state → 400", async () => {
  const res = await completeCallback({
    params: params({ code: "c" }),
    redirectUri: REDIRECT,
    stateStore: new MemoryOAuthStateStore(),
    exchange: async () => ({ expiresAt: 0 }),
  });
  assert.equal(res.status, 400);
  assert.match(res.html, /state/i);
});

test("fehlender Code → 400, state bleibt unverbraucht", async () => {
  const stateStore = new MemoryOAuthStateStore();
  await stateStore.save("st-keep", "ver-keep");
  const res = await completeCallback({
    params: params({ state: "st-keep" }),
    redirectUri: REDIRECT,
    stateStore,
    exchange: async () => ({ expiresAt: 0 }),
  });
  assert.equal(res.status, 400);
  assert.match(res.html, /code/i);
  // state wurde NICHT verbraucht (fehlgeformter Callback verbrennt ihn nicht).
  assert.equal(await stateStore.take("st-keep"), "ver-keep");
});

test("Etsy error-Parameter (Nutzer lehnt ab) → 400", async () => {
  const res = await completeCallback({
    params: params({ error: "access_denied", error_description: "user denied" }),
    redirectUri: REDIRECT,
    stateStore: new MemoryOAuthStateStore(),
    exchange: async () => ({ expiresAt: 0 }),
  });
  assert.equal(res.status, 400);
  assert.match(res.html, /abgelehnt/i);
});

test("Token-Endpoint-Fehler → 502, state verbraucht (kein Replay)", async () => {
  const stateStore = new MemoryOAuthStateStore();
  await stateStore.save("st-fail", "ver-fail");
  const { tm } = makeTokenManager([{ status: 400, text: "invalid_grant" }]);
  const res = await completeCallback({
    params: params({ state: "st-fail", code: "bad" }),
    redirectUri: REDIRECT,
    stateStore,
    exchange: (a) => tm.exchangeAuthorizationCode(a),
  });
  assert.equal(res.status, 502);
  assert.match(res.html, /fehlgeschlagen/i);
  assert.equal(await stateStore.take("st-fail"), undefined, "state schon beim Versuch verbraucht");
});
