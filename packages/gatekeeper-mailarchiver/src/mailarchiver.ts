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
import {
  MailArchiverClient,
  MailArchiverError,
  verifyCredentials,
  type MailArchiverCredentials,
} from "./mailarchiver-api";
import type {
  Attachment,
  AttachmentContent,
  ArchiveStats,
  Contact,
  Mailbox,
  MailArchiverSession,
  MailboxSession,
  MailboxTreeLevel,
  MessageBody,
  MessageMetadata,
  MessageSession,
  MessageSummary,
} from "./types";
import type { MailArchiverWorkspaceConfiguratorRpc } from "./configurator/mailarchiver-configurator-types";
import TYPES_CODE from "./types.txt";
// Generated from src/configurator/mailarchiver-workspace-configurator-ui.tsx by
// scripts/build-gatekeeper-configurator.ts.
import WORKSPACE_CONFIGURATOR_HTML from "./generated/mailarchiver-workspace-configurator-ui.txt";

// ---------------------------------------------------------------------------
// Config & nonce helpers (identical shape to gk-owlos / gk-unifi / gk-cloudflare)

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
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/mailarchiver");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Branding & resource

// Envelope-in-a-circle mark; #677979 matches the owlOS family theme colour.
const MAILARCHIVER_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<rect width="512" height="512" rx="96" fill="#677979"/>\
<rect x="116" y="156" width="280" height="200" rx="16" fill="#fff"/>\
<path d="M116 176 l140 108 l140 -108" fill="none" stroke="#677979" stroke-width="24" stroke-linejoin="round"/>\
</svg>`;

const MAILARCHIVER_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(MAILARCHIVER_LOGO_SVG)}`;
const MAILARCHIVER_ICON: AvatarImage = { url: MAILARCHIVER_LOGO_URL };

// A connected MailArchiver is one whole-archive resource. MailArchiver instances live under
// *.owl-os.cloud (and custom domains); the pattern matches the common case and getGatekeeperClassFor
// resolves any connected https URL to this single resource.
const ARCHIVE_RESOURCE: SupportedResource = {
  urlPattern: "https://*.owl-os.cloud/*",
  title: "MailArchiver",
  description:
    "Read-only access to an owlOS MailArchiver email archive: stats, mailboxes, contacts, messages, and attachments.",
  icon: MAILARCHIVER_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ARCHIVE_RESOURCE];

// ---------------------------------------------------------------------------
// Connect-flow HTML (base URL + API token, plus optional CF Access service token)

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

const CONNECT_FORM_HTML = (params: { actionUrl: string; baseUrl?: string; error?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect MailArchiver</title>
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
  fieldset { margin-top: 1.25rem; border: 1px solid #e0e0e0; border-radius: 6px; padding: 0.5rem 1rem 1rem; }
  legend { font-weight: 600; color: #677979; font-size: 0.95rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect MailArchiver</h1>
    <p>Point Cloudflare OS at your MailArchiver and paste a read-only API token. The archive sits behind Cloudflare Access, so a service token is needed too.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeHtml(params.actionUrl)}">
      <label for="baseUrl">MailArchiver Base URL</label>
      <input id="baseUrl" name="baseUrl" type="url" required placeholder="https://mailarchiver.owl-os.cloud" value="${escapeHtml(params.baseUrl ?? "")}" autofocus>
      <div class="hint">The base URL of your MailArchiver, e.g. <code>https://mailarchiver.owl-os.cloud</code>.</div>

      <label for="apiToken">API Token</label>
      <input id="apiToken" name="apiToken" type="password" required placeholder="owl_…">
      <div class="hint">Create one in MailArchiver under <b>Settings → API Token</b>. Read-only. Stored encrypted and never shown again.</div>

      <fieldset>
        <legend>Cloudflare Access service token</legend>
        <label for="serviceClientId">Client ID</label>
        <input id="serviceClientId" name="serviceClientId" type="text" placeholder="xxxxxxxx.access">
        <label for="serviceClientSecret">Client Secret</label>
        <input id="serviceClientSecret" name="serviceClientSecret" type="password" placeholder="">
        <div class="hint">Required to pass the Access edge that fronts the archive.</div>
      </fieldset>

      <details>
        <summary>How to create the tokens</summary>
        <ol>
          <li>In MailArchiver, open <b>Settings → API Token</b> and create a read-only token (starts with <code>owl_</code>).</li>
          <li>In Cloudflare Zero Trust, create a <b>service token</b> for the Access app fronting the archive, and copy its client id + secret.</li>
          <li>Paste all values above with your base URL.</li>
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
  <p>Your MailArchiver has been linked to Cloudflare OS. You may close this tab.</p>
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
        const baseUrl = String(formData.get("baseUrl") ?? "").trim();
        const apiToken = String(formData.get("apiToken") ?? "").trim();
        const serviceClientId = String(formData.get("serviceClientId") ?? "").trim();
        const serviceClientSecret = String(formData.get("serviceClientSecret") ?? "").trim();
        if (!baseUrl || !apiToken) {
          return new Response(
            CONNECT_FORM_HTML({
              actionUrl: req.url,
              baseUrl,
              error: "Both a base URL and an API token are required.",
            }),
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
          );
        }

        const result = await stub.completeConnection(
          nonce,
          baseUrl,
          apiToken,
          serviceClientId,
          serviceClientSecret,
        );
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (result.kind === "error") {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, baseUrl, error: result.message }), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
            status: 400,
          });
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
      displayName: "MailArchiver",
      url: "https://mailarchiver.owl-os.cloud",
      logo: MAILARCHIVER_ICON,
      tagline: "Read your owlOS MailArchiver email archive.",
      description:
        "Connect an owlOS MailArchiver so Cloudflare OS can browse and read the archived email: " +
        "stats, mailboxes, contacts, messages, and attachments. Read-only; connect it with your " +
        "MailArchiver base URL and a read-only API token.",
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
// UserAccount DO — stores {baseUrl, apiToken, serviceClientId?, serviceClientSecret?}

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
    if (!this.ctx.storage.kv.get<MailArchiverCredentials>("credentials")) {
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

  async completeConnection(
    nonce: string,
    baseUrl: string,
    apiToken: string,
    serviceClientId: string,
    serviceClientSecret: string,
  ): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    // Verify the instance is a real MailArchiver and the token authenticates, before storing.
    let creds: MailArchiverCredentials;
    try {
      creds = await verifyCredentials(baseUrl, apiToken, serviceClientId, serviceClientSecret);
    } catch (e: any) {
      const msg =
        e instanceof MailArchiverError ? e.message : `Unable to verify MailArchiver: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    // Consume the nonce now that we've validated.
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.put<MailArchiverCredentials>("credentials", creds);

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
        const props: MailArchiverUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.MailArchiverUserImpl({ props }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): MailArchiverCredentials {
    const creds = this.ctx.storage.kv.get<MailArchiverCredentials>("credentials");
    if (!creds) throw new Error("MailArchiver credentials are not configured for this account.");
    return creds;
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<MailArchiverCredentials>("credentials")) {
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

type MailArchiverUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class MailArchiverUserImpl
  extends WorkerEntrypoint<Env, MailArchiverUserImplProps>
  implements GatekeeperUser
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<MailArchiverCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    let uniqueName = "MailArchiver";
    try {
      const creds = await this.#getCreds();
      uniqueName = new URL(creds.baseUrl).host;
    } catch {
      // Fall back to the default.
    }
    return { displayName: `MailArchiver (${uniqueName})`, uniqueName, avatar: MAILARCHIVER_ICON };
  }

  /** This gatekeeper connects via API token and does not provide sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== ARCHIVE_RESOURCE.urlPattern) {
      throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
    }
    const creds = await this.#getCreds();
    return {
      iframeHtml: WORKSPACE_CONFIGURATOR_HTML,
      ui: new RpcStub(new WorkspaceConfiguratorUI(creds.baseUrl)),
    };
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    // The token is whole-archive, so every URL resolves to the one archive resource. Validate the
    // URL is well-formed http(s) so a nonsensical binding fails early.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported URL scheme for MailArchiver: ${parsed.protocol}`);
      }
    } catch (e: any) {
      throw new Error(`Invalid MailArchiver URL "${url}": ${e?.message ?? e}`, { cause: e });
    }
    return {
      class: this.ctx.exports.MailArchiverGatekeeperImpl({
        props: { userObjectId: this.ctx.props.userObjectId },
      }),
      resource: ARCHIVE_RESOURCE,
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
   * Mint a verifier. MailArchiver uses the low-stakes observer strategy: an API token is
   * whole-archive and there is no per-user ACL oracle to verify an observer against, so the verifier
   * carries no identity and is never consulted — but the overseer mints one on every open, so it
   * must exist and not throw. (Same as gk-owlos / gk-unifi.)
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.MailArchiverVerifier({});
  }
}

@validateRpc()
export class MailArchiverVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Resource configurator — the archive has no user-selectable inputs; once connected the resource URL
// is fully determined. Treated as untrusted, so it exposes nothing but the fixed base URL.

@validateRpc()
class WorkspaceConfiguratorUI extends RpcTarget implements MailArchiverWorkspaceConfiguratorRpc {
  #baseUrl: string;
  constructor(baseUrl: string) {
    super();
    this.#baseUrl = baseUrl;
  }
  async resourceUrl(): Promise<string> {
    return this.#baseUrl;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl — whole-archive, read-only.

type MailArchiverGatekeeperImplProps = {
  userObjectId: string;
};

@validateRpc()
export class MailArchiverGatekeeperImpl
  extends DurableObject<Env, MailArchiverGatekeeperImplProps>
  implements Gatekeeper<MailArchiverSession>
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<MailArchiverCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    let title = "MailArchiver";
    let url = "https://mailarchiver.owl-os.cloud";
    try {
      const creds = await this.#getCreds();
      url = creds.baseUrl;
      title = `MailArchiver (${new URL(creds.baseUrl).host})`;
    } catch {
      // Fall back to defaults.
    }
    return {
      url,
      title,
      snippet: "Read-only access to this MailArchiver email archive: mailboxes, messages, and attachments.",
      suggestedBindingName: "MAILARCHIVER",
      tsType: "MailArchiverSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<MailArchiverSession> {
    const creds = await this.#getCreds();
    return new MailArchiverSessionImpl(new MailArchiverClient(creds), approvalQueue.dup());
  }

  // Read-only: no actions are ever submitted.
  async applyAction(actionId: number): Promise<void> {
    throw new Error(`No queued MailArchiver action exists with id ${actionId}; this gatekeeper is read-only.`);
  }
  async rejectAction(_actionId: number): Promise<void> {}
  async revertAction(_actionId: number): Promise<void> {
    throw new Error("This gatekeeper is read-only; there is nothing to revert.");
  }

  // Low-stakes observer strategy (see MailArchiverUserImpl.getVerifier): any collaborator with whom
  // the Gadget is shared may observe. addObserver/removeObserver are no-ops.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Session — whole-archive, read-only. Every read authorizes an observation before returning.

function disposeQueue(queue: RpcStub<ApprovalQueue>): void {
  try {
    (queue as unknown as { [Symbol.dispose](): void })[Symbol.dispose]();
  } catch {
    // Already-disposed / runtime-missing dispose: ignore.
  }
}

class MailArchiverSessionImpl extends RpcTarget implements MailArchiverSession {
  #client: MailArchiverClient;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #disposed = false;

  constructor(client: MailArchiverClient, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#client = client;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    disposeQueue(this.#approvalQueue);
  }

  async stats(): Promise<ArchiveStats> {
    const stats = await this.#client.stats();
    await this.#approvalQueue.authorizeObservation({
      title: "Read MailArchiver stats",
      description: "Fetched whole-archive statistics (`GET /api/stats`).",
    });
    return stats;
  }

  async mailboxes(): Promise<Mailbox[]> {
    const mailboxes = await this.#client.mailboxes();
    await this.#approvalQueue.authorizeObservation({
      title: "List MailArchiver mailboxes",
      description: "Listed the archive's mailboxes (`GET /api/mailboxes`).",
    });
    return mailboxes;
  }

  async search(query: string): Promise<MessageSummary[]> {
    const results = await this.#client.search(query);
    await this.#approvalQueue.authorizeObservation({
      title: "Search MailArchiver",
      description: `Searched archived messages for "${query}" (\`GET /api/messages?q=…\`).`,
    });
    return results;
  }

  // Capability constructors: no read is performed, so no observation is authorized here. The reads on
  // the returned sub-session authorize their own observations. Each sub-session gets its own dup() of
  // the approval queue so its lifetime is independent of this one.
  async mailbox(id: string): Promise<MailboxSession> {
    return new MailboxSessionImpl(this.#client, id, this.#approvalQueue.dup());
  }

  async message(id: string): Promise<MessageSession> {
    return new MessageSessionImpl(this.#client, id, this.#approvalQueue.dup());
  }
}

class MailboxSessionImpl extends RpcTarget implements MailboxSession {
  #client: MailArchiverClient;
  #mailboxId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #disposed = false;

  constructor(client: MailArchiverClient, mailboxId: string, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#client = client;
    this.#mailboxId = mailboxId;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    disposeQueue(this.#approvalQueue);
  }

  async contacts(): Promise<Contact[]> {
    const contacts = await this.#client.contacts(this.#mailboxId);
    await this.#approvalQueue.authorizeObservation({
      title: "List MailArchiver contacts",
      description: `Listed contacts for mailbox ${this.#mailboxId} (\`GET /api/tree\`).`,
    });
    return contacts;
  }

  async messages(
    contact: string,
    year?: string,
    month?: string,
    day?: string,
  ): Promise<MailboxTreeLevel> {
    const level = await this.#client.tree(this.#mailboxId, contact, year, month, day);
    const depth = [year, month, day].filter((s) => s != null && s !== "").length;
    await this.#approvalQueue.authorizeObservation({
      title: "Browse MailArchiver messages",
      description:
        `Browsed messages with ${contact} in mailbox ${this.#mailboxId} at date depth ${depth} ` +
        "(`GET /api/tree/…`).",
    });
    return level;
  }
}

class MessageSessionImpl extends RpcTarget implements MessageSession {
  #client: MailArchiverClient;
  #messageId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #disposed = false;

  constructor(client: MailArchiverClient, messageId: string, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#client = client;
    this.#messageId = messageId;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    disposeQueue(this.#approvalQueue);
  }

  async metadata(): Promise<MessageMetadata> {
    const meta = await this.#client.message(this.#messageId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read MailArchiver message",
      description: `Fetched metadata for message ${this.#messageId} (\`GET /api/messages/:id\`).`,
    });
    return meta;
  }

  async body(): Promise<MessageBody> {
    const body = await this.#client.body(this.#messageId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read MailArchiver message body",
      description: `Fetched body for message ${this.#messageId} (\`GET /api/messages/:id/body\`).`,
    });
    return body;
  }

  async attachments(): Promise<Attachment[]> {
    const attachments = await this.#client.attachments(this.#messageId);
    await this.#approvalQueue.authorizeObservation({
      title: "List MailArchiver attachments",
      description: `Listed attachments for message ${this.#messageId} (\`GET /api/messages/:id/attachments\`).`,
    });
    return attachments;
  }

  async attachment(attId: string): Promise<AttachmentContent> {
    const content = await this.#client.attachment(this.#messageId, attId);
    await this.#approvalQueue.authorizeObservation({
      title: "Download MailArchiver attachment",
      description:
        `Downloaded attachment ${attId} of message ${this.#messageId} ` +
        "(`GET /api/messages/:id/attachments/:attId`).",
    });
    return content;
  }

  async eml(): Promise<string> {
    const eml = await this.#client.eml(this.#messageId);
    await this.#approvalQueue.authorizeObservation({
      title: "Download MailArchiver .eml",
      description: `Fetched the raw .eml for message ${this.#messageId} (\`GET /api/messages/:id/eml\`).`,
    });
    return eml;
  }
}
