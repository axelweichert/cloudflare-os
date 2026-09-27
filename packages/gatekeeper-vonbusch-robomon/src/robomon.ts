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
import type { RoboMonInstanceConfiguratorRpc } from "./configurator/instance-configurator-types";
import {
  RoboMonClient,
  RoboMonError,
  ROBOMON_BASE_URL,
  type RoboMonCredentials,
} from "./robomon-api";
import type {
  RoboMonAlerts,
  RoboMonAutomationRule,
  RoboMonHistory,
  RoboMonKpis,
  RoboMonRobot,
  RoboMonServiceStatus,
  RoboMonSession,
  RoboMonSnapshot,
  RoboMonTicket,
} from "./types";
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
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/vonbusch-robomon");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// Resource descriptor
//
// RoboMon is a single fleet service, so there is exactly one grantable resource: read-only access
// to the whole fleet (robots, alerts, tickets, maintenance, automation). Per-customer scoping is a
// natural future granularity (a scoped "customer"/"distributor" token narrows what the fleet
// resource sees), but v1 offers the one whole-fleet resource.

// RoboMon brand mark: a small robot glyph, inline as an SVG data URL so it renders at the same
// visual weight as the other vendor logos wherever a gatekeeper logo is shown.
const ROBOMON_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\
<rect width="512" height="512" rx="96" fill="#0b3d91"/>\
<rect x="146" y="176" width="220" height="160" rx="28" fill="#fff"/>\
<circle cx="206" cy="256" r="26" fill="#0b3d91"/>\
<circle cx="306" cy="256" r="26" fill="#0b3d91"/>\
<rect x="238" y="120" width="36" height="48" rx="12" fill="#fff"/>\
<circle cx="256" cy="110" r="20" fill="#38bdf8"/>\
</svg>`;

const ROBOMON_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(ROBOMON_LOGO_SVG)}`;
const ROBOMON_ICON: AvatarImage = { url: ROBOMON_LOGO_URL };

const FLEET_RESOURCE: SupportedResource = {
  urlPattern: `${ROBOMON_BASE_URL}/*`,
  title: "RoboMon Fleet",
  description:
    "Read-only access to the von Busch RoboMon fleet: robot status, alerts, tickets, maintenance, " +
    "and automation rules.",
  icon: ROBOMON_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [FLEET_RESOURCE];

// ---------------------------------------------------------------------------
// HTML pages for the connect flow

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }) => `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RoboMon verbinden</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center; }
  .card { background: white; padding: 2rem; max-width: 540px; width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  h1 { margin-top: 0; font-size: 1.4rem; color: #0b3d91; }
  label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; color: #333; }
  input { width: 100%; box-sizing: border-box; padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, monospace; }
  details { margin-top: 1rem; font-size: 0.9rem; color: #555; }
  summary { cursor: pointer; color: #0b3d91; }
  button { margin-top: 1.5rem; padding: 0.6rem 1.5rem; background: #0b3d91; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #082d6e; }
  .error { background: #ffebee; color: #c62828; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
  .hint { font-size: 0.85rem; color: #666; margin-top: 0.25rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>RoboMon verbinden</h1>
    <p>Verbinde die von Busch RoboMon-Flotte mit dem Cloudflare OS. Der Zugriff ist <b>read-only</b>.</p>
    <p>Ein Token ist <b>optional</b>: Ohne Token liest der Konnektor die Flotte als „Viewer" (volle Flotte, nur lesend). Mit einem RoboMon-<code>service</code>-Token wird der Zugriff dem Konto zugeordnet.</p>
    ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
    <form method="POST" action="${escapeAttr(params.actionUrl)}">
      <label for="token">RoboMon-Token (optional)</label>
      <input id="token" name="token" type="password" placeholder="leer lassen fuer Viewer-Zugriff" autofocus>
      <div class="hint">Das Token wird verschluesselt gespeichert und nie wieder angezeigt. Es gewaehrt hier ausschliesslich Lesezugriff.</div>

      <details>
        <summary>Woher bekomme ich ein Token?</summary>
        <p>Ein Administrator legt in RoboMon unter „Konten" ein <code>service</code>-Konto an und erzeugt dafuer ein Token (POST /api/accounts/:id/token). Fuer den offenen Read-only-Zugriff ist kein Token noetig.</p>
      </details>

      <button type="submit">Verbinden</button>
    </form>
  </div>
</body>
</html>`;

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>Verbunden</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <script>window.close();</script>
  <h2 style="color: #0b3d91;">Verbunden!</h2>
  <p>Die RoboMon-Flotte ist jetzt mit dem Cloudflare OS verknuepft. Du kannst diesen Tab schliessen.</p>
</body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>Link abgelaufen</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; text-align: center;">
  <h2 style="color: #d97706;">Verbindungslink abgelaufen</h2>
  <p>Dieser Link ist ungueltig oder abgelaufen. Bitte kehre zum Cloudflare OS zurueck und starte neu.</p>
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
        // A token is optional: blank means read-only viewer access.
        const tokenInput = String(formData.get("token") ?? "").trim();

        const result = await stub.completeConnection(nonce, tokenInput);
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
      displayName: "RoboMon",
      url: ROBOMON_BASE_URL,
      logo: ROBOMON_ICON,
      color: "#0b3d91",
      tagline: "Read your von Busch service-robot fleet: status, alerts, tickets, maintenance.",
      description:
        "Connect the von Busch RoboMon fleet so Cloudflare OS can read robot status, the alert " +
        "center, the ticket queue, maintenance/wear, and automation rules. Build dashboards and " +
        "triage agents that watch the fleet, surface overdue maintenance, or report on open " +
        "tickets. Read-only.",
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
// UserAccount DO — stores the (optional) token for a connected account

interface StoredCredentials {
  /** Optional RoboMon token. Empty string = viewer (read-only, whole fleet). */
  token: string;
  /** The role RoboMon reported for the token at connect time (informational). */
  role?: string;
  /** The account label RoboMon reported, if any (informational). */
  label?: string | null;
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

  async completeConnection(nonce: string, token: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    // Validate that we can reach RoboMon and that the token (if any) is accepted.
    let role = "viewer";
    let label: string | null = null;
    try {
      const who = await new RoboMonClient({ token }).ping();
      role = who.role;
      label = who.label;
    } catch (e: any) {
      const msg = e instanceof RoboMonError
        ? e.message
        : `Unable to reach the RoboMon API: ${e?.message ?? e}`;
      return { kind: "error", message: msg };
    }

    // Consume the nonce now that we've validated.
    this.ctx.storage.kv.delete("nonce");

    this.ctx.storage.kv.put<StoredCredentials>("credentials", { token, role, label });
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
        const props: RoboMonUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.RoboMonUserImpl({ props }));
      } catch (e: any) {
        this.ctx.storage.kv.delete("credentials");
        return { kind: "error", message: `Failed to notify workshop: ${e?.message ?? e}` };
      }
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): RoboMonCredentials {
    const creds = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!creds) {
      throw new Error("RoboMon credentials are not configured for this account.");
    }
    return { token: creds.token };
  }

  getStored(): StoredCredentials {
    const creds = this.ctx.storage.kv.get<StoredCredentials>("credentials");
    if (!creds) {
      throw new Error("RoboMon credentials are not configured for this account.");
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

type RoboMonUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class RoboMonUserImpl
  extends WorkerEntrypoint<Env, RoboMonUserImplProps>
  implements GatekeeperUser
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<RoboMonCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<AccountDescription> {
    let displayName = "RoboMon";
    let uniqueName = "RoboMon Fleet";
    try {
      const stored = await this.#userAccount().getStored();
      const who = await new RoboMonClient({ token: stored.token }).whoami();
      const role = who.label ?? who.role;
      displayName = `RoboMon (${role})`;
      uniqueName = `RoboMon Fleet (${who.role})`;
    } catch (e) {
      if (e instanceof RoboMonError && e.isAuthError) {
        await this.#userAccount().noteCredentialsExpired();
      }
      // Ignore other failures; fall back to defaults.
    }
    return { displayName, uniqueName, avatar: ROBOMON_ICON };
  }

  /** This gatekeeper does not provide sign-in. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== FLEET_RESOURCE.urlPattern) {
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
    // The token is whole-fleet, so every URL resolves to the one whole-fleet resource. We still
    // validate the URL is well-formed http(s) so a nonsensical binding fails early.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Unsupported URL scheme for RoboMon: ${parsed.protocol}`);
      }
    } catch (e: any) {
      throw new Error(`Invalid RoboMon URL "${url}": ${e?.message ?? e}`, { cause: e });
    }
    return {
      class: this.ctx.exports.RoboMonGatekeeperImpl({
        props: { userObjectId: this.ctx.props.userObjectId },
      }),
      resource: FLEET_RESOURCE,
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
   * Mint a verifier representing this account. RoboMon uses the "low-stakes" observer strategy (see
   * RoboMonGatekeeperImpl.addObserver): the fleet resource is read-only, and its default access
   * level is the public viewer role (robomon.vonbusch.app is an open read-only demo), so there is
   * no per-observer ACL oracle to check against. The verifier carries no identity and is never
   * consulted — but the overseer mints one on every open, so it must exist and not throw.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.RoboMonVerifier({});
  }
}

// A trivial verifier since RoboMon's observer strategy is low-stakes.
@validateRpc()
export class RoboMonVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// ---------------------------------------------------------------------------
// Configurator UI for the whole-fleet resource.
//
// The whole-fleet resource has no user-selectable inputs; once the fleet is connected the resource
// URL is fully determined. The configurator only confirms and reports readiness. It is treated as
// untrusted, so it exposes nothing but the fixed fleet URL.

@validateRpc()
class InstanceConfiguratorUI extends RpcTarget implements RoboMonInstanceConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return ROBOMON_BASE_URL;
  }
}

// ---------------------------------------------------------------------------
// GatekeeperImpl

type RoboMonGatekeeperImplProps = {
  userObjectId: string;
};

@validateRpc()
export class RoboMonGatekeeperImpl
  extends DurableObject<Env, RoboMonGatekeeperImplProps>
  implements Gatekeeper<RoboMonSession>
{
  #userAccount() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async #getCreds(): Promise<RoboMonCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    let title = "RoboMon Fleet";
    try {
      const stored = await this.#userAccount().getStored();
      const who = await new RoboMonClient({ token: stored.token }).whoami();
      title = `RoboMon Fleet (${who.role})`;
    } catch {
      // Fall back to the default title.
    }
    return {
      url: ROBOMON_BASE_URL,
      title,
      snippet: "Read-only access to the von Busch RoboMon fleet: status, alerts, tickets, maintenance.",
      suggestedBindingName: "ROBOMON_FLEET",
      tsType: "RoboMonSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<RoboMonSession> {
    const creds = await this.#getCreds();
    return new RoboMonSessionImpl(creds, approvalQueue.dup(), () =>
      this.#userAccount().noteCredentialsExpired(),
    );
  }

  // This gatekeeper is read-only: it never submits an action, so these never fire in practice.
  // They throw clearly if the overseer ever calls back with an id we never issued.
  async applyAction(actionId: number): Promise<void> {
    throw new Error(`No queued RoboMon action exists with id ${actionId}; this gatekeeper is read-only.`);
  }

  async rejectAction(_actionId: number): Promise<void> {
    // Nothing to clean up — no actions are ever stored.
  }

  async revertAction(_actionId: number): Promise<void> {
    throw new Error("This gatekeeper is read-only; there is nothing to revert.");
  }

  /**
   * Observer tracking: RoboMon uses the "low-stakes" strategy. The fleet resource is read-only and
   * its baseline access is the public viewer role (the dashboard is an open read-only demo), so any
   * collaborator may observe: addObserver/removeObserver are no-ops and we never set
   * excludeObservers on observations.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Session — whole-fleet, read-only.

class RoboMonSessionImpl extends RpcTarget implements RoboMonSession {
  #client: RoboMonClient;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #noteAuthError: () => Promise<void>;
  #disposed = false;

  constructor(
    creds: RoboMonCredentials,
    approvalQueue: RpcStub<ApprovalQueue>,
    noteAuthError: () => Promise<void>,
  ) {
    super();
    this.#client = new RoboMonClient(creds);
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

  /** Run a read against RoboMon, flagging auth failures so the account can be marked expired. */
  async #read<T>(fn: (c: RoboMonClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.#client);
    } catch (e) {
      if (e instanceof RoboMonError && e.isAuthError) {
        await this.#noteAuthError();
      }
      throw e;
    }
  }

  async getSnapshot(): Promise<RoboMonSnapshot> {
    const snap = await this.#read((c) => c.getSnapshot());
    await this.#approvalQueue.authorizeObservation({
      title: "Read RoboMon fleet snapshot",
      description:
        `Read the RoboMon fleet snapshot: ${snap.robots.length} robot` +
        `${snap.robots.length === 1 ? "" : "s"} across ${snap.customers.length} customer` +
        `${snap.customers.length === 1 ? "" : "s"}.`,
    });
    return snap;
  }

  async listRobots(): Promise<RoboMonRobot[]> {
    const robots = await this.#read((c) => c.listRobots());
    await this.#approvalQueue.authorizeObservation({
      title: "List RoboMon robots",
      description: `Listed ${robots.length} robot${robots.length === 1 ? "" : "s"} in the fleet.`,
    });
    return robots;
  }

  async getKpis(): Promise<RoboMonKpis> {
    const kpis = await this.#read((c) => c.getKpis());
    await this.#approvalQueue.authorizeObservation({
      title: "Read RoboMon KPIs",
      description: `Read fleet KPIs (${kpis.total} robots, ${kpis.openAlerts} open alerts).`,
    });
    return kpis;
  }

  async getAlerts(): Promise<RoboMonAlerts> {
    const alerts = await this.#read((c) => c.getAlerts());
    await this.#approvalQueue.authorizeObservation({
      title: "Read RoboMon alert center",
      description:
        `Read ${alerts.total} open alert${alerts.total === 1 ? "" : "s"} ` +
        `(${alerts.counts.critical} critical, ${alerts.counts.warning} warning).`,
    });
    return alerts;
  }

  async listTickets(status?: string, kind?: string): Promise<RoboMonTicket[]> {
    const tickets = await this.#read((c) => c.listTickets(status, kind));
    const filt = [status ? `status=${status}` : null, kind ? `kind=${kind}` : null]
      .filter(Boolean)
      .join(", ");
    await this.#approvalQueue.authorizeObservation({
      title: "List RoboMon tickets",
      description:
        `Listed ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}` +
        (filt ? ` (${filt}).` : "."),
    });
    return tickets;
  }

  async getServiceStatus(): Promise<RoboMonServiceStatus> {
    const service = await this.#read((c) => c.getServiceStatus());
    await this.#approvalQueue.authorizeObservation({
      title: "Read RoboMon maintenance status",
      description: `Read maintenance / wear status for ${service.robots.length} robot${service.robots.length === 1 ? "" : "s"}.`,
    });
    return service;
  }

  async listAutomationRules(): Promise<RoboMonAutomationRule[]> {
    const rules = await this.#read((c) => c.listAutomationRules());
    await this.#approvalQueue.authorizeObservation({
      title: "List RoboMon automation rules",
      description: `Listed ${rules.length} automation rule${rules.length === 1 ? "" : "s"}.`,
    });
    return rules;
  }

  async getRobotHistory(robotId: string, range?: string): Promise<RoboMonHistory> {
    const history = await this.#read((c) => c.getRobotHistory(robotId, range));
    await this.#approvalQueue.authorizeObservation({
      title: `Read RoboMon battery history for ${robotId}`,
      description:
        `Read the battery time series for robot \`${robotId}\` ` +
        `(range ${history.range}, ${history.points.length} points).`,
    });
    return history;
  }
}
