// vonBuschOS — Mail-Gatekeeper (K5-Port, VON-1818)
//
// Portiert `vonbusch/mail-gatekeeper` (VON-1802, CF `send_email`) auf die OS-`GatekeeperVendor`-
// Gadget-Schnittstelle. Erscheint als Kachel im bestehenden CloudflareOS-Deploy (Service
// `gatekeeper-vonbusch-mail` + Binding `GATEKEEPER_VONBUSCH_MAIL` am `workshop-backend`).
//
// Sicherheit / Approval-Modell (unverändert gegenüber dem MCP-Baustein):
//   - `proposeEmail` versendet NIE direkt: `submitAction()` reiht die Mail ein; erst nach
//     menschlichem Approval führt `applyAction()` den realen Versand über `env.EMAIL.send` aus.
//   - `listProposals` ist read-only und wird über `authorizeObservation()` autorisiert + auditiert.
//   - Sender-Allowlist, Header-Injection-Schutz und Längen-Caps bleiben im validateProposal-Kern.
//   - Interne, auto-provisionierte Accounts (kein OAuth): der Mailer hat keinen Remote-Login.
//     CF Access bleibt die Zugangsboundary (wie im Ursprungs-Baustein; kein per-Empfänger-ACL).
//
// Nur Klassen und der Default-Handler dürfen aus einem Worker-Entry-Modul exportiert werden.

import { DurableObject, WorkerEntrypoint, type RpcStub, RpcTarget } from "cloudflare:workers";
import { RpcStub as NativeRpcStub } from "capnweb";
import type {
  AccountDescription, ActionKind, AppUiContext, ApprovalQueue, Gatekeeper,
  GatekeeperConnectCallback, GatekeeperUiFrame, GatekeeperUser, GatekeeperUserVerifier,
  ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  MailSessionCore, MAIL_SEND_KIND,
  type ActionDescription, type PendingEmail, type ProposeEmailInput, type ProposalView,
  type SubmittedAction,
} from "./session-core";
import {
  parseAllowedFrom, resolveDefaultFrom, type QueueConfig,
} from "./mail-actions";
import { makeCloudflareMailer } from "./mailer";
import {
  buildMailAppHtml, MailManagementApi,
  type PendingApprovalSource, type PendingApprovalView,
} from "./app-ui";
import MAIL_CONFIGURATOR_HTML from "./generated/mail-configurator-ui.txt";
import type { MailConfiguratorRpc } from "./configurator/mail-configurator-types";

// ---------------------------------------------------------------------------

const VENDOR_HOST = "mail.vonbusch.app";
const RESOURCE_URL = `https://${VENDOR_HOST}/`;

const SUPPORTED_RESOURCES: SupportedResource[] = [{
  urlPattern: RESOURCE_URL,
  title: "vonBusch Mail",
  description: "Ausgehende E-Mails über den vonBusch-Mailer (CF send_email, noreply@vonbusch.app) " +
    "— mit menschlicher Freigabe versenden und den Status der eigenen Vorschläge lesen.",
}];

// Ein einziger Mail-Queue-Raum (Firmen-Singleton). Der DO wird per idFromName gepinnt.
const MAIL_SINGLETON = "vonbusch-mail";

// ---------------------------------------------------------------------------
// Ressourcen-Konfigurator-Capability (an das sandboxed iframe gereicht)

/** Liefert dem Konfigurator-iframe die feste Mail-Ressourcen-URL. Kein Zustand, keine Auswahl. */
class MailConfiguratorUi extends RpcTarget implements MailConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return RESOURCE_URL;
  }
}

// getTypeScriptTypes(): der Coding-Agent bekommt daraus die API-Oberfläche.
const TYPES_CODE = `
/** Eingabe eines Sende-Vorschlags. \`from\` ist optional (Standard: noreply@vonbusch.app) und muss,
 *  falls gesetzt, auf der Sender-Allowlist stehen. Genau EINE Empfängeradresse pro Vorschlag. */
export interface ProposeEmailInput {
  to: string;
  subject: string;
  text: string;
  from?: string;
  reason?: string;
}
/** Quittung einer eingereichten Sende-Aktion; der Versand folgt erst nach Human-Approval. */
export interface SubmittedAction { actionId: number; status: "pending_approval"; }
/** Statusansicht eines eigenen Vorschlags. */
export interface EmailProposalView {
  actionId: number;
  to: string;
  from: string;
  subject: string;
  status: "pending" | "sent" | "failed";
  proposedBy: string;
  error?: string;
}
/**
 * Der vonBusch-Mailer. Nichts wird direkt versendet: \`proposeEmail\` reiht eine Mail zur
 * menschlichen Freigabe ein und wird erst nach Approval über CF send_email gesendet.
 * \`listProposals\` ist eine auditierte Observation über die eigenen Vorschläge.
 */
export interface Mail {
  proposeEmail(input: ProposeEmailInput): Promise<SubmittedAction>;
  listProposals(): Promise<EmailProposalView[]>;
}
`;

const AVATAR = {
  // 1x1 transparentes GIF, damit hier nichts nach einem Netz-Asset greift.
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// Die öffentliche Mail-Fassade (Typ für den Session-Rückgabewert).
interface Mail {
  proposeEmail(input: ProposeEmailInput): Promise<SubmittedAction>;
  listProposals(): Promise<ProposalView[]>;
}

type AccountProps = { accountId: string };
type BindingProps = { accountId: string; resourceUrl: string };

/** Baut die Queue-Config (Sender-Allowlist + Caps) aus der Env. */
function makeConfig(env: Cloudflare.Env): QueueConfig {
  return { allowedFrom: parseAllowedFrom(env.ALLOWED_FROM, env.DEFAULT_FROM) };
}

/**
 * Stub auf den Mail-Approval-Index — eine deterministisch benannte `MailGatekeeper`-Instanz
 * (getByName(MAIL_SINGLETON)), die die offenen Sende-Freigaben aller Verbindungen bündelt. Sie ist
 * von jeder Facet (zum Spiegeln des Lebenszyklus) UND vom Account (startAppUi/ui) erreichbar; die
 * per-Verbindungs-Facets selbst sind vom Account NICHT adressierbar (Overseer-verwaltete IDs),
 * daher dieser gemeinsame, benennbare Index als einzige account-lesbare Sicht auf die Queue.
 */
function mailApprovalIndex(
  exports: Cloudflare.Exports,
): DurableObjectStub<MailGatekeeper> {
  const ns = exports.MailGatekeeper as unknown as DurableObjectNamespace<MailGatekeeper>;
  return ns.getByName(MAIL_SINGLETON);
}

/** Prüft, dass eine gebundene URL wirklich den Mailer adressiert. */
function assertMailUrl(url: string): void {
  const u = new URL(url);
  if (u.host !== VENDOR_HOST) throw new Error(`Keine vonBusch-Mail-URL: ${url}`);
}

// ---------------------------------------------------------------------------
// Vendor

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "vonBusch Mail",
      url: RESOURCE_URL,
      logo: AVATAR,
      tagline: "E-Mails mit Freigabe versenden.",
      description:
        "Sendet ausgehende E-Mails über den vonBusch-Mailer (CF send_email). Jeder Versand läuft " +
        "über Human-in-the-Loop-Approval; das Auflisten eigener Vorschläge ist eine auditierte " +
        "Observation.",
      // Kein OAuth: der Mailer hat keinen Remote-Login; wir provisionieren intern.
      autoProvisionsAccount: true,
    };
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const accountId = crypto.randomUUID();
    return this.ctx.exports.MailAccount({ props: { accountId } });
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("vonBusch Mail provisioniert Accounts intern; es gibt keinen Connect-Flow.");
  }
}

// ---------------------------------------------------------------------------
// Account

export class MailAccount
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "vonBusch Mail",
      uniqueName: this.ctx.props.accountId,
      avatar: AVATAR,
      // Macht den Mailer in der Board-UI als öffenbare App-Kachel nutzbar (VON-1847). Ohne
      // providesUi bleibt der Vendor nur ein gebundener Connector, nicht bedienbar.
      providesUi: { title: "vonBusch Mail — Freigaben", icon: AVATAR },
    };
  }

  /**
   * Approval-Queue-Panel (VON-1847): liest die offenen Mail-Sendefreigaben serverseitig aus dem
   * Approval-Index (deterministische MailGatekeeper-Singleton-Instanz) und backt den Snapshot ins
   * iframe-HTML. Der Erst-Render braucht kein Browser-capnweb; die mitgelieferte `ui`-Capability
   * (MailManagementApi) ermöglicht späteren Live-Refresh der Queue. Reine Anzeige — Freigeben/
   * Ablehnen bleibt allein beim OS-Approve-Pfad (menschliche ApprovalQueue → applyAction).
   */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const pending = await mailApprovalIndex(this.ctx.exports).listPendingApprovals();
    const source: PendingApprovalSource = {
      listPendingApprovals: () => mailApprovalIndex(this.ctx.exports).listPendingApprovals(),
    };
    const ui = new NativeRpcStub(new MailManagementApi(source));
    return { iframeHtml: buildMailAppHtml(pending, new Date().toISOString()), ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<Mail>>;
    resource: SupportedResource;
  }> {
    assertMailUrl(url);
    return {
      class: this.ctx.exports.MailGatekeeper({
        props: { accountId: this.ctx.props.accountId, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.MailVerifier({ props: this.ctx.props });
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async revoke(): Promise<void> {}

  /**
   * Ressourcen-Konfigurator (VON-1850): Der Mailer hat genau eine Ressource, es gibt nichts
   * auszuwählen — aber die OS-Connect-Modal-UI aktiviert „Add connection" erst, wenn ein
   * Konfigurator-Frame geladen ist und Bereitschaft meldet. Ohne diesen Frame blieb der Button
   * ausgegraut. Wir liefern das sandboxed Bestätigungs-Formular; seine `ui`-Capability gibt die
   * feste, serverseitig autoritative Mail-Ressourcen-URL zurück.
   */
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== RESOURCE_URL) {
      throw new Error(`Unbekannter Mail-Ressourcentyp: ${resourceUrlPattern}`);
    }
    return {
      iframeHtml: MAIL_CONFIGURATOR_HTML,
      ui: new NativeRpcStub(new MailConfiguratorUi()),
    };
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Keine Credentials zum Reconnect (interner Account).");
  }
}

/**
 * Meldet die Identität eines Beobachters. `GatekeeperUserVerifier` hat selbst keine Methoden;
 * Konvention (siehe dessen Deklaration): der Gatekeeper ergänzt eine eigene Methode und vertraut
 * der Antwort, weil der Overseer den Verifier nur an denselben Vendor zurückreicht.
 */
export interface MailVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class MailVerifier
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements MailVerifierApi {
  async identify(): Promise<string> {
    return this.ctx.props.accountId;
  }
}

// ---------------------------------------------------------------------------
// Session (RPC-Fähigkeit ans Gadget) — dünner RpcTarget um den transport-freien Kern.

class MailSessionRpc extends RpcTarget implements Mail {
  constructor(private readonly core: MailSessionCore) {
    super();
  }
  proposeEmail(input: ProposeEmailInput): Promise<SubmittedAction> { return this.core.proposeEmail(input); }
  listProposals(): Promise<ProposalView[]> { return this.core.listProposals(); }
}

// ---------------------------------------------------------------------------
// Gatekeeper (ein DO für den Mail-Queue-Raum, als Facet unter dem Overseer des Gadgets)

type StoredAction = {
  id: number;
  email: PendingEmail;
  status: "pending" | "sent" | "failed";
  messageId?: string;
  error?: string;
};

const ACTION_PREFIX = "action:";
const COUNTER_KEY = "meta:actionCounter"; // bewusst NICHT unter ACTION_PREFIX (kv.list-Kollision).

export class MailGatekeeper
    extends DurableObject<Cloudflare.Env, BindingProps> implements Gatekeeper<Mail> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: this.ctx.props.resourceUrl,
      title: "vonBusch Mail",
      snippet: "Ausgehende E-Mails (CF send_email) — Versand mit Freigabe, eigene Vorschläge lesen.",
      suggestedBindingName: "MAIL",
      tsType: "Mail",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Mailversand ist nie auto-approvable (extern sichtbarer Seiteneffekt). */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Mail> {
    const queue = approvalQueue.dup();
    const enqueuer = {
      enqueue: async (email: PendingEmail, description: ActionDescription): Promise<number> => {
        const id = this.#nextActionId();
        this.ctx.storage.kv.put<StoredAction>(`${ACTION_PREFIX}${id}`, { id, email, status: "pending" });
        await queue.submitAction(id, {
          title: description.title,
          description: description.description,
          implementsRevert: description.implementsRevert,
          awaitDecision: description.awaitDecision,
          actionKind: description.actionKind,
        });
        // In den account-lesbaren Approval-Index spiegeln, damit das Board-UI-Panel (startAppUi)
        // die offene Sende-Freigabe zeigt. Best-effort: ein Index-Fehler darf den (bereits
        // eingereihten) Approval-Fluss nicht brechen.
        await this.#mirrorPending(id, email);
        return id;
      },
    };
    const reader = {
      listProposals: async (): Promise<ProposalView[]> => this.#readProposals(),
    };
    const core = new MailSessionCore(
      makeConfig(this.env),
      queue,
      enqueuer,
      reader,
      resolveDefaultFrom(this.env.ALLOWED_FROM, this.env.DEFAULT_FROM),
      this.ctx.props.accountId,
    );
    return new MailSessionRpc(core);
  }

  #nextActionId(): number {
    const next = (this.ctx.storage.kv.get<number>(COUNTER_KEY) ?? 0) + 1;
    this.ctx.storage.kv.put(COUNTER_KEY, next);
    return next;
  }

  /** Verbindungs-/Facet-Kennung für den Index (dieselbe Facet ⇒ derselbe Token). */
  #connToken(): string {
    return this.ctx.props.accountId;
  }

  /** Spiegelt eine frisch eingereihte Mail in den gemeinsamen Approval-Index (best-effort). */
  async #mirrorPending(id: number, email: PendingEmail): Promise<void> {
    const view: PendingApprovalView = {
      connToken: this.#connToken(),
      actionId: id,
      to: email.to,
      from: email.from,
      subject: email.subject,
      text: email.text,
      reason: email.reason,
      proposedBy: email.proposedBy,
      proposedAt: Date.now(),
    };
    try {
      await mailApprovalIndex(this.ctx.exports).recordPendingApproval(view);
    } catch {
      // Index nicht erreichbar → Panel zeigt diese Mail evtl. nicht; Approval bleibt intakt.
    }
  }

  /** Entfernt eine versendete/abgelehnte Mail aus dem Index (best-effort). */
  async #unmirrorPending(id: number): Promise<void> {
    try {
      await mailApprovalIndex(this.ctx.exports).resolvePendingApproval(this.#connToken(), id);
    } catch {
      // Index nicht erreichbar → verwaister Eintrag; nächster startAppUi-Refresh gleicht ab.
    }
  }

  // --- Approval-Index (deterministische Singleton-Instanz, getByName(MAIL_SINGLETON)) ---------
  // Diese drei Methoden laufen auf der INDEX-Instanz; die per-Verbindungs-Facets rufen sie
  // cross-DO auf, der Account (startAppUi/ui) liest sie. Rein Sichtbarkeit — keine Sendegewalt.

  async recordPendingApproval(view: PendingApprovalView): Promise<void> {
    this.ctx.storage.kv.put<PendingApprovalView>(`pending:${view.connToken}:${view.actionId}`, view);
  }

  async resolvePendingApproval(connToken: string, actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`pending:${connToken}:${actionId}`);
  }

  async listPendingApprovals(): Promise<PendingApprovalView[]> {
    const out: PendingApprovalView[] = [];
    for (const [, v] of this.ctx.storage.kv.list<PendingApprovalView>({ prefix: "pending:" })) {
      out.push(v);
    }
    out.sort((a, b) => a.proposedAt - b.proposedAt);
    return out;
  }

  #readProposals(): ProposalView[] {
    const out: ProposalView[] = [];
    for (const [, v] of this.ctx.storage.kv.list<StoredAction>({ prefix: ACTION_PREFIX })) {
      out.push({
        actionId: v.id,
        to: v.email.to,
        from: v.email.from,
        subject: v.email.subject,
        status: v.status,
        proposedBy: v.email.proposedBy,
        error: v.error,
      });
    }
    // Neueste zuerst.
    return out.sort((a, b) => b.actionId - a.actionId);
  }

  /**
   * Der Mailer trägt kein per-Empfänger-ACL; wie im Ursprungs-Baustein ist CF Access die
   * Zugangsboundary. Jeder Beobachter mit dem Grant darf die eigenen Vorschläge sehen.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<MailVerifierApi>;
    const identity = await verifier.identify();
    this.ctx.storage.kv.put(`observer:${id}`, identity);
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  async applyAction(actionId: number): Promise<void> {
    const stored = this.ctx.storage.kv.get<StoredAction>(`${ACTION_PREFIX}${actionId}`);
    if (!stored) throw new Error(`Unbekannte Aktion: ${actionId}`);
    if (stored.status === "sent") return; // idempotent: kein Doppel-Versand
    const mailer = makeCloudflareMailer(this.env.EMAIL);
    try {
      const { id: messageId } = await mailer.send(stored.email);
      this.ctx.storage.kv.put<StoredAction>(`${ACTION_PREFIX}${actionId}`, { ...stored, status: "sent", messageId });
      // Freigabe erledigt (versendet) → aus dem Board-UI-Panel entfernen.
      await this.#unmirrorPending(actionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.ctx.storage.kv.put<StoredAction>(`${ACTION_PREFIX}${actionId}`, { ...stored, status: "failed", error: msg });
      // Nach menschlichem Approve ist die Mail nicht mehr „offen"; der Fehlerstatus bleibt unter
      // listProposals sichtbar, aber die Sende-Queue zeigt sie nicht mehr.
      await this.#unmirrorPending(actionId);
      throw e; // dem Overseer signalisieren, dass die freigegebene Aktion fehlschlug
    }
  }

  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`${ACTION_PREFIX}${actionId}`);
    // Abgelehnt → aus dem Board-UI-Panel entfernen.
    await this.#unmirrorPending(actionId);
  }

  async revertAction(actionId: number): Promise<{ message?: string }> {
    const stored = this.ctx.storage.kv.get<StoredAction>(`${ACTION_PREFIX}${actionId}`);
    if (!stored) return { message: "Aktion unbekannt — nichts zurückzunehmen." };
    // Eine versendete E-Mail kann nicht zurückgeholt werden.
    return {
      message: stored.status === "sent"
        ? "Versendete E-Mail kann nicht widerrufen werden; ggf. eine Korrektur-Mail senden."
        : "Vorschlag war noch nicht versendet; er wurde entfernt.",
    };
  }
}

// Stabiler Action-Kind-Katalog (Referenz auf MAIL_SEND_KIND); getAutoApprovableActions bleibt leer.
export const ACTION_KIND_CATALOG: ActionKind[] = [MAIL_SEND_KIND];

// Default-Handler: der Gatekeeper wird ausschließlich über RPC-Entrypoints (GatekeeperVendor etc.)
// angesprochen. Der fetch()-Handler existiert nur, damit der Worker ES-Module-Format hat (Pflicht
// für DO-Migrations) und beantwortet direkte HTTP-Zugriffe mit 404.
export default {
  async fetch(): Promise<Response> {
    return new Response("gatekeeper-vonbusch-mail: RPC-only", { status: 404 });
  },
};

// Referenz, um MAIL_SINGLETON nicht ungenutzt zu lassen: der Overseer pinnt den DO per idFromName
// auf diesen Singleton-Namen (ein Firmen-Mail-Queue-Raum).
export const SINGLETON_NAME = MAIL_SINGLETON;
