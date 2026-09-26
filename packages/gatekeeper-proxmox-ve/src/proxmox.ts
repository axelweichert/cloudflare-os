import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
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
import { ProxmoxClient, ProxmoxError, verifyCredentials, type ProxmoxCredentials } from "./proxmox-api";
import { PRODUCT } from "./product";
import type {
  ProxmoxVeContainer,
  ProxmoxVeNode,
  ProxmoxVeNodeStatus,
  ProxmoxVeSession,
  ProxmoxVeVersion,
  ProxmoxVeVm,
} from "./types";
import type { ProxmoxConfiguratorRpc } from "./configurator/proxmox-configurator-types";
import TYPES_CODE from "./types.txt";
import WORKSPACE_CONFIGURATOR_HTML from "./generated/proxmox-configurator-ui.txt";

// ---------------------------------------------------------------------------
// Config & nonce helpers (identical shape to gk-owlos / gk-cloudflare / gk-unifi)

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
  return stripTrailingSlashes(env.BASE_URL ?? `http://localhost:8787${PRODUCT.basePath}`);
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Branding & resource

// A simple server/stack glyph in Proxmox orange, inline so it renders at the same weight as other
// vendor logos without a network fetch.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<rect width="512" height="512" rx="96" fill="${PRODUCT.themeColor}"/>\
<rect x="120" y="128" width="272" height="72" rx="12" fill="#fff"/>\
<rect x="120" y="220" width="272" height="72" rx="12" fill="#fff"/>\
<rect x="120" y="312" width="272" height="72" rx="12" fill="#fff"/>\
<circle cx="164" cy="164" r="14" fill="${PRODUCT.themeColor}"/>\
<circle cx="164" cy="256" r="14" fill="${PRODUCT.themeColor}"/>\
<circle cx="164" cy="348" r="14" fill="${PRODUCT.themeColor}"/>\
</svg>`;

const LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(LOGO_SVG)}`;
const ICON: AvatarImage = { url: LOGO_URL };

// A connected Proxmox host is one whole-host resource; the token authenticates the whole API.
const HOST_RESOURCE: SupportedResource = {
  urlPattern: PRODUCT.resourceUrlPattern,
  title: `${PRODUCT.displayName} (${PRODUCT.host})`,
  description: `Read-only access to the ${PRODUCT.fullName} API at ${PRODUCT.host}.`,
  icon: ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [HOST_RESOURCE];

// ---------------------------------------------------------------------------
// Connect-flow HTML (one field: the API token)

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect ${escapeHtml(PRODUCT.displayName)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 560px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: ${PRODUCT.themeColor}; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: ${PRODUCT.themeColor}; }
  details ol { padding-left: 1.25rem; }
  details li { margin: 0.35rem 0; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: ${PRODUCT.themeColor}; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
  code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect ${escapeHtml(PRODUCT.displayName)}</h1>
    <p>Cloudflare OS will connect to your ${escapeHtml(PRODUCT.fullName)} at <code>${escapeHtml(PRODUCT.host)}</code> using an API token. Read-only access.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <label for="apiToken">${escapeHtml(PRODUCT.displayName)} API Token</label>
      <input id="apiToken" name="apiToken" type="password" required placeholder="user@pam!tokenid=xxxxxxxx-xxxx-..." autofocus autocomplete="off">
      <div class="hint">Full token string in the form <code>USER@REALM!TOKENID=SECRET</code>. Stored encrypted, never shown again.</div>

      <details>
        <summary>How to create an API token</summary>
        <ol>
          <li>Sign in to ${escapeHtml(PRODUCT.displayName)} at <code>${escapeHtml(PRODUCT.host)}</code>.</li>
          <li>Open <b>Datacenter → Permissions → API Tokens</b> and add a token.</li>
          <li>Grant it a read-only role (e.g. <code>PVEAuditor</code>), copy <code>USER@REALM!TOKENID=SECRET</code>, and paste it above.</li>
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
  <h2 style="color: ${PRODUCT.themeColor};">Connected!</h2>
  <p>${escapeHtml(PRODUCT.displayName)} has been linked to Cloudflare OS. You may close this tab.</p>
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
        const apiToken = String(formData.get("apiToken") ?? "").trim();
        if (!apiToken) {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "An API token is required." }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        const result = await stub.completeConnection(nonce, apiToken);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (result.kind === "error") {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }),
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
      displayName: PRODUCT.displayName,
      url: PRODUCT.homeUrl,
      logo: ICON,
      tagline: PRODUCT.tagline,
      description:
        `Connect your ${PRODUCT.fullName} (${PRODUCT.host}) so Cloudflare OS can read its status ` +
        `over the API. Connect it with a read-only API token — no OAuth app needed.`,
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
// UserAccount DO — stores { apiToken } for a connected host

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
    if (!this.ctx.storage.kv.get<ProxmoxCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
  }

  /** Validates the nonce but does not consume it (so the user can resubmit if validation fails). */
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

    // Verify the token against the live host (one read-only call) before storing anything.
    let creds: ProxmoxCredentials;
    try {
      creds = await verifyCredentials(apiToken);
    } catch (e: any) {
      const msg = e instanceof ProxmoxError ? e.message : `Unable to verify ${PRODUCT.displayName}: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.put<ProxmoxCredentials>("credentials", creds);

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
        const props: ProxmoxUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.ProxmoxUserImpl({ props }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): ProxmoxCredentials {
    const creds = this.ctx.storage.kv.get<ProxmoxCredentials>("credentials");
    if (!creds) throw new Error(`${PRODUCT.displayName} credentials are not configured for this account.`);
    return creds;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<ProxmoxCredentials>("credentials")) {
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

type ProxmoxUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class ProxmoxUserImpl extends WorkerEntrypoint<Env, ProxmoxUserImplProps> implements GatekeeperUser {
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<ProxmoxCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    return { displayName: `${PRODUCT.displayName} (${PRODUCT.host})`, uniqueName: PRODUCT.host, avatar: ICON };
  }

  /** This gatekeeper connects via API token and does not provide sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== HOST_RESOURCE.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: WORKSPACE_CONFIGURATOR_HTML,
      ui: new RpcStub(new ConfiguratorUI()),
    };
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // The token is whole-host, so every URL resolves to the one host resource.
    return {
      class: this.ctx.exports.ProxmoxGatekeeperImpl({ props: { userObjectId: this.ctx.props.userObjectId } }),
      resource: HOST_RESOURCE,
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

  /** Low-stakes observer strategy (same as gk-unifi / gk-owlos): verifier carries no identity. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ProxmoxVerifier({});
  }
}

@validateRpc()
export class ProxmoxVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator — the host has no user-selectable inputs; once connected the resource URL is
// fully determined (the fixed host). Exposes nothing but that URL.

@validateRpc()
class ConfiguratorUI extends RpcTarget implements ProxmoxConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return `https://${PRODUCT.host}`;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl — whole-host, READ-ONLY. No writes exist for this gatekeeper.

type ProxmoxGatekeeperImplProps = {
  userObjectId: string;
};

@validateRpc()
export class ProxmoxGatekeeperImpl
  extends DurableObject<Env, ProxmoxGatekeeperImplProps>
  implements Gatekeeper<ProxmoxVeSession>
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<ProxmoxCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: `https://${PRODUCT.host}`,
      title: `${PRODUCT.displayName} (${PRODUCT.host})`,
      snippet: `Read-only access to the ${PRODUCT.fullName} API at ${PRODUCT.host}.`,
      suggestedBindingName: PRODUCT.suggestedBinding,
      tsType: PRODUCT.tsType,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Read-only gatekeeper: there are no actions to approve.
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ProxmoxVeSession> {
    const creds = await this.#getCreds();
    return new ProxmoxSessionImpl(creds, approvalQueue.dup());
  }

  // Read-only: this gatekeeper never enqueues an action, so these interface members can never be
  // reached with a real action id. They exist only to satisfy Gatekeeper<Session> and throw if the
  // overseer ever calls them (which would be a framework bug given getAutoApprovableActions()===[]).
  async applyAction(_action: number): Promise<void> {
    throw new Error(`${PRODUCT.displayName} gatekeeper is read-only; there are no actions to apply.`);
  }
  async rejectAction(_action: number): Promise<void> {}
  async revertAction(_action: number): Promise<void> {}

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Session — whole-host, read-only. Every read is authorized+audited via authorizeObservation.

class ProxmoxSessionImpl extends RpcTarget implements ProxmoxVeSession {
  #client: ProxmoxClient;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #disposed = false;

  constructor(creds: ProxmoxCredentials, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#client = new ProxmoxClient(creds);
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

  /** Fetch `path`, then authorize the observation before returning anything to the caller. */
  async #read<T>(path: string, obs: ObservationDescription): Promise<T> {
    const data = await this.#client.get(path);
    await this.#approvalQueue.authorizeObservation(obs);
    return data as T;
  }

  /** API version + build of the connected host (`GET /api2/json/version`). */
  async version(): Promise<ProxmoxVeVersion> {
    return await this.#read<ProxmoxVeVersion>(PRODUCT.verifyPath, {
      title: `Read ${PRODUCT.displayName} version`,
      description: `Fetched the ${PRODUCT.displayName} API version (\`GET /api2/json/version\`).`,
    });
  }

  /** List the cluster's nodes (`GET /api2/json/nodes`). */
  async listNodes(): Promise<ProxmoxVeNode[]> {
    const nodes = await this.#read<ProxmoxVeNode[]>("/nodes", {
      title: "List Proxmox VE nodes",
      description: "Listed the cluster's nodes (`GET /api2/json/nodes`).",
    });
    return nodes ?? [];
  }

  /** List the QEMU VMs on `node` (`GET /api2/json/nodes/{node}/qemu`). */
  async listQemuVms(node: string): Promise<ProxmoxVeVm[]> {
    const enc = encodeURIComponent(node);
    const vms = await this.#read<ProxmoxVeVm[]>(`/nodes/${enc}/qemu`, {
      title: `List QEMU VMs on node "${node}"`,
      description: `Listed the QEMU virtual machines on node \`${node}\` (\`GET /api2/json/nodes/${node}/qemu\`).`,
    });
    return vms ?? [];
  }

  /** List the LXC containers on `node` (`GET /api2/json/nodes/{node}/lxc`). */
  async listContainers(node: string): Promise<ProxmoxVeContainer[]> {
    const enc = encodeURIComponent(node);
    const cts = await this.#read<ProxmoxVeContainer[]>(`/nodes/${enc}/lxc`, {
      title: `List LXC containers on node "${node}"`,
      description: `Listed the LXC containers on node \`${node}\` (\`GET /api2/json/nodes/${node}/lxc\`).`,
    });
    return cts ?? [];
  }

  /** Read live status of `node` (`GET /api2/json/nodes/{node}/status`). */
  async getNodeStatus(node: string): Promise<ProxmoxVeNodeStatus> {
    const enc = encodeURIComponent(node);
    return await this.#read<ProxmoxVeNodeStatus>(`/nodes/${enc}/status`, {
      title: `Read status of node "${node}"`,
      description: `Fetched live status for node \`${node}\` (\`GET /api2/json/nodes/${node}/status\`).`,
    });
  }
}
