import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type AccountDescription,
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
  GraphApi,
  M365ApiError,
  OAUTH_SCOPES,
  accountUrl,
  authorizeUrl,
  exchangeAuthCode,
  normalizeEvent,
  normalizeMessage,
  normalizeMessageSummary,
  normalizeProfile,
  normalizeTask,
  normalizeTaskList,
  refreshAccessToken,
} from "./m365-api";
import type {
  M365AccountConfiguratorRpc,
} from "./configurator/account-configurator-types";
import type {
  M365Event,
  M365ListEventsOptions,
  M365ListMessagesOptions,
  M365Message,
  M365MessageSummary,
  M365Profile,
  M365Session,
  M365Task,
  M365TaskList,
} from "./types";
import TYPES_CODE from "./types.txt";
import M365_LOGO_SVG from "./m365-logo.svg";
import M365_ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  // Entra tenant: "common" (any org + personal), "organizations", or a specific tenant id.
  // The Board sets this at connect time; defaults to "common".
  M365_TENANT?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

type M365GatekeeperImplProps = {
  userObjectId: string;
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_EVENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const M365_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(M365_LOGO_SVG)}`;

// Whole-instance catch-all (matches any URL), like other single-tenant gatekeepers.
const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Microsoft 365 Account",
  description:
    "Read-only whole-account access: Outlook mail, calendar events, and Microsoft To Do tasks.",
  icon: { url: M365_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE];

// ---------------------------------------------------------------------------
// Static HTML served by the OAuth flow.

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #0078d4; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #0078d4; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #0078d4; font-size: 1.5rem; margin: 0 0 1rem 0;">Microsoft 365 Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please register an Entra ID (Azure AD) application and configure its client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// Small helpers

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
  // Both values are fixed-length random hex nonces, so length carries no secret. timingSafeEqual
  // also requires equal-length inputs.
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/m365");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getTenant(env: Env): string {
  return env.M365_TENANT?.trim() || "common";
}

function ensureConfigured(env: Env): asserts env is Env & { CLIENT_ID: string; CLIENT_SECRET: string } {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The Microsoft 365 gatekeeper is not configured.");
  }
}

function clampTop(top: number | undefined, fallback: number, max: number): number {
  if (top === undefined) return fallback;
  if (typeof top !== "number" || !Number.isInteger(top) || top < 1) {
    throw new Error("top must be a positive integer.");
  }
  return Math.min(top, max);
}

// ---------------------------------------------------------------------------
// HTTP handler — serves the OAuth flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Auth initiation: /<doId>/<initiationNonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const redirectUrl = new URL(authorizeUrl(getTenant(env)));
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("response_mode", "query");
      redirectUrl.searchParams.set("scope", begun.scopes.join(" "));
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      redirectUrl.searchParams.set("prompt", "select_account");
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // OAuth redirect callback.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        // Microsoft appends error/error_description when authorization fails AFTER a matched
        // redirect_uri (a redirect_uri mismatch never reaches this callback — it stops on
        // Microsoft's own page). Surface the exact AADSTS reason so the failure is diagnosable
        // instead of a generic dead-end; log it too (this worker's OAuth path is otherwise silent).
        const description = url.searchParams.get("error_description") ?? "";
        console.error(`M365 OAuth callback error: ${error} — ${description}`);
        const safe = (s: string) => s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
        return new Response(
          `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Authorization Failed</title></head>` +
          `<body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">` +
          `<div style="max-width: 560px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">` +
          `<h1 style="color: #d40000; font-size: 1.4rem; margin: 0 0 1rem 0;">Microsoft authorization failed</h1>` +
          `<p style="color: #555; line-height: 1.6; margin: 0 0 1rem 0;">Microsoft returned an error instead of completing the connection. Please restart the connection flow from Cloudflare OS.</p>` +
          `<p style="color: #333; margin: 0 0 0.25rem 0;"><strong>Error:</strong> <code>${safe(error)}</code></p>` +
          (description ? `<p style="color: #333; margin: 0;"><strong>Details:</strong> ${safe(description)}</p>` : "") +
          `</div></body></html>`,
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
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
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      displayName: "Microsoft 365",
      url: "https://www.microsoft.com/microsoft-365",
      logo: { url: M365_LOGO_URL },
      color: "#eaf3fb",
      tagline: "Read your Outlook mail, calendar, and tasks",
      description:
        "Connect your Microsoft 365 account so Cloudflare OS can read your Outlook mail, calendar " +
        "events, and Microsoft To Do tasks. Build agents that triage your inbox, summarize your " +
        "day, or surface upcoming deadlines. Read-only for now.",
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
// UserAccount DO — stores OAuth credentials and refreshes access tokens.

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
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

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    return { oauthNonce, scopes: OAUTH_SCOPES };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    ensureConfigured(this.env);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = await exchangeAuthCode(
      getTenant(this.env), code, this.env.CLIENT_ID, this.env.CLIENT_SECRET, `${getBaseUrl(this.env)}/oauth`);
    if (!grant.refreshToken) {
      throw new Error("Microsoft did not return a refresh token. Ensure the 'offline_access' scope is granted.");
    }

    this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    this.ctx.storage.kv.put("scopes", grant.scopes);
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
        this.ctx.storage.kv.delete("refreshToken");
        this.ctx.storage.kv.delete("accessToken");
        throw err;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return true;
  }

  async getAccessToken(): Promise<string> {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    const expiresAt = this.ctx.storage.kv.get<number>("accessTokenExpiresAt") ?? 0;
    if (token && Date.now() < expiresAt - ACCESS_TOKEN_SAFETY_MS) {
      return token;
    }

    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) {
      throw new Error("Microsoft 365 credentials have not been configured for this account.");
    }
    ensureConfigured(this.env);

    let grant;
    try {
      grant = await refreshAccessToken(getTenant(this.env), refreshToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
    } catch (err) {
      if (err instanceof M365ApiError && (err.isAuthError || err.status === 400)) {
        await this.noteCredentialsExpired();
      }
      throw err;
    }

    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("accessTokenExpiresAt", Date.now() + grant.expiresIn * 1000);
    if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    if (grant.scopes.length > 0) this.ctx.storage.kv.put("scopes", grant.scopes);
    return grant.accessToken;
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    // Microsoft exposes no simple delegated-token revocation endpoint; drop the local credentials.
    // The user can remove the app from https://myapps.microsoft.com or their account settings.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #withApi<T>(fn: (api: GraphApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const api = new GraphApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof M365ApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("Microsoft 365 credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const user = await api.getCurrentUser();
      return {
        displayName: user.displayName ?? user.userPrincipalName ?? user.id,
        uniqueName: user.mail ?? user.userPrincipalName ?? user.id,
        avatar: { url: "" },
      };
    });
  }

  /** M365 is not offered as a sign-in identity provider here. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // Only whole-account access is supported in Phase 1.
    const props: M365GatekeeperImplProps = { userObjectId: this.ctx.props.userObjectId };
    return { class: this.ctx.exports.M365GatekeeperImpl({ props }), resource: ACCOUNT_RESOURCE };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported Microsoft 365 resource configurator type: ${resourceUrlPattern}`);
    }
    const getToken = async () => await this.#userAccount().getAccessToken();
    return {
      iframeHtml: M365_ACCOUNT_CONFIGURATOR_HTML,
      ui: new RpcStub(new M365AccountConfiguratorUI(getToken)),
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#userAccount().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * Mint a verifier representing this account. M365 uses the "private-only" observer strategy (see
   * M365GatekeeperImpl.addObserver): a personal/corporate mailbox is too sensitive to expose to
   * Gadget collaborators, and there is no per-observer access oracle. The verifier therefore carries
   * no identity and is never consulted — but the overseer mints one on every open, so it must exist
   * and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.M365Verifier({});
  }
}

// ---------------------------------------------------------------------------
// Verifier — trivial (private-only strategy: never consulted, but must exist).

@validateRpc()
export class M365Verifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Configurator UI helper — keep the token getter out of the RPC surface.

const configuratorTokenGetters = new WeakMap<object, () => Promise<string>>();

@validateRpc()
class M365AccountConfiguratorUI extends RpcTarget implements M365AccountConfiguratorRpc {
  constructor(getToken: () => Promise<string>) {
    super();
    configuratorTokenGetters.set(this, getToken);
  }

  async resourceUrl(): Promise<string> {
    const getToken = configuratorTokenGetters.get(this);
    if (!getToken) throw new Error("Microsoft 365 configurator is not initialized.");
    const user = await new GraphApi(getToken).getCurrentUser();
    return accountUrl(user);
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl DO — per-account instance, runs as a facet of the Overseer.

@validateRpc()
export class M365GatekeeperImpl extends DurableObject<Env, M365GatekeeperImplProps>
  implements Gatekeeper<M365Session> {

  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  // Private so the generic helper stays off the RPC surface. The concrete public read methods below
  // are the gatekeeper's data layer; M365SessionImpl wraps each with an approval-queue observation.
  #withApi = async <T>(fn: (api: GraphApi) => Promise<T>): Promise<T> => {
    const account = this.#userAccount();
    const api = new GraphApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof M365ApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("Microsoft 365 credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  };

  async describe(): Promise<ResourceDescription> {
    const user = await this.#withApi(api => api.getCurrentUser());
    const name = user.displayName ?? user.userPrincipalName ?? "Microsoft 365";
    return {
      url: accountUrl(user),
      title: user.displayName ? `${name}'s Microsoft 365` : "Microsoft 365 Account",
      snippet: "Read-only whole-account access: Outlook mail, calendar, and Microsoft To Do tasks.",
      suggestedBindingName: "M365_ACCOUNT",
      tsType: "M365Session",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  // -------------------------------------------------------------------------
  // Read layer (concrete types → valid RPC surface). Callers authorize the observation separately.

  async getProfile(): Promise<M365Profile> {
    return normalizeProfile(await this.#withApi(api => api.getCurrentUser()));
  }

  async listMessages(folder: string, top: number, search: string | undefined): Promise<M365MessageSummary[]> {
    const raw = await this.#withApi(api => api.listMessages(folder, top, search));
    return raw.map(normalizeMessageSummary);
  }

  async getMessage(id: string): Promise<M365Message> {
    return normalizeMessage(await this.#withApi(api => api.getMessage(id)));
  }

  async listEvents(startDateTime: string, endDateTime: string, top: number): Promise<M365Event[]> {
    const raw = await this.#withApi(api => api.listEvents(startDateTime, endDateTime, top));
    return raw.map(normalizeEvent);
  }

  async getEvent(id: string): Promise<M365Event> {
    return normalizeEvent(await this.#withApi(api => api.getEvent(id)));
  }

  async listTaskLists(): Promise<M365TaskList[]> {
    const raw = await this.#withApi(api => api.listTaskLists());
    return raw.map(normalizeTaskList);
  }

  async listTasks(listId: string, top: number): Promise<M365Task[]> {
    const raw = await this.#withApi(api => api.listTasks(listId, top));
    return raw.map(normalizeTask);
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<M365Session> {
    return new M365SessionImpl(this, approvalQueue.dup());
  }

  /**
   * Observer strategy: private-only. An Outlook mailbox / calendar / task list is exactly the kind
   * of restricted, access-controlled data the information-flow model exists to protect, and there is
   * no per-observer access oracle for a whole account. So a Gadget bound to this account cannot be
   * shared with observers: addObserver throws, and removeObserver is a no-op.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "A Microsoft 365 account binding cannot be shared: collaborators cannot observe data read " +
      "from your mailbox, calendar, or tasks.");
  }
  async removeObserver(_id: string): Promise<void> {}

  // Read-only gatekeeper: no actions are ever submitted, so these are never called.
  async applyAction(actionId: number): Promise<void> {
    throw new Error(`Unknown action: ${actionId}`);
  }
  async rejectAction(_actionId: number): Promise<void | { restart?: boolean }> {}
  async revertAction(_actionId: number): Promise<void> {
    throw new Error("Revert not implemented: the Microsoft 365 gatekeeper is read-only.");
  }
}

// ---------------------------------------------------------------------------
// SessionImpl — the read-only RPC interface exposed to the Gadget.

function disposeQueue(queue: RpcStub<ApprovalQueue>): void {
  (queue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
}

@validateRpc()
class M365SessionImpl extends RpcTarget implements M365Session {
  #gk: M365GatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;

  constructor(gk: M365GatekeeperImpl, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    disposeQueue(this.#queue);
  }

  async getProfile(): Promise<M365Profile> {
    const profile = await this.#gk.getProfile();
    await this.#queue.authorizeObservation({
      title: "Read Microsoft 365 profile",
      description: `Read the connected Microsoft 365 account's profile (${profile.displayName ?? profile.email ?? profile.id}).`,
    });
    return profile;
  }

  @skipRpcValidation()
  async listMessages(options?: M365ListMessagesOptions): Promise<M365MessageSummary[]> {
    const folder = (options?.folder ?? "inbox").trim() || "inbox";
    const top = clampTop(options?.top, 25, 50);
    const search = typeof options?.search === "string" && options.search.trim() ? options.search.trim() : undefined;
    const messages = await this.#gk.listMessages(folder, top, search);
    await this.#queue.authorizeObservation({
      title: search ? `Search mail for "${search}"` : `Read ${folder} mail`,
      description: search
        ? `Searched Outlook mail for "${search}" (${messages.length} result(s)).`
        : `Read ${messages.length} message(s) from the "${folder}" folder.`,
    });
    return messages;
  }

  async getMessage(id: string): Promise<M365Message> {
    if (typeof id !== "string" || id.trim() === "") throw new Error("getMessage(): id must be a non-empty string.");
    const message = await this.#gk.getMessage(id);
    await this.#queue.authorizeObservation({
      title: `Read email "${message.subject ?? "(no subject)"}"`,
      description: `Read the full body of an Outlook message from ${message.from?.address ?? "unknown sender"}.`,
    });
    return message;
  }

  @skipRpcValidation()
  async listEvents(options?: M365ListEventsOptions): Promise<M365Event[]> {
    const now = new Date();
    const start = options?.startDateTime ?? now.toISOString();
    const end = options?.endDateTime ?? new Date(now.getTime() + DEFAULT_EVENT_WINDOW_MS).toISOString();
    const top = clampTop(options?.top, 25, 50);
    const events = await this.#gk.listEvents(start, end, top);
    await this.#queue.authorizeObservation({
      title: "Read calendar events",
      description: `Read ${events.length} calendar event(s) between ${start} and ${end}.`,
    });
    return events;
  }

  async getEvent(id: string): Promise<M365Event> {
    if (typeof id !== "string" || id.trim() === "") throw new Error("getEvent(): id must be a non-empty string.");
    const event = await this.#gk.getEvent(id);
    await this.#queue.authorizeObservation({
      title: `Read calendar event "${event.subject ?? "(untitled)"}"`,
      description: `Read details for a calendar event scheduled at ${event.start ?? "an unknown time"}.`,
    });
    return event;
  }

  async listTaskLists(): Promise<M365TaskList[]> {
    const lists = await this.#gk.listTaskLists();
    await this.#queue.authorizeObservation({
      title: "Read To Do lists",
      description: `Read ${lists.length} Microsoft To Do task list(s).`,
    });
    return lists;
  }

  @skipRpcValidation()
  async listTasks(listId: string, top?: number): Promise<M365Task[]> {
    if (typeof listId !== "string" || listId.trim() === "") throw new Error("listTasks(): listId must be a non-empty string.");
    const cap = clampTop(top, 50, 100);
    const tasks = await this.#gk.listTasks(listId, cap);
    await this.#queue.authorizeObservation({
      title: "Read To Do tasks",
      description: `Read ${tasks.length} task(s) from a Microsoft To Do list.`,
    });
    return tasks;
  }
}
