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
import INSTANCE_CONFIGURATOR_HTML from "./generated/instance-configurator-ui.txt";
import type { UnifiInstanceConfiguratorRpc } from "./configurator/instance-configurator-types";
import {
  UnifiClient,
  UnifiError,
  UNIFI_CONSOLE_URL,
  type UnifiCredentials,
} from "./unifi-api";
import type { UnifiHost, UnifiHostDevices, UnifiSession, UnifiSite } from "./types";
import TYPES_CODE from "./types.txt";

// ---------------------------------------------------------------------------
// Configuration & nonce helpers

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
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/unifi");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Resource descriptor
//
// v1 offers a single whole-account resource. UniFi Site Manager keys are account-wide, so there is
// exactly one grantable resource: read-only access to every console, site, and device the key sees.
// (Per-site scoping is a natural future granularity — see README.)

// UniFi brand logomark, embedded as an inline SVG data URL so it renders at the same visual weight
// as the other vendor logos wherever a gatekeeper logo is shown (connect card, picker, admin panel).
const UNIFI_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<rect width="512" height="512" rx="96" fill="#0559C9"/>\
<path d="M150 138v112c0 58 47 105 106 105s106-47 106-105V138h-60v112c0 25-21 46-46 46s-46-21-46-46V138z" fill="#fff"/>\
<circle cx="332" cy="158" r="26" fill="#fff"/>\
</svg>`;

const UNIFI_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(UNIFI_LOGO_SVG)}`;
const UNIFI_ICON: AvatarImage = { url: UNIFI_LOGO_URL };

const ACCOUNT_RESOURCE: SupportedResource = {
  urlPattern: `${UNIFI_CONSOLE_URL}/*`,
  title: "UniFi Account",
  description:
    "Read-only access to a UniFi Site Manager account: every console (host), site, and adopted device.",
  icon: UNIFI_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ACCOUNT_RESOURCE];

// ---------------------------------------------------------------------------
// HTML pages for the connect flow

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect UniFi</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 540px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #0559C9; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #0559C9; }
  details ol { padding-left: 1.25rem; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #0559C9; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #0448a3; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect UniFi</h1>
    <p>Paste a UniFi Site Manager API key. Cloudflare OS will use it to read your consoles, sites, and devices (read-only).</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeAttr(params.actionUrl)}">
      <label for="apiKey">UniFi Site Manager API Key</label>
      <input id="apiKey" name="apiKey" type="password" required placeholder="xxxxxxxx..." autofocus>
      <div class="hint">The key is account-wide and read-only for this connector. It is stored encrypted and never shown again.</div>

      <details>
        <summary>How to create an API key</summary>
        <ol>
          <li>Sign in to <b>unifi.ui.com</b>.</li>
          <li>Open <b>Settings → Control Plane → Integrations</b> (API).</li>
          <li>Click <b>Create API Key</b>, give it a name like "Cloudflare OS", and copy the key.</li>
          <li>Paste it above. You can revoke it any time from the same screen.</li>
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
  <h2 style="color: #0559C9;">Connected!</h2>
  <p>Your UniFi account has been linked to Cloudflare OS. You may close this tab.</p>
</body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h2 style="color: #d97706;">Authorization Link Expired</h2>
  <p>This connection link is invalid or has expired. Please return to Cloudflare OS and start over.</p>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

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
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
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
        const apiKeyInput = String(formData.get("apiKey") ?? "").trim();
        if (!apiKeyInput) {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: "An API key is required." }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        const result = await stub.completeConnection(nonce, apiKeyInput);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (result.kind === "error") {
          return new Response(
            CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }
        return new Response(SELF_CLOSING_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
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
      displayName: "UniFi",
      url: "https://unifi.ui.com/",
      logo: UNIFI_ICON,
      tagline: "Read your UniFi consoles, sites, and network devices.",
      description:
        "Connect a UniFi Site Manager account so Cloudflare OS can read your consoles (hosts), " +
        "sites, and adopted devices. Build agents that inventory your network, watch for offline " +
        "gear, or report on firmware across every UniFi site. Read-only.",
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
// UserAccount DO — stores the API key for a connected account

interface StoredCredentials {
  apiKey: string;
}

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
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
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
    this.ctx.storage.kv.put("expiredNotified", false);
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

  async completeConnection(nonce: string, apiKey: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    // Validate that the key can actually talk to the Site Manager API.
    try {
      await new UnifiClient({ apiKey }).ping();
    } catch (e: any) {
      const msg = e instanceof UnifiError
        ? e.message
        : `Unable to reach the UniFi Site Manager API: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    // Consume the nonce now that we've validated.
    this.ctx.storage.kv.delete("nonce");

    this.ctx.storage.kv.put<StoredCredentials>("credentials", { apiKey });
    this.ctx.storage.kv.put("expiredNotified", false);

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
        const props: UnifiUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.UnifiUserImpl({ props }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): UnifiCredentials {
    const creds = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!creds) {
      throw new Error("UniFi credentials are not configured for this account.");
    }
    return creds;
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) {
      await callback.credentialsExpired();
    }
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<StoredCredentials>("credentials")) {
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

type UnifiUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class UnifiUserImpl
  extends WorkerEntrypoint<Env, UnifiUserImplProps>
  implements GatekeeperUser
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<UnifiCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    const creds = await this.#getCreds();
    let displayName = "UniFi";
    let uniqueName = "UniFi Site Manager";
    try {
      const hosts = await new UnifiClient(creds).listHosts();
      const primary = hosts[0]?.reportedState?.hostname ?? hosts[0]?.hostname;
      if (hosts.length === 1 && primary) {
        displayName = `UniFi (${primary})`;
        uniqueName = String(primary);
      } else if (hosts.length > 1) {
        displayName = `UniFi (${hosts.length} consoles)`;
        uniqueName = `UniFi Site Manager (${hosts.length} consoles)`;
      }
    } catch (e) {
      if (e instanceof UnifiError && e.isAuthError) {
        await this.#userAccount().noteCredentialsExpired();
      }
      // Ignore other failures; fall back to defaults.
    }
    return { displayName, uniqueName, avatar: UNIFI_ICON };
  }

  /** This gatekeeper does not provide sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ACCOUNT_RESOURCE.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: INSTANCE_CONFIGURATOR_HTML,
      ui: new RpcStub(new InstanceConfiguratorUI()),
    };
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // The account key is whole-account, so every URL resolves to the one whole-account resource.
    // We still validate the URL is well-formed http(s) so a nonsensical binding fails early.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported URL scheme for UniFi: ${parsed.protocol}`);
      }
    } catch (e: any) {
      throw new Error(`Invalid UniFi URL "${url}": ${e?.message ?? e}`, { cause: e });
    }
    return {
      class: this.ctx.exports.UnifiGatekeeperImpl({
        props: { userObjectId: this.ctx.props.userObjectId },
      }),
      resource: ACCOUNT_RESOURCE,
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
   * Mint a verifier representing this account. UniFi uses the "low-stakes" observer strategy (see
   * UnifiGatekeeperImpl.addObserver): a Site Manager key is all-or-nothing account-wide and read-
   * only, and the cloud API exposes no per-user ACL oracle we could verify an observer against, so
   * the verifier carries no identity and is never consulted — but the overseer mints one on every
   * open, so it must exist and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.UnifiVerifier({});
  }
}

// A trivial verifier since UniFi's observer strategy is low-stakes.
@validateRpc()
export class UnifiVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Configurator UI for the whole-account resource.
//
// The whole-account resource has no user-selectable inputs; once the account is connected the
// resource URL is fully determined. The configurator only confirms and reports readiness. It is
// treated as untrusted, so it exposes nothing but the fixed console URL.

@validateRpc()
class InstanceConfiguratorUI extends RpcTarget implements UnifiInstanceConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return UNIFI_CONSOLE_URL;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl

type UnifiGatekeeperImplProps = {
  userObjectId: string;
};

@validateRpc()
export class UnifiGatekeeperImpl
  extends DurableObject<Env, UnifiGatekeeperImplProps>
  implements Gatekeeper<UnifiSession>
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<UnifiCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    const creds = await this.#getCreds();
    let title = "UniFi Account";
    try {
      const hosts = await new UnifiClient(creds).listHosts();
      const primary = hosts[0]?.reportedState?.hostname ?? hosts[0]?.hostname;
      if (hosts.length === 1 && primary) title = `UniFi (${primary})`;
      else if (hosts.length > 1) title = `UniFi (${hosts.length} consoles)`;
    } catch {
      // Fall back to the default title.
    }
    return {
      url: UNIFI_CONSOLE_URL,
      title,
      snippet: "Read-only access to every UniFi console, site, and device on this account.",
      suggestedBindingName: "UNIFI",
      tsType: "UnifiSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<UnifiSession> {
    const creds = await this.#getCreds();
    return new UnifiSessionImpl(creds, approvalQueue.dup(), () =>
      this.#userAccount().noteCredentialsExpired(),
    );
  }

  // This gatekeeper is read-only: it never submits an action, so these never fire in practice.
  // They throw clearly if the overseer ever calls back with an id we never issued.
  async applyAction(actionId: number): Promise<void> {
    throw new Error(`No queued UniFi action exists with id ${actionId}; this gatekeeper is read-only.`);
  }

  async rejectAction(_actionId: number): Promise<void> {
    // Nothing to clean up — no actions are ever stored.
  }

  async revertAction(_actionId: number): Promise<void> {
    throw new Error("This gatekeeper is read-only; there is nothing to revert.");
  }

  /**
   * Observer tracking: UniFi uses the "low-stakes" strategy. A Site Manager key grants the same
   * all-or-nothing account-wide read access to anyone holding it, and the cloud API has no per-user
   * ACL oracle we could verify an observer against. So any collaborator may observe:
   * addObserver/removeObserver are no-ops and we never set excludeObservers on observations.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Session — whole-account, read-only.

class UnifiSessionImpl extends RpcTarget implements UnifiSession {
  #client: UnifiClient;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #noteAuthError: () => Promise<void>;
  #disposed = false;

  constructor(
    creds: UnifiCredentials,
    approvalQueue: RpcStub<ApprovalQueue>,
    noteAuthError: () => Promise<void>,
  ) {
    super();
    this.#client = new UnifiClient(creds);
    this.#approvalQueue = approvalQueue;
    this.#noteAuthError = noteAuthError;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Release the server-side RpcStub for our dup'd approvalQueue. The TS type doesn't expose
    // Symbol.dispose, but the runtime object implements it (same pattern as the other gatekeepers).
    try {
      (this.#approvalQueue as unknown as { [Symbol.dispose](): void })[Symbol.dispose]();
    } catch {
      // Already-disposed / runtime-missing dispose: ignore.
    }
  }

  /** Run a read against UniFi, flagging auth failures so the account can be marked expired. */
  async #read<T>(fn: (c: UnifiClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.#client);
    } catch (e) {
      if (e instanceof UnifiError && e.isAuthError) {
        await this.#noteAuthError();
      }
      throw e;
    }
  }

  async listHosts(): Promise<UnifiHost[]> {
    const hosts = await this.#read((c) => c.listHosts());
    await this.#approvalQueue.authorizeObservation({
      title: "List UniFi consoles",
      description: `Listed ${hosts.length} UniFi console${hosts.length === 1 ? "" : "s"} on the account.`,
    });
    return hosts as UnifiHost[];
  }

  async getHost(hostId: string): Promise<UnifiHost> {
    const host = await this.#read((c) => c.getHost(hostId));
    const name = host?.reportedState?.hostname ?? host?.hostname ?? hostId;
    await this.#approvalQueue.authorizeObservation({
      title: `Read UniFi console "${name}"`,
      description: `Fetched details for UniFi console \`${hostId}\` ("${name}").`,
    });
    return host as UnifiHost;
  }

  async listSites(): Promise<UnifiSite[]> {
    const sites = await this.#read((c) => c.listSites());
    await this.#approvalQueue.authorizeObservation({
      title: "List UniFi sites",
      description: `Listed ${sites.length} UniFi site${sites.length === 1 ? "" : "s"} across the account.`,
    });
    return sites as UnifiSite[];
  }

  async listDevices(hostId?: string): Promise<UnifiHostDevices[]> {
    const groups = await this.#read((c) => c.listDevices(hostId));
    const total = groups.reduce(
      (n: number, g: any) => n + (Array.isArray(g?.devices) ? g.devices.length : 0),
      0,
    );
    await this.#approvalQueue.authorizeObservation({
      title: hostId ? `List UniFi devices on console ${hostId}` : "List UniFi devices",
      description:
        `Listed ${total} adopted device${total === 1 ? "" : "s"}` +
        (hostId ? ` on console \`${hostId}\`.` : ` across ${groups.length} console${groups.length === 1 ? "" : "s"}.`),
    });
    return groups as UnifiHostDevices[];
  }
}
