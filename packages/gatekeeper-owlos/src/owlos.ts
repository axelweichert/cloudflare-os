import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type ActionDescription,
  type ActionKind,
  type ApprovalQueue,
  type AvatarImage,
  type Gatekeeper,
  type ObservationDescription,
  type GatekeeperConnectCallback,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { OwlosClient, OwlosError, verifyCredentials, type HttpMethod, type OwlosCredentials } from "./owlos-api";
import type { OwlosSession } from "./types";
import type { OwlosWorkspaceConfiguratorRpc } from "./configurator/owlos-configurator-types";
import TYPES_CODE from "./types.txt";
// Generated from src/configurator/owlos-workspace-configurator-ui.tsx by
// scripts/build-gatekeeper-configurator.ts — a real configurator module that wires the MessagePort
// RPC runtime, so the connect iframe reports ready (unlike the old inline HTML string).
import WORKSPACE_CONFIGURATOR_HTML from "./generated/owlos-workspace-configurator-ui.txt";

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

@validateRpc()
class WorkspaceConfiguratorUI extends RpcTarget implements OwlosWorkspaceConfiguratorRpc {
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
    // Every write (create/patch/finalize) requires manual approval — nothing auto-approves.
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<OwlosSession> {
    const creds = await this.#getCreds();
    return new OwlosSessionImpl(this, creds, approvalQueue.dup());
  }

  // -------------------------------------------------------------------------
  // Action queue (S2). Writes are deferred: the session enqueues the concrete HTTP request here and
  // submits it for approval; owlOS is only touched in applyAction, once a human approves. Reads stay
  // direct (see OwlosSessionImpl), so a pending write is not reflected until it is applied — hence
  // awaitDecision is set on every submission so the agent pauses rather than reading a stale world.

  #nextActionId(): number {
    const value = (this.ctx.storage.kv.get<number>("actionCounter") ?? 0) + 1;
    this.ctx.storage.kv.put("actionCounter", value);
    return value;
  }

  /** Called by the session for every write. Stores the request and submits it for approval. */
  async enqueueAction(
    approvalQueue: RpcStub<ApprovalQueue>,
    request: StoredOwlosAction["request"],
    description: ActionDescription,
  ): Promise<{ status: "pending_approval"; actionId: number }> {
    const actionId = this.#nextActionId();
    this.ctx.storage.kv.put<StoredOwlosAction>(`action:${actionId}`, { id: actionId, request });
    await approvalQueue.submitAction(actionId, description);
    return { status: "pending_approval", actionId };
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.ctx.storage.kv.get<StoredOwlosAction>(`action:${actionId}`);
    if (!action) throw new Error(`No queued owlOS action exists with id ${actionId}.`);
    const client = new OwlosClient(await this.#getCreds());
    await client.request(action.request.method, action.request.path, action.request.body);
    this.ctx.storage.kv.delete(`action:${actionId}`);
  }

  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`action:${actionId}`);
  }

  async revertAction(_actionId: number): Promise<void> {
    // owlOS has no generic undo; every submitted action declares implementsRevert:false, so the
    // overseer never offers a revert and never calls this.
    throw new Error("owlOS actions cannot be reverted automatically.");
  }

  // Low-stakes observer strategy (see OwlosUserImpl.getVerifier): any collaborator may observe.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// A write request the session queued for approval; applyAction replays it against owlOS verbatim.
interface StoredOwlosAction {
  id: number;
  request: { method: HttpMethod; path: string; body?: unknown };
}

const PENDING = "pending_approval" as const;
type PendingResult = { status: typeof PENDING; actionId: number };

/** Build a `?a=b&c=d` query string from defined string/number filters (undefined keys dropped). */
function query(filter?: Record<string, string | number | undefined>): string {
  if (!filter) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Session — whole-workspace. Reads run directly (authorized + audited via authorizeObservation, like
// me()); writes are queued through the gatekeeper's approval queue and only hit owlOS once approved
// (see OwlosGatekeeperImpl.enqueueAction/applyAction). Routes are exactly the ones in S2-CONTRACT.md.

class OwlosSessionImpl extends RpcTarget implements OwlosSession {
  #gk: OwlosGatekeeperImpl;
  #client: OwlosClient;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #disposed = false;

  constructor(gk: OwlosGatekeeperImpl, creds: OwlosCredentials, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
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

  /** Run a direct read, then authorize+audit it. `title`/`description` describe the observation. */
  async #read(path: string, obs: ObservationDescription): Promise<any> {
    const data = await this.#client.request("GET", path);
    await this.#approvalQueue.authorizeObservation(obs);
    return data;
  }

  /** Queue a write for human approval. It touches owlOS only after approval (applyAction). */
  async #write(
    method: HttpMethod,
    path: string,
    body: unknown,
    action: Pick<ActionDescription, "title" | "description">,
  ): Promise<PendingResult> {
    return await this.#gk.enqueueAction(this.#approvalQueue, { method, path, body }, {
      ...action,
      implementsRevert: false,
      awaitDecision: true,
    });
  }

  // ---- identity -----------------------------------------------------------

  async me(): Promise<Record<string, unknown>> {
    return (await this.#read("/api/auth/me", {
      title: "Read owlOS workspace identity",
      description: "Fetched the authenticated owlOS workspace identity (`GET /api/auth/me`).",
    })) as Record<string, unknown>;
  }

  // ---- Angebot (quote) ----------------------------------------------------

  async listQuotes(): Promise<unknown> {
    return await this.#read("/api/erp/quotes", {
      title: "List owlOS quotes",
      description: "Listed the workspace's quotes/offers (`GET /api/erp/quotes`).",
    });
  }

  async createQuote(fields: Record<string, unknown>): Promise<PendingResult> {
    const title = typeof fields?.title === "string" ? fields.title.trim() : "";
    if (!title) throw new OwlosError('owlOS requires a quote title ("Titel ist Pflicht").');
    return await this.#write("POST", "/api/erp/quotes", { ...fields, title }, {
      title: `Create owlOS quote "${title}"`,
      description: `Create a new quote in owlOS (\`POST /api/erp/quotes\`) with:\n\n\`\`\`json\n${JSON.stringify({ ...fields, title }, null, 2)}\n\`\`\``,
    });
  }

  async updateQuote(quoteId: string, fields: Record<string, unknown>): Promise<PendingResult> {
    const path = `/api/erp/quotes/${encodeURIComponent(quoteId)}`;
    return await this.#write("PATCH", path, fields, {
      title: `Update owlOS quote ${quoteId}`,
      description: `Update quote \`${quoteId}\` (\`PATCH ${path}\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  // ---- Kunde (company) ----------------------------------------------------

  async listCompanies(): Promise<unknown> {
    return await this.#read("/api/companies", {
      title: "List owlOS companies",
      description: "Listed the workspace's customers/companies (`GET /api/companies`).",
    });
  }

  async createCompany(fields: Record<string, unknown>): Promise<PendingResult> {
    const name = typeof fields?.name === "string" ? fields.name.trim() : "";
    if (!name) throw new OwlosError("owlOS requires a company name.");
    return await this.#write("POST", "/api/companies", { ...fields, name }, {
      title: `Create owlOS company "${name}"`,
      description: `Create a new company in owlOS (\`POST /api/companies\`) with:\n\n\`\`\`json\n${JSON.stringify({ ...fields, name }, null, 2)}\n\`\`\``,
    });
  }

  async assignCustomerNumber(fields: Record<string, unknown>): Promise<PendingResult> {
    return await this.#write("POST", "/api/companies/assign-kundennr", fields, {
      title: "Assign owlOS customer number",
      description: `Assign a customer number (\`POST /api/companies/assign-kundennr\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  // ---- Rechnung (outgoing invoice) ----------------------------------------

  async listInvoices(): Promise<unknown> {
    return await this.#read("/api/faktura/outgoing", {
      title: "List owlOS outgoing invoices",
      description: "Listed the workspace's outgoing invoices (`GET /api/faktura/outgoing`).",
    });
  }

  async createInvoice(fields: Record<string, unknown>): Promise<PendingResult> {
    return await this.#write("POST", "/api/faktura/outgoing", fields, {
      title: "Create owlOS outgoing invoice",
      description: `Create an outgoing invoice header (\`POST /api/faktura/outgoing\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  async addInvoiceItems(invoiceId: string, fields: Record<string, unknown>): Promise<PendingResult> {
    const path = `/api/faktura/outgoing/${encodeURIComponent(invoiceId)}/items`;
    return await this.#write("POST", path, fields, {
      title: `Add items to owlOS invoice ${invoiceId}`,
      description: `Add line items to invoice \`${invoiceId}\` (\`POST ${path}\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  async finalizeInvoice(invoiceId: string): Promise<PendingResult> {
    const path = `/api/faktura/outgoing/${encodeURIComponent(invoiceId)}/finalize`;
    return await this.#write("POST", path, {}, {
      title: `Finalize owlOS invoice ${invoiceId}`,
      description: `Finalize (commit) invoice \`${invoiceId}\` (\`POST ${path}\`). This is irreversible in owlOS.`,
    });
  }

  // ---- Ansprechpartner (contact) ------------------------------------------

  async listContacts(filter?: Record<string, string | number>): Promise<unknown> {
    return await this.#read(`/api/contacts${query(filter)}`, {
      title: "List owlOS contacts",
      description: "Listed the workspace's contacts (`GET /api/contacts`).",
    });
  }

  async createContact(fields: Record<string, unknown>): Promise<PendingResult> {
    return await this.#write("POST", "/api/contacts", fields, {
      title: "Create owlOS contact",
      description: `Create a new contact in owlOS (\`POST /api/contacts\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  async mergeContacts(fields: Record<string, unknown>): Promise<PendingResult> {
    return await this.#write("POST", "/api/contacts/merge", fields, {
      title: "Merge owlOS contacts",
      description: `Merge duplicate contacts (\`POST /api/contacts/merge\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  // ---- Aktivität (activity) -----------------------------------------------

  async listActivities(filter?: Record<string, string | number>): Promise<unknown> {
    return await this.#read(`/api/activities${query(filter)}`, {
      title: "List owlOS activities",
      description: "Listed the workspace's activities (`GET /api/activities`).",
    });
  }

  async createActivity(fields: Record<string, unknown>): Promise<PendingResult> {
    return await this.#write("POST", "/api/activities", fields, {
      title: "Create owlOS activity",
      description: `Create a new activity in owlOS (\`POST /api/activities\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  async setActivityStatus(activityId: string, fields: Record<string, unknown>): Promise<PendingResult> {
    const path = `/api/activities/${encodeURIComponent(activityId)}/status`;
    return await this.#write("PATCH", path, fields, {
      title: `Set owlOS activity ${activityId} status`,
      description: `Change the status of activity \`${activityId}\` (\`PATCH ${path}\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }

  // ---- Opportunity (deal) -------------------------------------------------

  async listDeals(filter?: Record<string, string | number>): Promise<unknown> {
    return await this.#read(`/api/deals${query(filter)}`, {
      title: "List owlOS deals",
      description: "Listed the workspace's deals/opportunities (`GET /api/deals`).",
    });
  }

  async createDeal(fields: Record<string, unknown>): Promise<PendingResult> {
    return await this.#write("POST", "/api/deals", fields, {
      title: "Create owlOS deal",
      description: `Create a new deal/opportunity in owlOS (\`POST /api/deals\`) with:\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``,
    });
  }
}
