// vonBuschOS — CRM-Gatekeeper (K2-Port, VON-1817)
//
// Portiert `vonbusch/crm-gatekeeper` (VON-1800, vonbusch-crm-eu) auf die OS-`GatekeeperVendor`-
// Gadget-Schnittstelle. Erscheint als Kachel im bestehenden CloudflareOS-Deploy (Service
// `gatekeeper-vonbusch-crm` + Binding `GATEKEEPER_VONBUSCH_CRM` am `workshop-backend`).
//
// Sicherheit / Approval-Modell (unverändert gegenüber dem MCP-Baustein):
//   - Reads (contact|deal|activity) sind read-only und werden über `authorizeObservation()`
//     autorisiert + auditiert — direkte Rückgabe, kein Approval.
//   - Writes (create/update contact|deal|activity) laufen NIE direkt: `submitAction()` reiht sie
//     ein; erst nach menschlichem Approval führt `applyAction()` die parametrisierte D1-Mutation
//     gegen vonbusch-crm-eu aus (Spalten-Allowlist + LIMIT-Caps + kein Doppel-Write bleiben).
//   - Interne, auto-provisionierte Accounts (kein OAuth): das CRM hat keinen Remote-Login.
//     CF Access bleibt die Zugangsboundary (wie im Ursprungs-Baustein; kein per-Datensatz-ACL).
//
// Nur Klassen und der Default-Handler dürfen aus einem Worker-Entry-Modul exportiert werden.

import { DurableObject, WorkerEntrypoint, type RpcStub, RpcTarget } from "cloudflare:workers";
import { RpcStub as NativeRpcStub } from "capnweb";
import type {
  AccountDescription, ActionKind, AppUiContext, ApprovalQueue, Gatekeeper,
  GatekeeperConnectCallback, GatekeeperUiFrame, GatekeeperUser, GatekeeperUserVerifier,
  ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { D1CrmStore, type CrmStore, type ReadOptions, type CrmRow } from "./crm-store";
import {
  CrmSessionCore, applyCrmAction, CRM_WRITE_KIND,
  type ActionDescription, type PendingCrmAction, type ProposeInput, type SubmittedAction,
} from "./session-core";
import {
  buildCrmAppHtml, CrmManagementApi,
  type PendingApprovalSource, type PendingApprovalView,
} from "./app-ui";

// ---------------------------------------------------------------------------

const VENDOR_HOST = "crm.vonbusch.app";
const RESOURCE_URL = `https://${VENDOR_HOST}/`;

const SUPPORTED_RESOURCES: SupportedResource[] = [{
  urlPattern: RESOURCE_URL,
  title: "vonBusch CRM",
  description: "Das vonBusch-CRM (vonbusch-crm-eu): Kontakte, Deals und Aktivitäten lesen und " +
    "— mit menschlicher Freigabe — schreiben.",
}];

// Ein einziger CRM-„Datensatz-Raum" (Firmen-Singleton). Der DO wird per idFromName gepinnt.
const CRM_SINGLETON = "vonbusch-crm";

// getTypeScriptTypes(): der Coding-Agent bekommt daraus die API-Oberfläche.
const TYPES_CODE = `
/** Ein CRM-Datensatz (Kontakt/Deal/Aktivität) als flache Spalte→Wert-Abbildung. */
export type CrmRow = Record<string, string | number | boolean | null>;
/** Leseoptionen: Freitextsuche, contact_id-Filter (Deals/Aktivitäten), LIMIT-Cap 200 (Default 50). */
export interface ReadOptions { search?: string; contactId?: string; limit?: number; offset?: number; }
/** Eingabe eines Schreibvorschlags. \`fields\` akzeptiert nur allowlistete Spalten. */
export interface ProposeInput {
  op: "create" | "update";
  /** Pflicht bei update, verboten bei create. */
  targetId?: string;
  fields: Record<string, string | number | boolean | null>;
  reason?: string;
}
/** Quittung einer eingereichten schreibenden Aktion; die Wirkung folgt erst nach Human-Approval. */
export interface SubmittedAction { actionId: number; status: "pending_approval"; }
/**
 * Die RPC-Fähigkeit des vonBusch-CRM. Reads sind auditierte Observations und laufen sofort;
 * Writes (propose*) werden zur menschlichen Freigabe eingereiht und erst nach Approval ausgeführt.
 * Erlaubte Spalten (echtes Prod-Schema vonbusch-crm-eu, VON-1850):
 *   contact:  first_name, last_name, email, phone, mobile, position, department, company_id, status, account_manager_id, notes
 *   deal:     title, company_id, contact_id, owner_id, bereich, stage, value, probability, expected_close, status, notes
 *   activity: type, subject, body, contact_id, deal_id, company_id, owner_id, status, due_at, prio
 */
export interface Crm {
  listContacts(opts?: ReadOptions): Promise<CrmRow[]>;
  getContact(id: string): Promise<CrmRow | null>;
  listDeals(opts?: ReadOptions): Promise<CrmRow[]>;
  listActivities(opts?: ReadOptions): Promise<CrmRow[]>;
  proposeContact(input: ProposeInput): Promise<SubmittedAction>;
  proposeDeal(input: ProposeInput): Promise<SubmittedAction>;
  proposeActivity(input: ProposeInput): Promise<SubmittedAction>;
}
`;

const AVATAR = {
  // 1x1 transparentes GIF, damit hier nichts nach einem Netz-Asset greift.
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// Die öffentliche Crm-Fassade (Typ für den Session-Rückgabewert).
interface Crm {
  listContacts(opts?: ReadOptions): Promise<CrmRow[]>;
  getContact(id: string): Promise<CrmRow | null>;
  listDeals(opts?: ReadOptions): Promise<CrmRow[]>;
  listActivities(opts?: ReadOptions): Promise<CrmRow[]>;
  proposeContact(input: ProposeInput): Promise<SubmittedAction>;
  proposeDeal(input: ProposeInput): Promise<SubmittedAction>;
  proposeActivity(input: ProposeInput): Promise<SubmittedAction>;
}

type AccountProps = { accountId: string };
type BindingProps = { accountId: string; resourceUrl: string };

/** Baut den CRM-Store aus der Env. Ausgelagert, damit Session und applyAction dieselbe Quelle nutzen. */
function makeStore(env: Cloudflare.Env): CrmStore {
  return new D1CrmStore(env.CRM_DB);
}

/**
 * Stub auf den CRM-Approval-Index — eine deterministisch benannte `CrmGatekeeper`-Instanz
 * (getByName(CRM_SINGLETON)), die die offenen Freigaben aller Verbindungen bündelt. Sie ist von
 * jeder Facet (zum Spiegeln des Lebenszyklus) UND vom Account (startAppUi/ui) erreichbar; die
 * per-Verbindungs-Facets selbst sind vom Account NICHT adressierbar (Overseer-verwaltete IDs),
 * daher dieser gemeinsame, benennbare Index als einzige account-lesbare Sicht auf die Queue.
 */
function crmApprovalIndex(
  exports: Cloudflare.Exports,
): DurableObjectStub<CrmGatekeeper> {
  const ns = exports.CrmGatekeeper as unknown as DurableObjectNamespace<CrmGatekeeper>;
  return ns.getByName(CRM_SINGLETON);
}

/** Prüft, dass eine gebundene URL wirklich das CRM adressiert. */
function assertCrmUrl(url: string): void {
  const u = new URL(url);
  if (u.host !== VENDOR_HOST) throw new Error(`Keine vonBusch-CRM-URL: ${url}`);
}

// ---------------------------------------------------------------------------
// Vendor

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "vonBusch CRM",
      url: RESOURCE_URL,
      logo: AVATAR,
      tagline: "CRM lesen und (mit Freigabe) schreiben.",
      description:
        "Bindet das vonBusch-CRM (Kontakte, Deals, Aktivitäten) ein. Reads sind auditierte " +
        "Observations, Schreibaktionen laufen über Human-in-the-Loop-Approval (Spalten-Allowlist).",
      // Kein OAuth: das CRM hat keinen Remote-Login; wir provisionieren intern.
      autoProvisionsAccount: true,
    };
  }

  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    const accountId = crypto.randomUUID();
    return this.ctx.exports.CrmAccount({ props: { accountId } });
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("vonBusch CRM provisioniert Accounts intern; es gibt keinen Connect-Flow.");
  }
}

// ---------------------------------------------------------------------------
// Account

export class CrmAccount
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "vonBusch CRM",
      uniqueName: this.ctx.props.accountId,
      avatar: AVATAR,
      // Macht das CRM in der Board-UI als öffenbare App-Kachel nutzbar (VON-1844). Ohne
      // providesUi bleibt der Vendor nur ein gebundener Connector, nicht bedienbar.
      providesUi: { title: "vonBusch CRM — Freigaben", icon: AVATAR },
    };
  }

  /**
   * Approval-Queue-Panel (VON-1844): liest die offenen CRM-Schreibfreigaben serverseitig aus dem
   * Approval-Index (deterministische CrmGatekeeper-Singleton-Instanz) und backt den Snapshot ins
   * iframe-HTML. Der Erst-Render braucht kein Browser-capnweb; die mitgelieferte `ui`-Capability
   * (CrmManagementApi) ermöglicht späteren Live-Refresh der Queue. Reine Anzeige — Freigeben/
   * Ablehnen bleibt allein beim OS-Approve-Pfad (menschliche ApprovalQueue → applyAction).
   */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const index = crmApprovalIndex(this.ctx.exports);
    const pending = await index.listPendingApprovals();
    const source: PendingApprovalSource = {
      listPendingApprovals: () => crmApprovalIndex(this.ctx.exports).listPendingApprovals(),
    };
    const ui = new NativeRpcStub(new CrmManagementApi(source));
    return { iframeHtml: buildCrmAppHtml(pending, new Date().toISOString()), ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<Crm>>;
    resource: SupportedResource;
  }> {
    assertCrmUrl(url);
    return {
      class: this.ctx.exports.CrmGatekeeper({
        props: { accountId: this.ctx.props.accountId, resourceUrl: url },
      }),
      resource: SUPPORTED_RESOURCES[0],
    };
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CrmVerifier({ props: this.ctx.props });
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  async revoke(): Promise<void> {}

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Kein Ressourcen-Konfigurator; binde die CRM-URL direkt.");
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
export interface CrmVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class CrmVerifier
    extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements CrmVerifierApi {
  async identify(): Promise<string> {
    return this.ctx.props.accountId;
  }
}

// ---------------------------------------------------------------------------
// Session (RPC-Fähigkeit ans Gadget) — dünner RpcTarget um den transport-freien Kern.

class CrmSessionRpc extends RpcTarget implements Crm {
  constructor(private readonly core: CrmSessionCore) {
    super();
  }
  listContacts(opts?: ReadOptions): Promise<CrmRow[]> { return this.core.listContacts(opts); }
  getContact(id: string): Promise<CrmRow | null> { return this.core.getContact(id); }
  listDeals(opts?: ReadOptions): Promise<CrmRow[]> { return this.core.listDeals(opts); }
  listActivities(opts?: ReadOptions): Promise<CrmRow[]> { return this.core.listActivities(opts); }
  proposeContact(input: ProposeInput): Promise<SubmittedAction> { return this.core.proposeContact(input); }
  proposeDeal(input: ProposeInput): Promise<SubmittedAction> { return this.core.proposeDeal(input); }
  proposeActivity(input: ProposeInput): Promise<SubmittedAction> { return this.core.proposeActivity(input); }
}

// ---------------------------------------------------------------------------
// Gatekeeper (ein DO für den CRM-Datensatzraum, als Facet unter dem Overseer des Gadgets)

type StoredAction = { id: number; action: PendingCrmAction; status: "pending" | "applied" };

export class CrmGatekeeper
    extends DurableObject<Cloudflare.Env, BindingProps> implements Gatekeeper<Crm> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: this.ctx.props.resourceUrl,
      title: "vonBusch CRM",
      snippet: "Kontakte, Deals und Aktivitäten (vonbusch-crm-eu) — Lesen direkt, Schreiben mit Freigabe.",
      suggestedBindingName: "CRM",
      tsType: "Crm",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** CRM-Schreibaktionen sind nie auto-approvable (verändern Kundendaten). */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Crm> {
    const store = makeStore(this.env);
    const queue = approvalQueue.dup();
    const enqueuer = {
      enqueue: async (action: PendingCrmAction, description: ActionDescription): Promise<number> => {
        const id = this.#nextActionId();
        this.ctx.storage.kv.put<StoredAction>(`action:${id}`, { id, action, status: "pending" });
        await queue.submitAction(id, {
          title: description.title,
          description: description.description,
          implementsRevert: description.implementsRevert,
          awaitDecision: description.awaitDecision,
          actionKind: description.actionKind,
        });
        // In den account-lesbaren Approval-Index spiegeln, damit das Board-UI-Panel (startAppUi)
        // die offene Freigabe zeigt. Best-effort: ein Index-Fehler darf den (bereits eingereihten)
        // Approval-Fluss nicht brechen.
        await this.#mirrorPending(id, action, description);
        return id;
      },
    };
    const core = new CrmSessionCore(store, queue, enqueuer, this.ctx.props.accountId);
    return new CrmSessionRpc(core);
  }

  #nextActionId(): number {
    const next = (this.ctx.storage.kv.get<number>("action:counter") ?? 0) + 1;
    this.ctx.storage.kv.put("action:counter", next);
    return next;
  }

  /** Verbindungs-/Facet-Kennung für den Index (dieselbe Facet ⇒ derselbe Token). */
  #connToken(): string {
    return this.ctx.props.accountId;
  }

  /** Spiegelt eine frisch eingereihte Aktion in den gemeinsamen Approval-Index (best-effort). */
  async #mirrorPending(
    id: number, action: PendingCrmAction, description: ActionDescription,
  ): Promise<void> {
    const view: PendingApprovalView = {
      connToken: this.#connToken(),
      actionId: id,
      entity: action.entity,
      op: action.op,
      targetId: action.targetId,
      title: description.title,
      description: description.description,
      proposedBy: action.proposedBy,
      proposedAt: Date.now(),
    };
    try {
      await crmApprovalIndex(this.ctx.exports).recordPendingApproval(view);
    } catch {
      // Index nicht erreichbar → Panel zeigt diese Aktion evtl. nicht; Approval bleibt intakt.
    }
  }

  /** Entfernt eine abgeschlossene/abgelehnte Aktion aus dem Index (best-effort). */
  async #unmirrorPending(id: number): Promise<void> {
    try {
      await crmApprovalIndex(this.ctx.exports).resolvePendingApproval(this.#connToken(), id);
    } catch {
      // Index nicht erreichbar → verwaister Eintrag; nächster startAppUi-Refresh gleicht ab.
    }
  }

  // --- Approval-Index (deterministische Singleton-Instanz, getByName(CRM_SINGLETON)) ---------
  // Diese drei Methoden laufen auf der INDEX-Instanz; die per-Verbindungs-Facets rufen sie
  // cross-DO auf, der Account (startAppUi/ui) liest sie. Rein Sichtbarkeit — keine Schreibgewalt.

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

  /**
   * Das CRM trägt kein per-Datensatz-ACL; wie im Ursprungs-Baustein ist CF Access die
   * Zugangsboundary. Jeder Beobachter mit dem Grant darf das CRM sehen — wir merken ihn vor.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<CrmVerifierApi>;
    const identity = await verifier.identify();
    this.ctx.storage.kv.put(`observer:${id}`, identity);
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  async applyAction(actionId: number): Promise<void> {
    const stored = this.ctx.storage.kv.get<StoredAction>(`action:${actionId}`);
    if (!stored) throw new Error(`Unbekannte Aktion: ${actionId}`);
    if (stored.status === "applied") return; // idempotent: kein Doppel-Write
    const { id } = await applyCrmAction(makeStore(this.env), stored.action, () => crypto.randomUUID());
    this.ctx.storage.kv.put<StoredAction>(`action:${actionId}`, { ...stored, status: "applied" });
    // Ergebnis-ID unter der Aktion vermerken (Audit / Debug).
    this.ctx.storage.kv.put(`result:${actionId}`, id);
    // Aus dem Board-UI-Panel entfernen: Freigabe ist erledigt.
    await this.#unmirrorPending(actionId);
  }

  async rejectAction(actionId: number): Promise<void> {
    this.ctx.storage.kv.delete(`action:${actionId}`);
    // Aus dem Board-UI-Panel entfernen: Freigabe wurde abgelehnt.
    await this.#unmirrorPending(actionId);
  }

  async revertAction(actionId: number): Promise<{ message?: string }> {
    const stored = this.ctx.storage.kv.get<StoredAction>(`action:${actionId}`);
    if (!stored) return { message: "Aktion unbekannt — nichts zurückzunehmen." };
    // Ein automatischer Revert (Delete bei create / Vorher-Wert bei update) ist bewusst nicht
    // implementiert, um keine weiteren ungeprüften Schreibrechte zu benötigen.
    return {
      message: stored.action.op === "create"
        ? "Angelegter CRM-Datensatz muss bei Bedarf manuell entfernt werden."
        : "CRM-Änderung muss bei Bedarf manuell rückgängig gemacht werden.",
    };
  }
}

// Wird verwendet, um die referenzierte Konstante nicht ungenutzt zu lassen (Action-Kind-Katalog):
// CRM_WRITE_KIND ist der stabile Tag aller Schreibaktionen; getAutoApprovableActions bleibt leer.
export const ACTION_KIND_CATALOG: ActionKind[] = [CRM_WRITE_KIND];

// Default-Handler: der Gatekeeper wird ausschließlich über RPC-Entrypoints (GatekeeperVendor etc.)
// angesprochen. Der fetch()-Handler existiert nur, damit der Worker ES-Module-Format hat (Pflicht
// für DO-Migrations) und beantwortet direkte HTTP-Zugriffe mit 404.
export default {
  async fetch(): Promise<Response> {
    return new Response("gatekeeper-vonbusch-crm: RPC-only", { status: 404 });
  },
};
