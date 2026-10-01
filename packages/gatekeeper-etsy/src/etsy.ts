// Etsy gatekeeper — a CloudflareOS Gatekeeper for the Etsy shop `lindanahandmade` (OWL-1748).
//
// Phase 1 (write-gatekeeper skill, responsibilities 1–3):
//   1. Auth — OAuth 2.0 + PKCE, tokens stored/refreshed/rotated in the UserAccount DO.
//   2. Capability-based API — Vendor / User / per-resource Gatekeeper facets exposing the Session
//      types from `types.d.ts` (EtsyShop, EtsyListing, EtsyReceipt).
//   3. Fine-grained granting — two grant levels (whole shop, or a single listing) via
//      getSupportedResources() + resource configurator UIs.
//
// Observer verification (responsibility 7) is present in minimal strategy-B form so the code
// type-checks; the full strategy, plus approval logging depth, caching, and simulation, are Phase 2.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ApprovalQueue,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  computeCodeChallenge,
  EtsyApi,
  EtsyApiError,
  ETSY_AUTHORIZE_ENDPOINT,
  ETSY_SCOPES,
  exchangeAuthCode,
  generateCodeVerifier,
  refreshToken,
  type EtsyTokenSet,
} from "./etsy-api";
import {
  EtsyListingConfiguratorUI,
  EtsyShopConfiguratorUI,
} from "./etsy-configurators";
import ETSY_LISTING_CONFIGURATOR_HTML from "./generated/etsy-listing-configurator-ui.txt";
import ETSY_SHOP_CONFIGURATOR_HTML from "./generated/etsy-shop-configurator-ui.txt";
import ETSY_LOGO_SVG from "./etsy-logo.svg";
import type {
  Cursor,
  EtsyListing,
  EtsyListingDetails,
  EtsyListingFilter,
  EtsyPageOptions,
  EtsyReceipt,
  EtsyReceiptDetails,
  EtsyReceiptFilter,
  EtsyReceiptSummary,
  EtsyReview,
  EtsyShop,
  EtsyShopInfo,
  EtsyListingSummary,
} from "./types";
import TYPES_CODE from "./types.txt";

// The single shop this gatekeeper is authorized for (OWL-1748). Overridable via env for testing.
const DEFAULT_SHOP = "lindanahandmade";

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const ORPHAN_FLOW_TIMEOUT_MS = 60 * 60 * 1000;

const ETSY_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(ETSY_LOGO_SVG)}`;

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  /** App API key (keystring): sent as `x-api-key` and used as the OAuth client id. */
  ETSY_KEYSTRING?: string;
  /** Etsy shared secret. Not used by the v3 PKCE public-client flow; accepted for completeness. */
  ETSY_SHARED_SECRET?: string;
  /** Shop handle this gatekeeper serves. Defaults to `lindanahandmade`. */
  ETSY_SHOP?: string;
  /** Data API base, defaults to https://openapi.etsy.com. */
  ETSY_API_BASE?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  codeVerifier?: string;
};

type ResourceKind = "shop" | "listing";

type EtsyGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: ResourceKind;
  /** Present for the shop granularity. */
  shopName?: string;
  /** Present for the listing granularity. */
  listingId?: string;
};

// Stored action records (side-effecting writes awaiting approval). Reads are not simulated in
// Phase 1, so each action carries awaitDecision.
type EtsyAction =
  | { type: "setTitle"; listingId: string; title: string }
  | { type: "setDescription"; listingId: string; description: string }
  | { type: "setState"; listingId: string; state: "active" | "inactive" }
  | { type: "setAutoRenew"; listingId: string; enabled: boolean }
  | { type: "setShopSection"; listingId: string; shopSectionId: number | null }
  | { type: "markShipped"; receiptId: string }
  | { type: "markPaid"; receiptId: string };

type StoredActionRecord = {
  action: EtsyAction;
  state: "pending" | "applied" | "rejected";
};

const SHOP_RESOURCE: SupportedResource = {
  urlPattern: "https://www.etsy.com/shop/:shopName",
  title: "Etsy Shop",
  description: "Read and manage a whole Etsy shop: its listings, orders, and reviews.",
};

const LISTING_RESOURCE: SupportedResource = {
  urlPattern: "https://www.etsy.com/listing/:listingId",
  title: "Etsy Listing",
  description: "Read and manage a single Etsy product listing.",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [SHOP_RESOURCE, LISTING_RESOURCE];

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Etsy Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure the Etsy app API key (keystring) for this gatekeeper.</p>
    </div>
  </body>
</html>`;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/etsy");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getApiBase(env: Env): string {
  return env.ETSY_API_BASE ?? "https://openapi.etsy.com";
}

function getShopName(env: Env): string {
  return env.ETSY_SHOP ?? DEFAULT_SHOP;
}

function shopUrl(shopName: string): string {
  return `https://www.etsy.com/shop/${shopName}`;
}

function listingUrl(listingId: string): string {
  return `https://www.etsy.com/listing/${listingId}`;
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the browser OAuth flow (PKCE).

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.ETSY_KEYSTRING) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const redirectUrl = new URL(ETSY_AUTHORIZE_ENDPOINT);
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", env.ETSY_KEYSTRING);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("scope", ETSY_SCOPES.join(" "));
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      redirectUrl.searchParams.set("code_challenge", begun.codeChallenge);
      redirectUrl.searchParams.set("code_challenge_method", "S256");

      return Response.redirect(redirectUrl.toString(), 302);
    }

    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(
          "Etsy authorization failed. Please restart the connection flow from Cloudflare OS.",
          { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }

      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return new Response("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );
      const accepted = await stub.acceptAuthCode(code, oauthNonce);
      if (!accepted) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(SELF_CLOSING_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Etsy",
      url: "https://www.etsy.com",
      logo: { url: ETSY_LOGO_URL },
      color: "#fdebe0",
      tagline: "Manage your Etsy shop's listings and orders",
      description:
        "Connect your Etsy account so Cloudflare OS can read your shop's listings, orders, and " +
        "reviews, edit listing details, and update order fulfilment — with every change gated by " +
        "human approval.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — OAuth token lifecycle (refresh + rotation + single-flight).

export class UserAccount extends DurableObject<Env> {
  /** Single-flight guard so concurrent refreshes don't invalidate the rotating refresh token. */
  #inflightRefresh?: Promise<EtsyTokenSet>;

  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>,
    initiationNonce: string,
  ): Promise<void> {
    if (!this.ctx.storage.kv.get<EtsyTokenSet>("token")) {
      await this.ctx.storage.setAlarm(Date.now() + ORPHAN_FLOW_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /** Consume the initiation nonce, mint the OAuth-stage nonce + PKCE verifier, return the challenge. */
  async beginOAuthFlow(
    initiationNonce: string,
  ): Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (
      !stored ||
      stored.stage !== "initiation" ||
      Date.now() >= stored.expiresAt ||
      !constantTimeEqual(stored.value, initiationNonce)
    ) {
      return null;
    }

    const oauthNonce = generateNonce();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      codeVerifier,
    });
    return { oauthNonce, codeChallenge };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (
      !stored ||
      stored.stage !== "oauth" ||
      !stored.codeVerifier ||
      Date.now() >= stored.expiresAt ||
      !constantTimeEqual(stored.value, oauthNonce)
    ) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    const clientId = this.env.ETSY_KEYSTRING;
    if (!clientId) throw new Error("Etsy OAuth is not configured.");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Took too long to complete authorization. Please try again.");

    const token = await exchangeAuthCode({
      clientId,
      code,
      codeVerifier: stored.codeVerifier,
      redirectUri: `${getBaseUrl(this.env)}/oauth`,
    });
    this.ctx.storage.kv.put<EtsyTokenSet>("token", token);
    this.ctx.storage.kv.put("expiredNotified", false);

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("token");
        throw err;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return true;
  }

  /** Returns a valid access token, refreshing (and persisting the rotated set) when near expiry. */
  async getAccessToken(): Promise<string> {
    const current = this.ctx.storage.kv.get<EtsyTokenSet>("token");
    if (!current) {
      throw new Error("Etsy credentials have not been configured for this account.");
    }
    if (current.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) {
      return current.accessToken;
    }
    const refreshed = await this.#refresh(current.refreshToken);
    return refreshed.accessToken;
  }

  #refresh(currentRefreshToken: string): Promise<EtsyTokenSet> {
    if (this.#inflightRefresh) return this.#inflightRefresh;
    const clientId = this.env.ETSY_KEYSTRING;
    if (!clientId) return Promise.reject(new Error("Etsy OAuth is not configured."));
    this.#inflightRefresh = refreshToken({ clientId, refreshToken: currentRefreshToken })
      .then(token => {
        this.ctx.storage.kv.put<EtsyTokenSet>("token", token);
        return token;
      })
      .finally(() => {
        this.#inflightRefresh = undefined;
      });
    return this.#inflightRefresh;
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<EtsyTokenSet>("token")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // Etsy exposes no token-revocation endpoint for public PKCE clients; drop our local copy.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl — maps resource URLs to gatekeeper DO classes.

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
  implements GatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  #api(): EtsyApi {
    const account = this.#account();
    return new EtsyApi({
      apiBase: getApiBase(this.env),
      keystring: this.env.ETSY_KEYSTRING ?? "",
      sharedSecret: this.env.ETSY_SHARED_SECRET ?? "",
      getToken: () => account.getAccessToken(),
    });
  }

  async describe(): Promise<AccountDescription> {
    const shopName = getShopName(this.env);
    try {
      const shop = await this.#api().getShop(await this.#api().resolveShopId(shopName));
      return {
        displayName: shop.title ?? shop.shopName,
        uniqueName: shop.shopName,
        avatar: { url: "" },
      };
    } catch {
      return { displayName: shopName, uniqueName: shopName, avatar: { url: "" } };
    }
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Etsy does not expose a verified sign-in email through the scopes granted here.
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.etsy.com" && parsed.hostname !== "etsy.com") {
      throw new Error(`Unsupported Etsy URL: ${url}`);
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const [kind, identifier] = segments;

    if (kind === "listing" && identifier && /^\d+$/.test(identifier)) {
      const props: EtsyGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "listing",
        listingId: identifier,
      };
      return { class: this.ctx.exports.EtsyGatekeeperImpl({ props }), resource: LISTING_RESOURCE };
    }

    if (kind === "shop" && identifier) {
      const props: EtsyGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "shop",
        shopName: identifier,
      };
      return { class: this.ctx.exports.EtsyGatekeeperImpl({ props }), resource: SHOP_RESOURCE };
    }

    throw new Error(`Unsupported Etsy URL: ${url}`);
  }

  async startResourceConfigurator(
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    const shopName = getShopName(this.env);
    const getApi = () => this.#api();

    if (resourceUrlPattern === SHOP_RESOURCE.urlPattern) {
      return {
        iframeHtml: ETSY_SHOP_CONFIGURATOR_HTML,
        ui: new RpcStub(new EtsyShopConfiguratorUI(getApi, shopName)),
      };
    }
    if (resourceUrlPattern === LISTING_RESOURCE.urlPattern) {
      return {
        iframeHtml: ETSY_LISTING_CONFIGURATOR_HTML,
        ui: new RpcStub(new EtsyListingConfiguratorUI(getApi, shopName)),
      };
    }
    throw new Error(`Unsupported Etsy resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return {
      url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}`,
    };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: EtsyVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.EtsyVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier — observer strategy B (ACL check on a single unit).
//
// Every binding is scoped to one shop (a listing inherits the shop's ACL for private data). Admitting
// an observer reduces to "can this account read the shop's private data?" — checked with the
// observer's OWN token by attempting an owner-only read. Full strategy hardening is Phase 2.

type EtsyVerifierProps = {
  userObjectId: string;
};

export interface EtsyVerifierApi extends GatekeeperUserVerifier {
  hasShopAccess(shopName: string): Promise<boolean>;
}

@validateRpc()
export class EtsyVerifier extends WorkerEntrypoint<Env, EtsyVerifierProps>
  implements EtsyVerifierApi {
  async hasShopAccess(shopName: string): Promise<boolean> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const account = this.ctx.exports.UserAccount.get(id);
    const api = new EtsyApi({
      apiBase: getApiBase(this.env),
      keystring: this.env.ETSY_KEYSTRING ?? "",
      sharedSecret: this.env.ETSY_SHARED_SECRET ?? "",
      getToken: () => account.getAccessToken(),
    });
    try {
      const shopId = await api.resolveShopId(shopName);
      // Owner-only read: listing the shop's receipts requires transactions_r on this shop.
      await api.listReceipts(shopId, { limit: 1 });
      return true;
    } catch (error) {
      if (error instanceof EtsyApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        return false;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — per-resource facet.

@validateRpc()
export class EtsyGatekeeperImpl extends DurableObject<Env, EtsyGatekeeperImplProps>
  implements Gatekeeper<EtsyShop | EtsyListing> {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  #api(): EtsyApi {
    const account = this.#account();
    return new EtsyApi({
      apiBase: getApiBase(this.env),
      keystring: this.env.ETSY_KEYSTRING ?? "",
      sharedSecret: this.env.ETSY_SHARED_SECRET ?? "",
      getToken: () => account.getAccessToken(),
    });
  }

  async #withApi<T>(fn: (api: EtsyApi) => Promise<T>): Promise<T> {
    const account = this.#account();
    try {
      return await fn(this.#api());
    } catch (error) {
      if (error instanceof EtsyApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error(
          "Etsy credentials have expired or been revoked. Please reconnect the account.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Resolves and caches the numeric shop id backing this binding. */
  async #getShopId(): Promise<string> {
    const cached = this.ctx.storage.kv.get<string>("shopId");
    if (cached) return cached;
    const shopId = await this.#withApi(async api => {
      if (this.ctx.props.resourceKind === "shop") {
        return api.resolveShopId(this.ctx.props.shopName ?? getShopName(this.env));
      }
      return api.getListingShopId(this.ctx.props.listingId!);
    });
    this.ctx.storage.kv.put("shopId", shopId);
    return shopId;
  }

  /**
   * A small in-process capability handed to session impls so they can reach the account-scoped API,
   * the resolved shop id, and the approval queue without exposing these as the DO's RPC surface.
   */
  #sessionCtx(): EtsySessionCtx {
    const gk = this;
    return {
      withApi(fn) {
        return gk.#withApi(fn);
      },
      getShopId() {
        return gk.#getShopId();
      },
      submit(queue, action, description) {
        return gk.#submit(queue, action, description);
      },
    };
  }

  #shopName(): string {
    return this.ctx.props.shopName ?? getShopName(this.env);
  }

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.resourceKind === "shop") {
      const shop = await this.#withApi(async api => api.getShop(await this.#getShopId()));
      return {
        url: shop.url || shopUrl(shop.shopName),
        title: shop.title ?? shop.shopName,
        snippet: `Etsy shop ${shop.shopName} (${shop.activeListingCount} active listings)`,
        suggestedBindingName: "ETSY_SHOP",
        tsType: "EtsyShop",
      };
    }
    const listingId = this.ctx.props.listingId!;
    const listing = await this.#withApi(api => api.getListing(listingId));
    return {
      url: listing.url || listingUrl(listingId),
      title: listing.title,
      snippet: `Etsy listing #${listing.listingId}: ${listing.state}`,
      suggestedBindingName: "ETSY_LISTING",
      tsType: "EtsyListing",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<EtsyShop | EtsyListing> {
    const queue = approvalQueue.dup();
    const ctx = this.#sessionCtx();
    if (this.ctx.props.resourceKind === "shop") {
      return new EtsyShopSessionImpl(ctx, queue, this.#shopName());
    }
    return new EtsyListingSessionImpl(ctx, queue, this.ctx.props.listingId!);
  }

  // --- action storage / approval ------------------------------------------

  #actionKey(id: number): string {
    return `action:${id}`;
  }

  #nextActionId(): number {
    const next = (this.ctx.storage.kv.get<number>("actionCounter") ?? 0) + 1;
    this.ctx.storage.kv.put("actionCounter", next);
    return next;
  }

  /** Allocates an id, stages the action, submits it for approval, marks it pending. */
  async #submit(
    approvalQueue: RpcStub<ApprovalQueue>,
    action: EtsyAction,
    description: { title: string; description: string },
  ): Promise<void> {
    const id = this.#nextActionId();
    this.ctx.storage.kv.put<StoredActionRecord>(this.#actionKey(id), { action, state: "pending" });
    try {
      await approvalQueue.submitAction(id, {
        title: description.title,
        description: description.description,
        implementsRevert: false,
        awaitDecision: true, // Phase 1 does not simulate; block the agent until the user decides.
      });
    } catch (error) {
      this.ctx.storage.kv.delete(this.#actionKey(id));
      throw error;
    }
  }

  #requireRecord(id: number): StoredActionRecord {
    const record = this.ctx.storage.kv.get<StoredActionRecord>(this.#actionKey(id));
    if (!record) throw new Error(`Unknown Etsy action: ${id}`);
    return record;
  }

  async applyAction(actionId: number): Promise<void> {
    const record = this.#requireRecord(actionId);
    if (record.state !== "pending") {
      throw new Error(`Etsy action ${actionId} is no longer pending.`);
    }
    const shopId = await this.#getShopId();
    const action = record.action;
    await this.#withApi(async api => {
      switch (action.type) {
        case "setTitle":
          return api.updateListing(shopId, action.listingId, { title: action.title });
        case "setDescription":
          return api.updateListing(shopId, action.listingId, { description: action.description });
        case "setState":
          return api.updateListing(shopId, action.listingId, { state: action.state });
        case "setAutoRenew":
          return api.updateListing(shopId, action.listingId, { should_auto_renew: action.enabled });
        case "setShopSection":
          return api.updateListing(shopId, action.listingId, { shop_section_id: action.shopSectionId });
        case "markShipped":
          return api.updateReceipt(shopId, action.receiptId, { was_shipped: true });
        case "markPaid":
          return api.updateReceipt(shopId, action.receiptId, { was_paid: true });
      }
    });
    this.ctx.storage.kv.put<StoredActionRecord>(this.#actionKey(actionId), {
      action,
      state: "applied",
    });
  }

  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(this.#actionKey(actionId));
  }

  async revertAction(
    _actionId: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    return {
      message:
        "Automatic revert is not implemented for Etsy actions yet. Undo the change in the Etsy " +
        "shop manager if needed.",
    };
  }

  // --- observers (strategy B) ---------------------------------------------

  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<EtsyVerifierApi>;
    const shopName = this.#shopName();
    if (!(await verifier.hasShopAccess(shopName))) {
      throw new Error(
        `This collaborator does not have access to the Etsy shop ${shopName}, so they cannot ` +
        `observe data this workspace read from it.`,
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

/**
 * In-process capability the gatekeeper hands to its session impls. These are closures over the DO's
 * private members, so the DO's own RPC surface stays exactly the `Gatekeeper` interface.
 */
type EtsySessionCtx = {
  withApi<T>(fn: (api: EtsyApi) => Promise<T>): Promise<T>;
  getShopId(): Promise<string>;
  submit(
    approvalQueue: RpcStub<ApprovalQueue>,
    action: EtsyAction,
    description: { title: string; description: string },
  ): Promise<void>;
};

// ---------------------------------------------------------------------------
// Cursor — paged observation over an offset-based Etsy list endpoint.

@validateRpc()
class EtsyCursor<T> extends RpcTarget implements Cursor<T> {
  #fetchPage: (offset: number, limit: number) => Promise<T[]>;
  #authorize: (items: T[]) => Promise<void>;
  #limit: number;
  #offset = 0;
  #exhausted = false;

  constructor(
    fetchPage: (offset: number, limit: number) => Promise<T[]>,
    authorize: (items: T[]) => Promise<void>,
    limit: number,
  ) {
    super();
    this.#fetchPage = fetchPage;
    this.#authorize = authorize;
    this.#limit = limit;
  }

  async next(): Promise<T[] | null> {
    if (this.#exhausted) return null;
    const items = await this.#fetchPage(this.#offset, this.#limit);
    if (items.length === 0) {
      this.#exhausted = true;
      return null;
    }
    this.#offset += items.length;
    if (items.length < this.#limit) this.#exhausted = true;
    await this.#authorize(items);
    return items;
  }
}

function pageLimit(options?: EtsyPageOptions): number {
  const requested = options?.resultsPerPage;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return 25;
  return Math.min(Math.floor(requested), 100);
}

// ---------------------------------------------------------------------------
// Session impls

@validateRpc()
class EtsyShopSessionImpl extends RpcTarget implements EtsyShop {
  #ctx: EtsySessionCtx;
  #queue: RpcStub<ApprovalQueue>;
  #shopName: string;

  constructor(ctx: EtsySessionCtx, queue: RpcStub<ApprovalQueue>, shopName: string) {
    super();
    this.#ctx = ctx;
    this.#queue = queue;
    this.#shopName = shopName;
  }

  [Symbol.dispose](): void {
    (this.#queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getInfo(): Promise<EtsyShopInfo> {
    const info = await this.#ctx.withApi(async api =>
      api.getShop(await this.#ctx.getShopId()),
    );
    await this.#queue.authorizeObservation({
      title: `Read Etsy shop ${info.shopName}`,
      description: `Read public metadata for the Etsy shop ${info.shopName}.`,
    });
    return info;
  }

  async listListings(options?: EtsyListingFilter): Promise<Cursor<EtsyListingSummary>> {
    const limit = pageLimit(options);
    return new EtsyCursor<EtsyListingSummary>(
      (offset, batch) =>
        this.#ctx.withApi(async api =>
          api.listListings(await this.#ctx.getShopId(), {
            state: options?.state,
            limit: batch,
            offset,
          }),
        ),
      items =>
        this.#queue.authorizeObservation({
          title: `List Etsy listings for ${this.#shopName}`,
          description: `Read a page of ${items.length} listing(s) from the Etsy shop ${this.#shopName}.`,
        }),
      limit,
    );
  }

  async getListing(listingId: string): Promise<EtsyListing> {
    return new EtsyListingSessionImpl(this.#ctx, this.#queue, listingId);
  }

  async listReceipts(options?: EtsyReceiptFilter): Promise<Cursor<EtsyReceiptSummary>> {
    const limit = pageLimit(options);
    return new EtsyCursor<EtsyReceiptSummary>(
      (offset, batch) =>
        this.#ctx.withApi(async api =>
          api.listReceipts(await this.#ctx.getShopId(), {
            isPaid: options?.isPaid,
            isShipped: options?.isShipped,
            limit: batch,
            offset,
          }),
        ),
      items =>
        this.#queue.authorizeObservation({
          title: `List Etsy orders for ${this.#shopName}`,
          description: `Read a page of ${items.length} order(s) from the Etsy shop ${this.#shopName}.`,
        }),
      limit,
    );
  }

  async getReceipt(receiptId: string): Promise<EtsyReceipt> {
    return new EtsyReceiptSessionImpl(this.#ctx, this.#queue, receiptId);
  }

  async listReviews(options?: EtsyPageOptions): Promise<Cursor<EtsyReview>> {
    const limit = pageLimit(options);
    return new EtsyCursor<EtsyReview>(
      (offset, batch) =>
        this.#ctx.withApi(async api =>
          api.listReviews(await this.#ctx.getShopId(), { limit: batch, offset }),
        ),
      items =>
        this.#queue.authorizeObservation({
          title: `List Etsy reviews for ${this.#shopName}`,
          description: `Read a page of ${items.length} review(s) for the Etsy shop ${this.#shopName}.`,
        }),
      limit,
    );
  }
}

@validateRpc()
class EtsyListingSessionImpl extends RpcTarget implements EtsyListing {
  #ctx: EtsySessionCtx;
  #queue: RpcStub<ApprovalQueue>;
  #listingId: string;

  constructor(ctx: EtsySessionCtx, queue: RpcStub<ApprovalQueue>, listingId: string) {
    super();
    this.#ctx = ctx;
    this.#queue = queue;
    this.#listingId = listingId;
  }

  [Symbol.dispose](): void {
    (this.#queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getDetails(): Promise<EtsyListingDetails> {
    const details = await this.#ctx.withApi(api => api.getListing(this.#listingId));
    await this.#queue.authorizeObservation({
      title: `Read Etsy listing #${this.#listingId}`,
      description: `Read details for Etsy listing #${this.#listingId} ("${details.title}").`,
    });
    return details;
  }

  async setTitle(title: string): Promise<void> {
    if (title.length > 140) throw new Error("Etsy listing titles are limited to 140 characters.");
    await this.#ctx.submit(
      this.#queue,
      { type: "setTitle", listingId: this.#listingId, title },
      {
        title: `Update Etsy listing #${this.#listingId} title`,
        description: `Set the title of Etsy listing #${this.#listingId} to:\n\n> ${title}`,
      },
    );
  }

  async setDescription(description: string): Promise<void> {
    await this.#ctx.submit(
      this.#queue,
      { type: "setDescription", listingId: this.#listingId, description },
      {
        title: `Update Etsy listing #${this.#listingId} description`,
        description: `Replace the description of Etsy listing #${this.#listingId}.`,
      },
    );
  }

  async activate(): Promise<void> {
    await this.#ctx.submit(
      this.#queue,
      { type: "setState", listingId: this.#listingId, state: "active" },
      {
        title: `Activate Etsy listing #${this.#listingId}`,
        description: `Publish Etsy listing #${this.#listingId} so it is visible for sale.`,
      },
    );
  }

  async deactivate(): Promise<void> {
    await this.#ctx.submit(
      this.#queue,
      { type: "setState", listingId: this.#listingId, state: "inactive" },
      {
        title: `Deactivate Etsy listing #${this.#listingId}`,
        description: `Hide Etsy listing #${this.#listingId} so it is no longer visible for sale.`,
      },
    );
  }

  async setAutoRenew(enabled: boolean): Promise<void> {
    await this.#ctx.submit(
      this.#queue,
      { type: "setAutoRenew", listingId: this.#listingId, enabled },
      {
        title: `${enabled ? "Enable" : "Disable"} auto-renew for Etsy listing #${this.#listingId}`,
        description: `Turn automatic renewal ${enabled ? "on" : "off"} for Etsy listing #${this.#listingId}.`,
      },
    );
  }

  async setShopSection(shopSectionId: number | null): Promise<void> {
    await this.#ctx.submit(
      this.#queue,
      { type: "setShopSection", listingId: this.#listingId, shopSectionId },
      {
        title: `Move Etsy listing #${this.#listingId}`,
        description:
          shopSectionId === null
            ? `Remove Etsy listing #${this.#listingId} from its shop section.`
            : `Move Etsy listing #${this.#listingId} into shop section ${shopSectionId}.`,
      },
    );
  }
}

@validateRpc()
class EtsyReceiptSessionImpl extends RpcTarget implements EtsyReceipt {
  #ctx: EtsySessionCtx;
  #queue: RpcStub<ApprovalQueue>;
  #receiptId: string;

  constructor(ctx: EtsySessionCtx, queue: RpcStub<ApprovalQueue>, receiptId: string) {
    super();
    this.#ctx = ctx;
    this.#queue = queue;
    this.#receiptId = receiptId;
  }

  [Symbol.dispose](): void {
    (this.#queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getDetails(): Promise<EtsyReceiptDetails> {
    const details = await this.#ctx.withApi(async api =>
      api.getReceipt(await this.#ctx.getShopId(), this.#receiptId),
    );
    await this.#queue.authorizeObservation({
      title: `Read Etsy order #${this.#receiptId}`,
      description: `Read details for Etsy order #${this.#receiptId}.`,
    });
    return details;
  }

  async markShipped(): Promise<void> {
    await this.#ctx.submit(
      this.#queue,
      { type: "markShipped", receiptId: this.#receiptId },
      {
        title: `Mark Etsy order #${this.#receiptId} shipped`,
        description: `Mark Etsy order #${this.#receiptId} as shipped.`,
      },
    );
  }

  async markPaid(): Promise<void> {
    await this.#ctx.submit(
      this.#queue,
      { type: "markPaid", receiptId: this.#receiptId },
      {
        title: `Mark Etsy order #${this.#receiptId} paid`,
        description: `Mark Etsy order #${this.#receiptId} as paid.`,
      },
    );
  }
}
