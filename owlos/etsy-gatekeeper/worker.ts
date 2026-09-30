// owlOS — Etsy-Gatekeeper Worker (OWL-1740, Elternticket OWL-1739)
//
// Etsy-Shop lesen/schreiben mit menschlicher Freigabe. Agenten LESEN direkt ueber /mcp und
// SCHLAGEN Schreibaktionen vor; ein Mensch (hinter CF Access) sieht die Schreib-Queue unter /
// und gibt frei oder lehnt ab. Erst bei Freigabe wird der Etsy-Write (PATCH/PUT) ausgefuehrt.
//
// Routen:
//   POST /mcp                      — MCP: get_*/list_* (direkt) + propose_* (queued)
//   GET  /                         — HTML-Freigabe-UI (Mensch, CF-Access-gated)
//   GET  /api/queue[?status=...]   — JSON-Liste der Schreib-Vorschlaege
//   POST /api/queue/:id/approve    — freigeben → Etsy-Write ausfuehren
//   POST /api/queue/:id/reject     — ablehnen
//   POST /api/token/seed           — initialen OAuth-Refresh-Token setzen (manueller Fallback, CF Access)
//   GET  /api/token/status         — Token-Status (vorhanden? Ablauf?) ohne Geheimnisse
//   GET  /oauth/start              — PKCE-Authorize-Flow starten → 302 auf Etsys Authorize-URL (CF Access)
//   GET  /oauth/callback           — Etsy-Redirect: state pruefen, Code tauschen, Token ins KV (CF Access)
//
// Bindings (wrangler.jsonc):
//   ETSY_TOKENS      KV  (haelt den rotierenden OAuth-Token-Satz)
//   EtsyGatekeeper   Durable Object (haelt Schreib-Queue)
//   ETSY_API_BASE / ETSY_TOKEN_ENDPOINT / ETSY_SHOP_ID   (vars)
//   ETSY_KEYSTRING / ETSY_SHARED_SECRET / ETSY_SEED_REFRESH_TOKEN / API_KEY   (secrets)

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import {
  WriteApprovalQueue,
  type WriteQueueItem,
  type WriteQueueStatus,
  type WriteQueueStore,
} from "./write-queue.ts";
import { EtsyApiClient, type EtsyStore, EtsyRateLimitError } from "./etsy-client.ts";
import { KvTokenStore, TokenManager, type KvLike } from "./token-store.ts";
import { handleMcpMessage, type McpContext } from "./mcp-server.ts";
import { renderQueuePage } from "./ui.ts";
import {
  KvOAuthStateStore,
  startAuthorize,
  completeCallback,
  DEFAULT_AUTHORIZE_ENDPOINT,
  ETSY_SCOPES,
  type OAuthKv,
  type OAuthStateStore,
} from "./oauth.ts";

type Env = {
  ETSY_TOKENS: KvLike & OAuthKv;
  EtsyGatekeeper: DurableObjectNamespace<EtsyGatekeeper>;
  ETSY_API_BASE?: string;
  ETSY_TOKEN_ENDPOINT?: string;
  /** Etsys Authorize-Seite (Nutzer-Zustimmung); Default siehe oauth.ts. */
  ETSY_AUTHORIZE_ENDPOINT?: string;
  ETSY_SHOP_ID?: string;
  ETSY_KEYSTRING?: string;
  ETSY_SHARED_SECRET?: string;
  ETSY_SEED_REFRESH_TOKEN?: string;
  /** Interner API-Key; Agenten muessen ihn als Bearer/`X-API-Key` mitschicken. */
  API_KEY?: string;
};

const DEFAULT_API_BASE = "https://openapi.etsy.com";
const DEFAULT_TOKEN_ENDPOINT = "https://api.etsy.com/v3/public/oauth/token";

// ---------------------------------------------------------------------------
// DO-Storage-gestuetzter WriteQueueStore.
class DoWriteQueueStore implements WriteQueueStore {
  constructor(private storage: DurableObjectStorage) {}
  private key(id: string) { return `item:${id}`; }
  async get(id: string): Promise<WriteQueueItem | undefined> {
    return this.storage.get<WriteQueueItem>(this.key(id));
  }
  async put(item: WriteQueueItem): Promise<void> {
    await this.storage.put(this.key(item.id), item);
  }
  async list(): Promise<WriteQueueItem[]> {
    const map = await this.storage.list<WriteQueueItem>({ prefix: "item:" });
    return [...map.values()];
  }
}

// ---------------------------------------------------------------------------
// Durable Object: eine Instanz haelt die gesamte Schreib-Queue (Singleton per idFromName).
export class EtsyGatekeeper extends DurableObject<Env> {
  private queue: WriteApprovalQueue;
  private tokens: TokenManager;
  private etsy: EtsyStore;
  private oauthState: OAuthStateStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.queue = new WriteApprovalQueue(new DoWriteQueueStore(ctx.storage));
    this.tokens = new TokenManager(new KvTokenStore(env.ETSY_TOKENS), {
      tokenEndpoint: env.ETSY_TOKEN_ENDPOINT ?? DEFAULT_TOKEN_ENDPOINT,
      clientId: env.ETSY_KEYSTRING ?? "",
      seedRefreshToken: env.ETSY_SEED_REFRESH_TOKEN,
    });
    this.oauthState = new KvOAuthStateStore(env.ETSY_TOKENS);
    this.etsy = new EtsyApiClient({
      apiBase: env.ETSY_API_BASE ?? DEFAULT_API_BASE,
      keystring: env.ETSY_KEYSTRING ?? "",
      sharedSecret: env.ETSY_SHARED_SECRET ?? "",
      shopId: env.ETSY_SHOP_ID ?? "",
      getAccessToken: () => this.tokens.getAccessToken(),
    });
  }

  /** Testhaken: erlaubt Injektion eines Fake-Etsy-Stores (z.B. In-Memory). */
  _setEtsy(store: EtsyStore) { this.etsy = store; }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/mcp" && request.method === "POST") {
      return this.handleMcp(request);
    }

    if (path === "/" && request.method === "GET") {
      const items = await this.queue.list();
      return new Response(renderQueuePage(items), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/queue" && request.method === "GET") {
      const status = (url.searchParams.get("status") ?? undefined) as WriteQueueStatus | undefined;
      return json({ items: await this.queue.list(status) });
    }

    const decide = /^\/api\/queue\/([^/]+)\/(approve|reject)$/.exec(path);
    if (decide && request.method === "POST") {
      return this.handleDecision(request, decode(decide[1]), decide[2] as "approve" | "reject");
    }

    if (path === "/api/token/seed" && request.method === "POST") {
      return this.handleTokenSeed(request);
    }
    if (path === "/api/token/status" && request.method === "GET") {
      return this.handleTokenStatus();
    }

    if (path === "/oauth/start" && request.method === "GET") {
      return this.handleOAuthStart(request);
    }
    if (path === "/oauth/callback" && request.method === "GET") {
      return this.handleOAuthCallback(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleMcp(request: Request): Promise<Response> {
    // Agenten-Auth: interner API-Key (falls konfiguriert). CF Access schuetzt die /-UI separat.
    if (this.env.API_KEY) {
      const auth = request.headers.get("Authorization") ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const apiKey = request.headers.get("X-API-Key") ?? bearer;
      if (apiKey !== this.env.API_KEY) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
      }
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const ctx: McpContext = {
      queue: this.queue,
      etsy: this.etsy,
      callerId:
        request.headers.get("X-Agent-Id") ??
        request.headers.get("Cf-Access-Authenticated-User-Email") ??
        "unknown-agent",
    };
    const resp = await handleMcpMessage(ctx, body);
    if (resp === null) return new Response(null, { status: 202 });
    return json(resp);
  }

  private async handleDecision(request: Request, id: string, decision: "approve" | "reject"): Promise<Response> {
    const decidedBy =
      request.headers.get("Cf-Access-Authenticated-User-Email") ?? "local-dev@owlos.app";
    let note: string | undefined;
    try {
      const b = (await request.json()) as { note?: string };
      note = b?.note;
    } catch { /* Body optional */ }

    const decided = await this.queue.decide(id, decision, decidedBy, note);
    if (!decided.ok) return json({ ok: false, message: decided.message }, 409);

    if (decision === "reject") return json({ ok: true, item: decided.value });

    // approve → Etsy-Write ausfuehren.
    try {
      const { id: resultId } = await this.etsy.applyWrite(decided.value.action);
      const applied = await this.queue.markApplied(id, resultId);
      return json({ ok: applied.ok, item: applied.ok ? applied.value : decided.value, resultId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.queue.markFailed(id, msg);
      const status = e instanceof EtsyRateLimitError ? 429 : 502;
      return json({ ok: false, message: `Etsy-Schreiben fehlgeschlagen: ${msg}` }, status);
    }
  }

  /** Wiring: initialen (rotierenden) Refresh-Token setzen. Hinter CF Access (Mensch). */
  private async handleTokenSeed(request: Request): Promise<Response> {
    let refreshToken = "";
    try {
      const b = (await request.json()) as { refreshToken?: string };
      refreshToken = typeof b?.refreshToken === "string" ? b.refreshToken.trim() : "";
    } catch { /* faellt unten in die Fehlerbehandlung */ }
    if (!refreshToken) return json({ ok: false, message: "refreshToken fehlt im Body." }, 400);
    try {
      const t = await this.tokens.refresh(refreshToken);
      return json({ ok: true, expiresAt: new Date(t.expiresAt).toISOString(), scope: t.scope });
    } catch (e) {
      return json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  /**
   * Wiring: GET /oauth/start — PKCE-Authorize-Flow anstossen. Hinter CF Access (Mensch).
   * redirect_uri wird aus dem Request-Origin abgeleitet → keine separate Config, immer die
   * echte Callback-URL dieses Workers.
   */
  private async handleOAuthStart(request: Request): Promise<Response> {
    const clientId = this.env.ETSY_KEYSTRING ?? "";
    if (!clientId) {
      return new Response(
        "ETSY_KEYSTRING (OAuth client_id) ist nicht konfiguriert — erst beim Wiring setzen.",
        { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/oauth/callback`;
    const { location } = await startAuthorize({
      clientId,
      authorizeEndpoint: this.env.ETSY_AUTHORIZE_ENDPOINT ?? DEFAULT_AUTHORIZE_ENDPOINT,
      redirectUri,
      scopes: ETSY_SCOPES,
      stateStore: this.oauthState,
    });
    return new Response(null, { status: 302, headers: { Location: location } });
  }

  /**
   * Wiring: GET /oauth/callback — state pruefen, Code+Verifier gegen den Token-Endpoint tauschen,
   * Refresh-Token via TokenManager/KvTokenStore ins KV. Hinter CF Access (Mensch).
   */
  private async handleOAuthCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/oauth/callback`;
    const { status, html } = await completeCallback({
      params: url.searchParams,
      redirectUri,
      stateStore: this.oauthState,
      exchange: (args) => this.tokens.exchangeAuthorizationCode(args),
    });
    return new Response(html, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  /** Token-Status ohne Geheimnisse — nur ob vorhanden und wann der Access-Token ablaeuft. */
  private async handleTokenStatus(): Promise<Response> {
    const store = new KvTokenStore(this.env.ETSY_TOKENS);
    const t = await store.get();
    if (!t) return json({ present: false });
    return json({
      present: true,
      accessTokenExpiresAt: new Date(t.expiresAt).toISOString(),
      expired: t.expiresAt <= Date.now(),
      scope: t.scope,
    });
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// Worker: alle Requests an die Singleton-DO-Instanz "default" routen.
export default class EtsyGatekeeperWorker extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const id = this.env.EtsyGatekeeper.idFromName("default");
    return this.env.EtsyGatekeeper.get(id).fetch(request);
  }
}
