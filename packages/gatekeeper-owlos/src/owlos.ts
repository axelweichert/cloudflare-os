import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ActionKind,
  type ApprovalQueue,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { OwlosClient, OwlosError, verifyCredentials, type OwlosCredentials } from "./owlos-api";
import type { OwlosSession } from "./types";
import TYPES_CODE from "./types.txt";

// ---------------------------------------------------------------------------
// Config & nonce helpers (identical shape to gk-unifi / gk-cloudflare)

type Env = Cloudflare.Env & {
  BASE_URL?: string;
};

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/owlos");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Branding & resource

// owlOS owl mark, inline SVG data URL so it renders at the same weight as other vendor logos.
// Theme colour #677979 taken from the live instance's <meta name="theme-color">.
const OWLOS_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<rect width="512" height="512" rx="96" fill="#677979"/>\
<circle cx="196" cy="220" r="60" fill="#fff"/><circle cx="316" cy="220" r="60" fill="#fff"/>\
<circle cx="196" cy="220" r="26" fill="#677979"/><circle cx="316" cy="220" r="26" fill="#677979"/>\
<path d="M256 250 l26 44 h-52 z" fill="#f0a500"/>\
</svg>`;

const OWLOS_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(OWLOS_LOGO_SVG)}`;
const OWLOS_ICON: AvatarImage = { url: OWLOS_LOGO_URL };

// A connected owlOS instance is one whole-workspace resource. owlOS instances live under
// *.owl-os.cloud (and custom domains); the pattern matches the common case and getGatekeeperClassFor
// resolves any connected https URL to this single resource.
const WORKSPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.owl-os.cloud/*",
  title: "owlOS Workspace",
  description:
    "Access an owlOS Cloud ERP workspace: customers, quotes/orders (Angebote/Aufträge), and invoices (Rechnungen).",
  icon: OWLOS_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [WORKSPACE_RESOURCE];

// ---------------------------------------------------------------------------
// Connect-flow HTML (two fields: instance URL + API token)

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const CONNECT_FORM_HTML = (params: { actionUrl: string; instanceUrl?: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect owlOS</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 560px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #677979; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #677979; }
  details ol { padding-left: 1.25rem; }
  details li { margin: 0.35rem 0; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #677979; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #52605f; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect owlOS</h1>
    <p>Point Cloudflare OS at your owlOS instance and paste an API token. owlOS runs in your own Cloudflare account, so both are needed.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <label for="instanceUrl">owlOS Instance URL</label>
      <input id="instanceUrl" name="instanceUrl" type="url" required placeholder="https://acme.owl-os.cloud" value="${escapeHtml(params.instanceUrl ?? "")}" autofocus>
      <div class="hint">The base URL of your workspace, e.g. <code>https://acme.owl-os.cloud</code>.</div>

      <label for="apiToken">owlOS API Token</label>
      <input id="apiToken" name="apiToken" type="password" required placeholder="xxxxxxxx...">
      <div class="hint">Stored encrypted and never shown again. Revoke it any time from your owlOS settings.</div>

      <details>
        <summary>How to create an API token</summary>
        <ol>
          <li>Sign in to your owlOS instance.</li>
          <li>Open <b>Settings → API Tokens</b> and create a token for Cloudflare OS.</li>
          <li>Copy the token and paste it above, along with your instance URL.</li>
        </ol>
      </details>

      <button type="submit">Connect</button>
    </form>
  </div>
</body>
</html>`;

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Connected</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <script>window.close();</script>
  <h2 style="color: #677979;">Connected!</h2>
  <p>Your owlOS workspace has been linked to Cloudflare OS. You may close this tab.</p>
</body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h2 style="color: #d97706;">Connection Link Expired</h2>
  <p>This connection link is invalid or has expired. Please return to Cloudflare OS and start over.</p>
</body>
</html>`;

// ---------------------------------------------------------------------------
// fetch handler: serves the connect form and accepts its POST

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
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
        if (!(await stub.verifyNonceWithoutConsuming(nonce))) {
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
        const instanceUrl = String(formData.get("instanceUrl") ?? "").trim();
        const apiToken = String(formData.get("apiToken") ?? "").trim();
        if (!instanceUrl || !apiToken) {
          return new Response(
            CONNECT_FORM_HTML({
              actionUrl: req.url,
              instanceUrl,
              error: "Both an instance URL and an API token are required.",
            }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        const result = await stub.completeConnection(nonce, instanceUrl, apiToken);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (result.kind === "error") {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, instanceUrl, error: result.message }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }
        return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
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
      displayName: "owlOS",
      url: "https://owl-os.cloud",
      logo: OWLOS_ICON,
      tagline: "Connect your owlOS Cloud ERP workspace.",
      description:
        "Connect an owlOS Cloud ERP instance so Cloudflare OS can work with your customers, " +
        "quotes/orders, and invoices. owlOS runs in your own Cloudflare account; connect it with " +
        "your instance URL and an API token.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores {instanceUrl, apiToken, authScheme} for a connected workspace

interface StoredNonce {
  value: string;
  expiresAt: number;
}

type CompleteConnectionResult =
  | { kind: "ok" }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<OwlosCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + NONCE_LIFETIME_MS,
    });
  }

  /** Validates the nonce but does not consume it (so the user can resubmit if validation fails). */
  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt) return false;
    return constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(nonce: string, instanceUrl: string, apiToken: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    // Verify the instance is a real owlOS ERP and the token authenticates, before storing anything.
    let creds: OwlosCredentials;
    try {
      creds = await verifyCredentials(instanceUrl, apiToken);
    } catch (e: any) {
      const msg = e instanceof OwlosError ? e.message : `Unable to verify owlOS instance: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    // Consume the nonce now that we've validated.
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.put<OwlosCredentials>("credentials", creds);

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
        const props: OwlosUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.OwlosUserImpl({ props }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): OwlosCredentials {
    const creds = this.ctx.storage.kv.get<OwlosCredentials>("credentials");
    if (!creds) throw new Error("owlOS credentials are not configured for this account.");
    return creds;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<OwlosCredentials>("credentials")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl

type OwlosUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class OwlosUserImpl extends WorkerEntrypoint<Env, OwlosUserImplProps> implements GatekeeperUser {
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<OwlosCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    let uniqueName = "owlOS Workspace";
    try {
      const creds = await this.#getCreds();
      uniqueName = new URL(creds.instanceUrl).host;
    } catch {
      // Fall back to the default.
    }
    return { displayName: `owlOS (${uniqueName})`, uniqueName, avatar: OWLOS_ICON };
  }

  /** This gatekeeper connects via API token and does not provide sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== WORKSPACE_RESOURCE.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    const creds = await this.#getCreds();
    return {
      iframeHtml: WORKSPACE_CONFIGURATOR_HTML,
      ui: new RpcStub(new WorkspaceConfiguratorUI(creds.instanceUrl)),
    };
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // The token is whole-workspace, so every URL resolves to the one workspace resource. Validate
    // the URL is well-formed http(s) so a nonsensical binding fails early.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported URL scheme for owlOS: ${parsed.protocol}`);
      }
    } catch (e: any) {
      throw new Error(`Invalid owlOS URL "${url}": ${e?.message ?? e}`, { cause: e });
    }
    return {
      class: this.ctx.exports.OwlosGatekeeperImpl({ props: { userObjectId: this.ctx.props.userObjectId } }),
      resource: WORKSPACE_RESOURCE,
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).prepareReconnect(nonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /**
   * Mint a verifier. owlOS uses the low-stakes observer strategy: a workspace token is
   * all-or-nothing and there is no per-user ACL oracle to verify an observer against, so the
   * verifier carries no identity and is never consulted — but the overseer mints one on every open,
   * so it must exist and not throw. (Same as gk-unifi.)
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.OwlosVerifier({});
  }
}

@validateRpc()
export class OwlosVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator — the workspace has no user-selectable inputs; once connected the resource
// URL is fully determined. Treated as untrusted, so it exposes nothing but the fixed instance URL.

interface WorkspaceConfiguratorRpc {
  resourceUrl(): Promise<string>;
}

const WORKSPACE_CONFIGURATOR_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>owlOS Workspace</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:0.75rem;color:#333;font-size:0.9rem;}</style>
</head><body>Connected owlOS workspace — read-only access to this instance.</body></html>`;

@validateRpc()
class WorkspaceConfiguratorUI extends RpcTarget implements WorkspaceConfiguratorRpc {
  #instanceUrl: string;
  constructor(instanceUrl: string) {
    super();
    this.#instanceUrl = instanceUrl;
  }
  async resourceUrl(): Promise<string> {
    return this.#instanceUrl;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl — whole-workspace, read-only in S1.

type OwlosGatekeeperImplProps = {
  userObjectId: string;
};

@validateRpc()
export class OwlosGatekeeperImpl
  extends DurableObject<Env, OwlosGatekeeperImplProps>
  implements Gatekeeper<OwlosSession>
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<OwlosCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    let title = "owlOS Workspace";
    let url = "https://owl-os.cloud";
    try {
      const creds = await this.#getCreds();
      url = creds.instanceUrl;
      title = `owlOS (${new URL(creds.instanceUrl).host})`;
    } catch {
      // Fall back to defaults.
    }
    return {
      url,
      title,
      snippet: "Access to this owlOS Cloud ERP workspace: customers, quotes/orders, and invoices.",
      suggestedBindingName: "OWLOS",
      tsType: "OwlosSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<OwlosSession> {
    const creds = await this.#getCreds();
    return new OwlosSessionImpl(creds, approvalQueue.dup());
  }

  // Read-only in S1: no actions are ever submitted.
  async applyAction(actionId: number): Promise<void> {
    throw new Error(`No queued owlOS action exists with id ${actionId}; this gatekeeper is read-only.`);
  }
  async rejectAction(_actionId: number): Promise<void> {}
  async revertAction(_actionId: number): Promise<void> {
    throw new Error("This gatekeeper is read-only; there is nothing to revert.");
  }

  // Low-stakes observer strategy (see OwlosUserImpl.getVerifier): any collaborator may observe.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Session — whole-workspace, read-only.

class OwlosSessionImpl extends RpcTarget implements OwlosSession {
  #client: OwlosClient;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #disposed = false;

  constructor(creds: OwlosCredentials, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#client = new OwlosClient(creds);
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      (this.#approvalQueue as unknown as { [Symbol.dispose](): void })[Symbol.dispose]();
    } catch {
      // Already-disposed / runtime-missing dispose: ignore.
    }
  }

  async me(): Promise<Record<string, unknown>> {
    const identity = await this.#client.me();
    await this.#approvalQueue.authorizeObservation({
      title: "Read owlOS workspace identity",
      description: "Fetched the authenticated owlOS workspace identity (`GET /api/me`).",
    });
    return identity;
  }
}
