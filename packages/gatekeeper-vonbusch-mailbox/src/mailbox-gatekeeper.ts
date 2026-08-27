// vonBuschOS — Mailbox-Gatekeeper (K1-Port, VON-1815)
//
// Portiert `vonbusch/mailbox-gatekeeper` (VON-1797/1798) auf die OS-`GatekeeperVendor`-Gadget-
// Schnittstelle. Erscheint als Kachel im bestehenden CloudflareOS-Deploy (Service
// `gatekeeper-vonbusch-mailbox` + Binding `GATEKEEPER_VONBUSCH_MAILBOX` am `workshop-backend`).
//
// Sicherheit (siehe docs/vonbusch/VON-1798-security-review.md):
//   - Interne, auto-provisionierte Accounts (kein OAuth): agentic-inbox hat keinen Remote-Login.
//   - Per-Mailbox-authz: `getSupportedResources({userId})` blendet den Gatekeeper für Nicht-
//     Berechtigte aus (leere Liste ⇒ unsichtbar); `addObserver` prüft die ACL erneut fail-closed.
//     Das schließt die Lücke „CF Access war die EINZIGE Boundary".
//   - Die gepinnte Mailbox steckt im Grant (DO-props), NIE in einem Aufruf-Argument.
//   - Reads → `approvalQueue.authorizeObservation()`, Sends/Replies → `submitAction()` → `applyAction()`.
//
// Nur Klassen und der Default-Handler dürfen aus einem Worker-Entry-Modul exportiert werden.

import { DurableObject, WorkerEntrypoint, type RpcStub, RpcTarget } from "cloudflare:workers";
import { RpcStub as NativeRpcStub } from "capnweb";
import type {
  AccountDescription, ActionKind, AppUiContext, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback,
  GatekeeperUiFrame, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame,
  ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { MailboxManagementApi, buildMailboxAppHtml, buildMailboxAppView } from "./app-ui";
import {
  McpMailboxBackend, type MailboxBackend, type MailboxDraft, type MailboxMessage, type MailboxThread,
} from "./mailbox-backend";
import {
  MailboxSessionCore, applyMailAction,
  type ActionDescription, type PendingMailAction,
} from "./session-core";
import { parseAcl, canObserveMailbox, canBindAnyMailbox } from "./mailbox-authz";
import type { Mailbox } from "./mailbox-api";
import MAILBOX_CONFIGURATOR_HTML from "./generated/mailbox-configurator-ui.txt";
import type { MailboxConfiguratorRpc } from "./configurator/mailbox-configurator-types";

// ---------------------------------------------------------------------------

const VENDOR_HOST = "mail.vonbusch.app";
const RESOURCE_PREFIX = `https://${VENDOR_HOST}/inbox/`;
const RESOURCE_PATTERN = `${RESOURCE_PREFIX}*`;

const SUPPORTED_RESOURCES: SupportedResource[] = [{
  urlPattern: RESOURCE_PATTERN,
  title: "vonBusch Mailbox",
  description: "Eine einzelne, fest gepinnte agentic-inbox-Mailbox (Threads lesen, Mail senden/antworten).",
}];

// getTypeScriptTypes(): der Coding-Agent bekommt daraus die API-Oberfläche.
const TYPES_CODE = `
/** Ein E-Mail-Thread (Konversation) in der gepinnten Mailbox. */
export interface MailboxThread { id: string; subject: string; snippet?: string; updatedAt?: string; }
/** Eine einzelne Nachricht in der gepinnten Mailbox. */
export interface MailboxMessage {
  id: string; threadId?: string; from: string; to: string[]; subject: string; text: string; receivedAt?: string;
}
/** Entwurf einer zu sendenden Nachricht. */
export interface MailboxDraft { to: string[]; subject: string; text: string; }
/** Quittung einer eingereichten schreibenden Aktion; die Wirkung folgt erst nach Human-Approval. */
export interface SubmittedAction { actionId: number; status: "pending_approval"; }
/**
 * Die RPC-Fähigkeit einer gebundenen Mailbox. Reads laufen (nach Observation-Autorisierung) sofort;
 * schreibende Aktionen werden zur Freigabe eingereiht und erst nach Approval ausgeführt.
 * Es gibt bewusst KEIN Mailbox-Argument — die Mailbox steckt im Grant.
 */
export interface Mailbox {
  listThreads(query?: string): Promise<MailboxThread[]>;
  getThread(threadId: string): Promise<MailboxThread | null>;
  listMessages(threadId?: string): Promise<MailboxMessage[]>;
  getMessage(messageId: string): Promise<MailboxMessage | null>;
  sendMessage(draft: MailboxDraft): Promise<SubmittedAction>;
  reply(threadId: string, text: string): Promise<SubmittedAction>;
}
`;

// ---------------------------------------------------------------------------
// Ressourcen-Konfigurator-Capability (an das sandboxed iframe gereicht).
//
// Baut die konkrete `.../inbox/<id>`-URL aus der eingegebenen Inbox-ID — serverseitig autoritativ:
// Host/Prefix/Encoding leben nur hier (`buildResourceUrl`), das iframe kennt sie nicht.

/** Baut die Mailbox-Ressourcen-URL aus einer Inbox-ID (validiert). Eine Quelle der Wahrheit. */
function buildResourceUrl(inboxId: string): string {
  const id = inboxId.trim();
  if (!id) throw new Error("Inbox-ID darf nicht leer sein.");
  const url = `${RESOURCE_PREFIX}${encodeURIComponent(id)}`;
  // Fail-fast: die gebaute URL muss vom Bind-Pfad (`mailboxFromUrl`) wieder akzeptiert werden.
  mailboxFromUrl(url);
  return url;
}

class MailboxConfiguratorUi extends RpcTarget implements MailboxConfiguratorRpc {
  async resourceUrl(inboxId: string): Promise<string> {
    return buildResourceUrl(inboxId);
  }
}

const AVATAR = {
  // 1x1 transparentes GIF, damit hier nichts nach einem Netz-Asset greift.
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// Die Env stammt aus der generierten worker-configuration.d.ts (`Cloudflare.Env`); das optionale
// Upstream-Secret wird in env.d.ts hineingemerged. Bindings/Vars siehe wrangler.jsonc:
//   UPSTREAM_MCP_URL       — agentic-inbox /mcp (Var)
//   MAILBOX_UPSTREAM_TOKEN — Bearer-Secret (optional, wrangler secret put)
//   MAILBOX_ACL            — JSON-ACL (Var/Secret)

type AccountProps = { accountId: string };
type BindingProps = { accountId: string; mailbox: string; resourceUrl: string };

/** Baut das Backend aus der Env. Ausgelagert, damit Session und applyAction dieselbe Quelle nutzen. */
function makeBackend(env: Cloudflare.Env): MailboxBackend {
  // VON-1821 Direktive B: liegt das Service-Binding auf den agentic-inbox-Worker vor, laufen alle
  // Upstream-Calls intern darüber (umgeht CF Access, kein Bearer). Sonst globaler fetch + Token.
  const service = env.MAIL_SERVICE;
  return new McpMailboxBackend({
    upstreamUrl: env.UPSTREAM_MCP_URL,
    authToken: service ? undefined : env.MAILBOX_UPSTREAM_TOKEN,
    fetch: service ? (input, init) => service.fetch(input, init) : undefined,
  });
}

/** Parst die Mailbox-ID aus einer Ressourcen-URL (`.../inbox/<id>`). */
function mailboxFromUrl(url: string): string {
  const u = new URL(url);
  if (u.host !== VENDOR_HOST || !u.pathname.startsWith("/inbox/")) {
    throw new Error(`Keine vonBusch-Mailbox-URL: ${url}`);
  }
  const id = decodeURIComponent(u.pathname.slice("/inbox/".length));
  if (!id) throw new Error(`Mailbox-URL ohne Inbox-ID: ${url}`);
  return id;
}

// ---------------------------------------------------------------------------
// Vendor

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "vonBusch Mailbox",
      url: `https://${VENDOR_HOST}`,
      logo: AVATAR,
      tagline: "Eine gepinnte Mailbox lesen und (mit Freigabe) beantworten.",
      description:
        "Bindet genau EINE agentic-inbox-Mailbox ein. Reads sind auditierte Observations, " +
        "ausgehende Mail läuft über Human-in-the-Loop-Approval. Interne per-Mailbox-Autorisierung.",
      // Kein OAuth: agentic-inbox hat keinen Remote-Login; wir provisionieren intern.
      autoProvisionsAccount: true,
    };
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const accountId = crypto.randomUUID();
    return this.ctx.exports.MailboxAccount({ props: { accountId } });
  }

  /**
   * Interner Gatekeeper: mit `userId` blenden wir für Nicht-Berechtigte aus (leere Liste ⇒
   * unsichtbar). Ohne `userId` (Vendor-Karte) zeigen wir den Ressourcentyp.
   */
  async getSupportedResources(options?: { userId?: string }): Promise<SupportedResource[]> {
    if (options?.userId !== undefined) {
      const acl = parseAcl(this.env.MAILBOX_ACL);
      // Sichtbar, wenn der Nutzer mind. eine Mailbox binden darf — oder Admin ist. Admins dürfen JEDE
      // (auch noch nicht gelistete) Inbox-ID per Konfigurator binden; ohne diese Ausnahme wäre der
      // Vendor bei leerem `mailboxes` selbst für den Admin unsichtbar (VON-1864).
      if (!canBindAnyMailbox(acl, options.userId)) return [];
    }
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("vonBusch Mailbox provisioniert Accounts intern; es gibt keinen Connect-Flow.");
  }
}

// ---------------------------------------------------------------------------
// Account

export class MailboxAccount
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "vonBusch Mailbox",
      uniqueName: this.ctx.props.accountId,
      avatar: AVATAR,
      // Macht die Mailbox in der Board-UI als oeffenbare App-Kachel nutzbar (VON-1845). Ohne
      // providesUi bleibt der Vendor nur ein gebundener Connector, nicht bedienbar.
      providesUi: { title: "vonBusch Mailbox", icon: AVATAR },
    };
  }

  /**
   * Read-only Management-Frame (VON-1845): leitet Sicherheits-/Freigabe-Haltung serverseitig aus der
   * Env ab (ACL-Metadaten, Backend-Modus) und backt sie ins netzisolierte iframe-HTML. Der
   * Erst-Render braucht kein Browser-capnweb; die mitgelieferte `ui`-Capability
   * (MailboxManagementApi) ermoeglicht spaeteren Live-Refresh. Zeigt bewusst nur Metadaten — nie
   * ACL-Identitaeten oder Tokens.
   */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const view = buildMailboxAppView({
      aclRaw: this.env.MAILBOX_ACL,
      isAdmin: context.isAdmin,
      hasService: !!this.env.MAIL_SERVICE,
      hasToken: !!this.env.MAILBOX_UPSTREAM_TOKEN,
      upstreamUrl: this.env.UPSTREAM_MCP_URL,
    });
    const ui = new NativeRpcStub(new MailboxManagementApi(view));
    return { iframeHtml: buildMailboxAppHtml(view), ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<Mailbox>>;
    resource: SupportedResource;
  }> {
    const mailbox = mailboxFromUrl(url);
    return {
      class: this.ctx.exports.MailboxGatekeeper({
        props: { accountId: this.ctx.props.accountId, mailbox, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.MailboxVerifier({ props: this.ctx.props });
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async revoke(): Promise<void> {}

  /**
   * Ressourcen-Konfigurator (VON-1864): Anders als CRM/Mail (feste Einzelressource) verlangt die
   * Mailbox eine konkrete Inbox-ID in der URL (`.../inbox/<id>`). Wir liefern das sandboxed Formular
   * mit EINEM Eingabefeld; seine `ui`-Capability baut die serverseitig autoritative Ressourcen-URL.
   * Ohne diesen Frame (bzw. wenn hier geworfen wird) bleibt „Add connection" in der OS-Connect-Modal
   * ausgegraut.
   */
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== RESOURCE_PATTERN) {
      throw new Error(`Unbekannter Mailbox-Ressourcentyp: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: MAILBOX_CONFIGURATOR_HTML,
      ui: new NativeRpcStub(new MailboxConfiguratorUi()),
    };
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Keine Credentials zum Reconnect (interner Account).");
  }
}

/**
 * Meldet, welche Identität ein Beobachter hat. `GatekeeperUserVerifier` hat selbst keine Methoden;
 * Konvention (siehe dessen Deklaration): der Gatekeeper ergänzt eine eigene Methode und vertraut der
 * Antwort, weil der Overseer den Verifier nur an denselben Vendor zurückreicht.
 *
 * HINWEIS (Deploy-Gate): In der Auto-Provision-Variante trägt der Account keine provider-verifizierte
 * E-Mail. `identify()` gibt daher die stabile Account-Identität zurück; die Zuordnung realer
 * Nutzer-Identitäten → ACL ist Teil des CEO-Live-Bind-Schritts.
 */
export interface MailboxVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class MailboxVerifier
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements MailboxVerifierApi {
  async identify(): Promise<string> {
    return this.ctx.props.accountId;
  }
}

// ---------------------------------------------------------------------------
// Session (RPC-Fähigkeit ans Gadget) — dünner RpcTarget um den transport-freien Kern.

class MailboxSessionRpc extends RpcTarget implements Mailbox {
  constructor(private readonly core: MailboxSessionCore) {
    super();
  }
  listThreads(query?: string): Promise<MailboxThread[]> { return this.core.listThreads(query); }
  getThread(threadId: string): Promise<MailboxThread | null> { return this.core.getThread(threadId); }
  listMessages(threadId?: string): Promise<MailboxMessage[]> { return this.core.listMessages(threadId); }
  getMessage(messageId: string): Promise<MailboxMessage | null> { return this.core.getMessage(messageId); }
  sendMessage(draft: MailboxDraft) { return this.core.sendMessage(draft); }
  reply(threadId: string, text: string) { return this.core.reply(threadId, text); }
}

// ---------------------------------------------------------------------------
// Gatekeeper (ein DO je gebundener Mailbox, als Facet unter dem Overseer des Gadgets)

type StoredAction = { id: number; action: PendingMailAction; status: "pending" | "applied" };

export class MailboxGatekeeper
    extends DurableObject<Cloudflare.Env, BindingProps> implements Gatekeeper<Mailbox> {
  async describe(): Promise<ResourceDescription> {
    const mailbox = this.ctx.props.mailbox;
    return {
      url: this.ctx.props.resourceUrl,
      title: `Mailbox ${mailbox}`,
      snippet: `Die agentic-inbox-Mailbox \`${mailbox}\`, fest gepinnt.`,
      suggestedBindingName: "MAILBOX",
      tsType: "Mailbox",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Mailversand ist nie auto-approvable (kann Daten nach außen tragen). */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Mailbox> {
    const mailbox = this.ctx.props.mailbox;
    const backend = makeBackend(this.env);
    const queue = approvalQueue.dup();
    const enqueuer = {
      enqueue: async (action: PendingMailAction, description: ActionDescription): Promise<number> => {
        const id = this.#nextActionId();
        this.ctx.storage.kv.put<StoredAction>(`action:${id}`, { id, action, status: "pending" });
        await queue.submitAction(id, {
          title: description.title,
          description: description.description,
          implementsRevert: description.implementsRevert,
          awaitDecision: description.awaitDecision,
          actionKind: description.actionKind,
        });
        return id;
      },
    };
    const core = new MailboxSessionCore(mailbox, backend, queue, enqueuer);
    return new MailboxSessionRpc(core);
  }

  #nextActionId(): number {
    const next = (this.ctx.storage.kv.get<number>("action:counter") ?? 0) + 1;
    this.ctx.storage.kv.put("action:counter", next);
    return next;
  }

  /**
   * Per-Mailbox-Autorisierung (fail-closed). Prüft, dass der neue Beobachter die gebundene Mailbox
   * sehen darf, bevor er Zugriff auf bereits Gelesenes bekommt. Schließt die VON-1798-Lücke.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<MailboxVerifierApi>;
    const identity = await verifier.identify();
    const acl = parseAcl(this.env.MAILBOX_ACL);
    if (!canObserveMailbox(acl, this.ctx.props.mailbox, identity)) {
      throw new Error(
        `Beobachter \`${identity}\` ist für die Mailbox \`${this.ctx.props.mailbox}\` nicht ` +
        `autorisiert.`);
    }
    this.ctx.storage.kv.put(`observer:${id}`, identity);
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  async applyAction(actionId: number): Promise<void> {
    const stored = this.ctx.storage.kv.get<StoredAction>(`action:${actionId}`);
    if (!stored) throw new Error(`Unbekannte Aktion: ${actionId}`);
    await applyMailAction(this.ctx.props.mailbox, makeBackend(this.env), stored.action);
    this.ctx.storage.kv.put<StoredAction>(`action:${actionId}`, { ...stored, status: "applied" });
  }

  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`action:${actionId}`);
  }

  async revertAction(_actionId: number): Promise<{ message?: string }> {
    // Ausgehende Mail lässt sich nicht automatisch zurückholen.
    return { message: "Gesendete E-Mail kann nicht automatisch widerrufen werden." };
  }
}

// Default-Handler: der Gatekeeper wird ausschließlich über RPC-Entrypoints (GatekeeperVendor etc.)
// angesprochen. Der fetch()-Handler existiert nur, damit der Worker ES-Module-Format hat (Pflicht
// für DO-Migrations) und beantwortet direkte HTTP-Zugriffe mit 404.
export default {
  async fetch(): Promise<Response> {
    return new Response("gatekeeper-vonbusch-mailbox: RPC-only", { status: 404 });
  },
};
