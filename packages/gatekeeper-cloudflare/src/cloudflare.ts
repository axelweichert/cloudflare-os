import { WorkerEntrypoint, DurableObject, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperVendor as GatekeeperVendorIface, Gatekeeper, GatekeeperUserVerifier, VendorDescription,
  GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription,
  SupportedResource, ResourceConfiguratorFrame, ResourceDescription, ApprovalQueue, ActionKind,
  stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { verifyToken, listAccounts } from "./cloudflare-api";
import {
  OBSERVABILITY_RESOURCES,
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
  accountObservabilityUrl,
  workerObservabilityUrl,
  parseObservabilityResourceUrl,
} from "./resources.js";
import { CloudflareObservabilityApi, deniesAccess } from "./observability-api.js";
import { CloudflareObservabilitySessionImpl } from "./observability-session.js";
import {
  CloudflareAccountConfiguratorUI,
  CloudflareWorkerConfiguratorUI,
} from "./cloudflare-configurators.js";
import ACCOUNT_CONFIGURATOR_HTML from "./generated/cloudflare-account-configurator-ui.txt";
import WORKER_CONFIGURATOR_HTML from "./generated/cloudflare-worker-configurator-ui.txt";
import type { CloudflareObservabilitySession } from "./types.js";
import { VENDOR_ID } from "./vendor.js";
import TYPES_CODE from "./types.txt";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare", vendorId: VENDOR_ID,
});

// OWL-1618: this gatekeeper connects a Cloudflare account by pasting an API token (the proven UniFi
// pattern), not by OAuth redirect. Cloudflare's self-managed OAuth does not expose the AI Gateway
// scopes this integration needs in its consent catalog; the same capability exists as API-token
// permissions (AI Gateway Read + Run, Account Settings Read, Workers Observability Read). The stored
// token is a long-lived bearer credential used directly against api.cloudflare.com.

// A short-lived nonce stored in UserAccount KV, protecting the connect link (same shape as UniFi).
type StoredNonce = { value: string; expiresAt: number };
type StoredCredentials = { apiToken: string };

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;

// Official Cloudflare logomark (orange cloud on a transparent background), as a data URI so it can
// be rendered directly as the vendor/account avatar.
const CLOUDFLARE_LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 209.51 94.74">` +
  `<path fill="#f4801f" d="M143.05,93.42l1.07-3.71c1.27-4.41.8-8.48-1.34-11.48-2-2.76-5.26-4.38-9.25-4.57L58,72.7a1.47,1.47,0,0,1-1.35-2,2,2,0,0,1,1.75-1.34l76.26-1c9-.41,18.84-7.75,22.27-16.71l4.34-11.36a2.68,2.68,0,0,0,.18-1,3.31,3.31,0,0,0-.06-.54,49.67,49.67,0,0,0-95.49-5.14,22.35,22.35,0,0,0-35,23.42A31.73,31.73,0,0,0,.34,93.45a1.47,1.47,0,0,0,1.45,1.27l139.49,0h0A1.83,1.83,0,0,0,143.05,93.42Z"/>` +
  `<path fill="#f9ab41" d="M168.22,41.15q-1,0-2.1.06a.88.88,0,0,0-.32.07,1.17,1.17,0,0,0-.76.8l-3,10.26c-1.28,4.41-.81,8.48,1.34,11.48a11.65,11.65,0,0,0,9.24,4.57l16.11,1a1.44,1.44,0,0,1,1.14.62,1.5,1.5,0,0,1,.17,1.37,2,2,0,0,1-1.75,1.34l-16.73,1c-9.09.42-18.88,7.75-22.31,16.7l-1.21,3.16a.9.9,0,0,0,.79,1.22h57.63A1.55,1.55,0,0,0,208,93.63a41.34,41.34,0,0,0-39.76-52.48Z"/>` +
  `</svg>`,
);

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

type Env = Cloudflare.Env & {
  BASE_URL?: string;
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/cloudflare");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// All observability resources are grantable by any account-scoped token that carries the required
// read permissions, so a connected token is treated as granting the whole set.
const ALL_RESOURCE_PATTERNS = OBSERVABILITY_RESOURCES.map(r => r.urlPattern);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Cloudflare</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 560px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #f4801f; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #f4801f; }
  details ol { padding-left: 1.25rem; }
  details li { margin: 0.35rem 0; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #f4801f; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #d96e12; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect Cloudflare</h1>
    <p>Paste a Cloudflare API token. Cloudflare OS uses it to read your accounts, AI Gateway, and Workers Observability (read-only).</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <label for="apiToken">Cloudflare API Token</label>
      <input id="apiToken" name="apiToken" type="password" required placeholder="xxxxxxxx..." autofocus>
      <div class="hint">Stored encrypted and never shown again. Revoke it any time from the Cloudflare dashboard.</div>

      <details>
        <summary>How to create an API token</summary>
        <ol>
          <li>Sign in to the <b>Cloudflare dashboard</b> and open <b>My Profile → API Tokens</b>.</li>
          <li>Click <b>Create Token → Create Custom Token</b>.</li>
          <li>Add these permissions (all <b>Read</b>, plus AI Gateway <b>Run</b>):
            <ul>
              <li><b>Account</b> → <b>AI Gateway</b> → Read</li>
              <li><b>Account</b> → <b>AI Gateway</b> → Run</li>
              <li><b>Account</b> → <b>Account Settings</b> → Read</li>
              <li><b>Account</b> → <b>Workers Observability</b> → Read</li>
            </ul>
          </li>
          <li>Scope it to the account(s) you want, create it, and copy the token.</li>
          <li>Paste it above.</li>
        </ol>
      </details>

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Connected</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 2rem;">
<script type="text/javascript">window.close();</script>
<h2 style="color:#f4801f;">Connected!</h2>
<p>Your Cloudflare account has been linked to Cloudflare OS. You may close this tab.</p></body></html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Connection Link Expired</h1>
<p>This connection link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
<button onclick="window.close()">Close</button></body></html>`;

/** Main HTTP entrypoint — serves the token connect form and accepts its POST. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Connect URL: /<doId>/<nonce>
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        if (!await stub.verifyNonceWithoutConsuming(nonce)) {
          return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        return new Response(CONNECT_FORM_HTML({ actionUrl: req.url }), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST") {
        let formData: FormData;
        try {
          formData = await req.formData();
        } catch {
          return new Response("Invalid form submission.", { status: 400 });
        }
        const tokenInput = String(formData.get("apiToken") ?? "").trim();
        if (!tokenInput) {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: "An API token is required." }), {
            headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400,
          });
        }
        const result = await stub.completeConnection(nonce, tokenInput);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (result.kind === "error") {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }), {
            headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400,
          });
        }
        return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    }
    return new Response("Not Found", { status: 404 });
  },
};

// =======================================================================================

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Cloudflare",
      url: "https://cloudflare.com",
      logo: { url: CLOUDFLARE_LOGO_URL },
      color: "#fbece0",
      tagline: "Use AI Gateway and inspect Workers Observability",
      description:
          "Connect a Cloudflare account with an API token to use your own AI Gateway credits for " +
          "usage beyond the free tier, and to inspect Workers Observability: logs, invocations, " +
          "traces, and aggregate metrics. Read-only.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return OBSERVABILITY_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

type CompleteConnectionResult =
  | { kind: "ok" }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string) {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
      this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string) {
    this.ctx.storage.kv.put<boolean>("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  /** Validate the nonce without consuming it (so the user can resubmit if verification fails). */
  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt) return false;
    return constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(nonce: string, apiToken: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    // Validate the token can actually authenticate before we store it.
    let valid = false;
    try {
      valid = await verifyToken(apiToken);
    } catch (e: any) {
      return { kind: "error", message: `Unable to reach the Cloudflare API: ${e?.message ?? e}` };
    }
    if (!valid) {
      return { kind: "error", message: "Cloudflare rejected the API token. It may be invalid, revoked, or inactive." };
    }

    // Consume the nonce now that we've validated.
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.put<StoredCredentials>("credentials", { apiToken });

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      this.ctx.storage.kv.delete("credentials");
      return { kind: "error", message: "Connection callback expired. Please restart." };
    }

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      try {
        await callback.credentialsRestored();
      } catch (e: any) {
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    } else {
      try {
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props: { userObjectId: this.ctx.id.toString() } }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  hasCredentials() {
    return this.ctx.storage.kv.get<StoredCredentials>("credentials") !== undefined;
  }

  /**
   * Returns the stored Cloudflare API token, or null if the account isn't connected. Named
   * getAccessToken so the observability API/verifier and the AI Gateway billing service — which take
   * a `() => Promise<string | null>` token getter — work unchanged against the pasted API token.
   */
  async getAccessToken(): Promise<string | null> {
    return this.ctx.storage.kv.get<StoredCredentials>("credentials")?.apiToken ?? null;
  }

  async alarm(): Promise<void> {
    // Drop the account if the connect flow never completed.
    if (!this.hasCredentials()) this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements CloudflareGatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async describe(): Promise<AccountDescription> {
    const token = await this.#account().getAccessToken();
    let displayName = "Cloudflare";
    let uniqueName = "Cloudflare account";
    if (token) {
      try {
        const accounts = await listAccounts(token);
        if (accounts.length === 1) {
          displayName = `Cloudflare (${accounts[0].accountName})`;
          uniqueName = accounts[0].accountName;
        } else if (accounts.length > 1) {
          displayName = `Cloudflare (${accounts.length} accounts)`;
          uniqueName = `Cloudflare (${accounts.length} accounts)`;
        }
      } catch {
        // Fall back to defaults if enumeration fails.
      }
    }
    return {
      displayName,
      uniqueName,
      avatar: { url: CLOUDFLARE_LOGO_URL },
      grantedResourceUrlPatterns: token ? ALL_RESOURCE_PATTERNS : [],
    };
  }

  /** This gatekeeper connects via API token and does not provide sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    // A connected API token carries its permissions up-front, so every supported resource is already
    // grantable; there is no incremental consent step to run.
    return {};
  }

  async getUsableAccessToken(): Promise<string | null> {
    return this.#account().getAccessToken();
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return OBSERVABILITY_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = parseObservabilityResourceUrl(url);
    return {
      class: this.ctx.exports.CloudflareObservabilityGatekeeper({
        props: { userObjectId: this.ctx.props.userObjectId, ...parsed },
      }),
      resource: parsed.workerName ? WORKER_OBSERVABILITY_RESOURCE : ACCOUNT_OBSERVABILITY_RESOURCE,
    };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const getToken = () => this.#account().getAccessToken();
    if (resourceUrlPattern === ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern) {
      return {
        iframeHtml: ACCOUNT_CONFIGURATOR_HTML,
        ui: new RpcStub(new CloudflareAccountConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === WORKER_OBSERVABILITY_RESOURCE.urlPattern) {
      return {
        iframeHtml: WORKER_CONFIGURATOR_HTML,
        ui: new RpcStub(new CloudflareWorkerConfiguratorUI(getToken)),
      };
    }
    throw new Error(`Unsupported Cloudflare resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const nonce = generateNonce();
    await this.#account().prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CloudflareVerifier({
      props: { userObjectId: this.ctx.props.userObjectId },
    });
  }
}

/** Vendor-specific verifier methods trusted only after the overseer's same-vendor handoff. */
export interface CloudflareVerifierApi extends GatekeeperUserVerifier {
  /** Check whether this connected Cloudflare account can read the bound telemetry resource. */
  hasObservabilityAccess(accountId: string, workerName?: string): Promise<boolean>;
}

/** Verifies an observer's access using that observer's own Cloudflare credentials. */
@validateRpc()
export class CloudflareVerifier extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
    implements CloudflareVerifierApi {
  async hasObservabilityAccess(accountId: string, workerName?: string): Promise<boolean> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const account = this.ctx.exports.UserAccount.get(id);
    try {
      await new CloudflareObservabilityApi(
        () => account.getAccessToken(), accountId, workerName,
      ).listKeys({ limit: 1 });
      return true;
    } catch (error) {
      if (deniesAccess(error)) {
        logger.info("observer denied access to bound telemetry", {
          event: "observer.denied", status: error.status,
        });
        return false;
      }
      throw error;
    }
  }
}

type CloudflareObservabilityGatekeeperProps = {
  userObjectId: string;
  accountId: string;
  workerName?: string;
};

@validateRpc()
export class CloudflareObservabilityGatekeeper
    extends DurableObject<Env, CloudflareObservabilityGatekeeperProps>
    implements Gatekeeper<CloudflareObservabilitySession> {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  #api(): CloudflareObservabilityApi {
    const account = this.#account();
    return new CloudflareObservabilityApi(
      () => account.getAccessToken(),
      this.ctx.props.accountId,
      this.ctx.props.workerName,
    );
  }

  async describe(): Promise<ResourceDescription> {
    const workerName = this.ctx.props.workerName;
    return {
      url: workerName
        ? workerObservabilityUrl(this.ctx.props.accountId, workerName)
        : accountObservabilityUrl(this.ctx.props.accountId),
      title: workerName ? `${workerName} observability` : "Workers Observability",
      snippet: workerName
        ? `Read logs, invocations, metrics, and traces for ${workerName}.`
        : "Read logs, invocations, metrics, and traces across this Cloudflare account.",
      suggestedBindingName: workerName ? "WORKER_OBSERVABILITY" : "CLOUDFLARE_OBSERVABILITY",
      tsType: "CloudflareObservabilitySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CloudflareObservabilitySession> {
    const target = this.ctx.props.workerName
      ? `Worker ${this.ctx.props.workerName}`
      : `Cloudflare account ${this.ctx.props.accountId}`;
    return new CloudflareObservabilitySessionImpl(this.#api(), approvalQueue.dup(), target);
  }

  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    // The overseer only hands a verifier back to its own vendor, making this strategy-B ACL check
    // authoritative for the one account or Worker represented by the binding.
    const verifier = user as unknown as Fetcher<CloudflareVerifierApi>;
    if (!(await verifier.hasObservabilityAccess(this.ctx.props.accountId, this.ctx.props.workerName))) {
      throw new Error("This collaborator does not have access to the bound Workers telemetry.");
    }
  }

  async removeObserver(_id: string): Promise<void> {
    // Strategy B verifies on each admission and retains no observer state to remove.
  }

  async applyAction(_action: number): Promise<void> { throw new Error("This resource is read-only."); }
  async rejectAction(_action: number): Promise<void> { throw new Error("This resource is read-only."); }
  async revertAction(_action: number): Promise<void> { throw new Error("This resource is read-only."); }
}
