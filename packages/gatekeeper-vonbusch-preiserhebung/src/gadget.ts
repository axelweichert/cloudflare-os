/**
 * Preiserhebungs-Gatekeeper als CloudflareOS-`GatekeeperVendor`-Gadget (VON-1816).
 *
 * Port des read-only MCP-Bausteins `vonbusch/preiserhebung-gatekeeper` (K4 / VON-1801) auf die
 * OS-Gatekeeper-Schnittstelle, damit er im bestehenden CloudflareOS-Deploy als Kachel unter `/`
 * erscheint (hinter CF Access). Analog zum Referenz-Port robomon (VON-1814): ein
 * auto-provisionierter Singleton-Account mit vier read-only Observations, keine Actions, keine
 * ApprovalQueue-Writes.
 *
 * Architektur (analog `gatekeeper-context`/robomon, ohne Collections/Sharing/Management-UI):
 *   GatekeeperVendor       — autoProvisionsAccount, mintet PreiserhebungAccount ohne OAuth
 *   PreiserhebungAccount   — Singleton-Account (tsType "Preiserhebung"), liefert den DO-Class
 *   PreiserhebungVerifier  — Identitäts-Rückmeldung (Interface-Vollständigkeit; admit-all)
 *   PreiserhebungGatekeeper— DO (Facet unter dem Overseer): describe/startSession/addObserver …
 *   PreiserhebungReadSession — RpcTarget, gadget-seitige Read-Capability (jede Read → authorize)
 *
 * Nur-Lesen: die Fach-Logik (`session.ts` + `engine/*`) liest die printgemein-Preis-D1
 * (`PREIS_DB`) ausschließlich via SELECT und schreibt nie. Vertriebs-"Anpassungen" sind
 * nicht-persistente Per-Call-`overrides`; die D1-Quelle bleibt unangetastet.
 */

import { DurableObject, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { RpcTarget, RpcStub as NativeRpcStub } from "capnweb";
import type {
  AccountDescription,
  ActionKind,
  AppUiContext,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { PreiserhebungSession, type PreisRepo } from "./session";
import type { PreisparameterRow } from "./preis-parameter";
import { PreiserhebungObservations } from "./observations";
import {
  PreiserhebungManagementApi,
  buildPreiserhebungAppHtml,
  ladePreiserhebungSnapshot,
} from "./app-ui";

// Ein 1x1-transparentes GIF als Logo — kein Netzwerk-Asset nötig.
const PREISERHEBUNG_ICON = {
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// Der gesamte Typraum, den der Coding-Agent über dieses Gadget sieht. `Preiserhebung` ist die
// Session-Oberfläche (tsType des Singletons); die referenzierten Typen sind vollständig aufgeführt.
const PREISERHEBUNG_TYPES = `
/** Read-only Preis-/ROI-Erhebung: printgemein-Druckpreis + DMS-ROI aus der Preis-D1 (VON-1801). */
interface Preiserhebung {
  /** Kanonischer Druck-Parametersatz aus der read-only Preis-D1 (mit optionalen Per-Call-Overrides). */
  getDruckparameter(overrides?: DeepPartial<PreisParameterSatz>): Promise<PreisParameterSatz>;
  /** printgemein-Druckpreis für eine Konfiguration; Overrides gelten NUR für diesen Aufruf. */
  berechneDruckPreis(
    konfiguration: ProduktKonfiguration,
    overrides?: DeepPartial<PreisParameterSatz>,
  ): Promise<PreisAufschluesselung>;
  /** DMS-ROI-Config (Koeffizienten + Defaults + Horizonte). */
  getDmsRoiConfig(overrides?: DeepPartial<DmsRoiConfig>): Promise<DmsRoiConfig>;
  /** DMS-ROI-Kennzahlen; Overrides justieren Koeffizienten/Defaults ad hoc (nicht persistent). */
  berechneDmsRoi(
    eingabe: Partial<DmsRoiEingabe>,
    overrides?: DeepPartial<DmsRoiConfig>,
  ): Promise<DmsRoiErgebnis>;
}

type Format = "A4" | "A5";
type Farbigkeit = "4c" | "sw";
type Versandart = "standard" | "express";

interface ProduktKonfiguration {
  format: Format;
  farbigkeit: Farbigkeit;
  papiersorte: string;
  /** 4–80, Vielfaches von 4 (Rückenheftung). */ seiten: number;
  /** 10–2.000. */ auflage: number;
  versand: Versandart;
}

interface PreisParameterSatz {
  ruestkosten: number;
  klickpreis: Record<Farbigkeit, number>;
  papierpreis: Record<string, Record<Format, number>>;
  seitenProBlatt: Record<Format, number>;
  weiterverarbeitung: number;
  versandkosten: Record<Versandart, number>;
  margenAufschlag: number;
  provisionRate: number;
  ust: number;
}

interface PreisAufschluesselung {
  ruestkosten: number;
  druckkosten: number;
  papierkosten: number;
  weiterverarbeitungskosten: number;
  versandkosten: number;
  druckNetto: number;
  provision: number;
  netto: number;
  ust: number;
  brutto: number;
  details: { blaetterProExemplar: number; blaetterGesamt: number; klicksGesamt: number };
}

interface DmsRoiKoeffizienten {
  searchTimeReductionPct: number;
  processTimeReductionPct: number;
  paperReductionPct: number;
  archiveReductionPct: number;
  errorReductionPct: number;
}

interface DmsRoiEingabe {
  docsPerMonth: number;
  searchMinBefore: number;
  processMinBefore: number;
  laborCostPerHour: number;
  paperCostPerDoc: number;
  archiveCostPerYear: number;
  errorCostPerYear: number;
  licenseSetupOnce: number;
  licenseYearly: number;
}

interface DmsRoiConfig {
  coeff: DmsRoiKoeffizienten;
  defaults: DmsRoiEingabe;
  horizonsYears: number[];
}

interface DmsRoiHorizont {
  years: number;
  totalCost: number;
  totalBenefit: number;
  netGain: number;
  roiPct: number;
}

interface DmsRoiErgebnis {
  docsPerYear: number;
  hoursSavedPerYear: number;
  breakdown: { timeSavings: number; paperSavings: number; archiveSavings: number; errorSavings: number };
  annualSavings: number;
  netAnnualBenefit: number;
  paybackMonths: number | null;
  horizons: Record<number, DmsRoiHorizont>;
}

/** Nur die im Patch gesetzten Felder ändern sich; die D1-Quelle bleibt unberührt. */
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
`;

// D1-gestütztes, ausschließlich lesendes Repo (1:1 aus VON-1801 `worker.ts`). Lädt je schluessel
// den aktiven Wert mit der neuesten gueltig_ab. Kein INSERT/UPDATE/DELETE, keine batch()-Writes.
class D1PreisRepo implements PreisRepo {
  #db: D1Database;
  constructor(db: D1Database) {
    this.#db = db;
  }
  async ladeDruckparameter(): Promise<PreisparameterRow[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT schluessel, wert FROM preisparameter p
         WHERE aktiv = 1
           AND gueltig_ab = (
             SELECT MAX(gueltig_ab) FROM preisparameter p2
             WHERE p2.schluessel = p.schluessel AND p2.aktiv = 1
           )`,
      )
      .all<PreisparameterRow>();
    return results ?? [];
  }
}

// ---------------------------------------------------------------------------
// RpcTarget: gadget-seitige Read-Capability. Delegiert 1:1 an PreiserhebungObservations, wo jede
// Read-Op durch `authorizeObservation()` geführt wird. Der Overseer erhält dieses Objekt aus
// startSession() und reicht es an das Gadget.
export class PreiserhebungReadSession extends RpcTarget {
  #obs: PreiserhebungObservations;
  #authorizer: RpcStub<ApprovalQueue>;

  constructor(obs: PreiserhebungObservations, authorizer: RpcStub<ApprovalQueue>) {
    super();
    this.#obs = obs;
    this.#authorizer = authorizer;
  }

  /** Gibt den vom Overseer geliehenen Authorizer wieder frei, wenn die Session endet. */
  [Symbol.dispose](): void {
    this.#authorizer[Symbol.dispose]?.();
  }

  getDruckparameter(overrides?: Parameters<PreiserhebungObservations["getDruckparameter"]>[0]) {
    return this.#obs.getDruckparameter(overrides);
  }
  berechneDruckPreis(
    konfiguration: Parameters<PreiserhebungObservations["berechneDruckPreis"]>[0],
    overrides?: Parameters<PreiserhebungObservations["berechneDruckPreis"]>[1],
  ) {
    return this.#obs.berechneDruckPreis(konfiguration, overrides);
  }
  getDmsRoiConfig(overrides?: Parameters<PreiserhebungObservations["getDmsRoiConfig"]>[0]) {
    return this.#obs.getDmsRoiConfig(overrides);
  }
  berechneDmsRoi(
    eingabe: Parameters<PreiserhebungObservations["berechneDmsRoi"]>[0],
    overrides?: Parameters<PreiserhebungObservations["berechneDmsRoi"]>[1],
  ) {
    return this.#obs.berechneDmsRoi(eingabe, overrides);
  }
}

// ---------------------------------------------------------------------------
// Vendor

type AccountProps = { accountId: string };

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Preiserhebung",
      url: "https://vonbusch.app/",
      logo: PREISERHEBUNG_ICON,
      tagline: "Druckpreis & DMS-ROI aus der Preis-D1 (read-only)",
      description:
        "Preiserhebung macht die printgemein-Druckpreis-Engine und den DMS-ROI-Rechner als " +
        "read-only Gadget-Baustein verfügbar. Parameter kommen read-only aus der Preis-D1; der " +
        "Vertrieb justiert per nicht-persistenten Per-Call-Overrides (What-if) — keine Schreibzugriffe.",
      // Read-only, keine externe Identität → Account wird ohne OAuth gemintet.
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /**
   * Mintet einen frischen Account ohne OAuth. Ohne Cast bräche das Serialisieren des
   * WorkerEntrypoint-Stubs; das Muster ist aus `gatekeeper-context`/robomon übernommen.
   */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.PreiserhebungAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    // Auto-provisionierter Singleton — keine URL-adressierten Ressourcen.
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return PREISERHEBUNG_TYPES;
  }

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("Preiserhebung ist auto-provisioniert; es gibt keinen Connect-Flow.");
  }
}

// ---------------------------------------------------------------------------
// Account (Singleton, read-only)

export class PreiserhebungAccount
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Preiserhebung",
      avatar: PREISERHEBUNG_ICON,
      // Agent-Singleton: der Overseer installiert den DO als Facet und stellt die Session als
      // unbenannte Kapsel bereit. tsType muss ein Export aus getTypeScriptTypes() sein.
      singleton: { tsType: "Preiserhebung" },
      // Macht Preiserhebung in der Board-UI als oeffenbare App-Kachel nutzbar (VON-1846). Ohne
      // providesUi bleibt der Vendor nur ein gebundener Connector, nicht bedienbar.
      providesUi: { title: "Preiserhebung", icon: PREISERHEBUNG_ICON },
    };
  }

  /**
   * Read-only Management-Frame (VON-1846): liest die Preis-D1 serverseitig und backt den
   * aktuellen Parametersatz-/Preis-/ROI-Snapshot in das iframe-HTML. Der Erst-Render braucht kein
   * Browser-capnweb; die mitgelieferte `ui`-Capability (PreiserhebungManagementApi) ermoeglicht
   * spaeteren Live-Refresh / What-if-Overrides. Read-only: keine Schreibzugriffe.
   */
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    const session = new PreiserhebungSession(new D1PreisRepo(this.env.PREIS_DB));
    const snapshot = await ladePreiserhebungSnapshot(session);
    const ui = new NativeRpcStub(new PreiserhebungManagementApi(session));
    return { iframeHtml: buildPreiserhebungAppHtml(snapshot), ui };
  }

  /** Gadget-seitiger Read-Pfad, mit den Account-Props imbued. */
  async getSingletonGatekeeperClass(): Promise<
    DurableObjectClass<Gatekeeper<PreiserhebungReadSession>>
  > {
    return this.ctx.exports.PreiserhebungGatekeeper({
      props: { accountId: this.ctx.props.accountId },
    });
  }

  /** Mintet einen Verifier für addObserver(). */
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.PreiserhebungVerifier({ props: this.ctx.props });
  }

  // --- GatekeeperUser-Ressourcen-Oberfläche: keine URL-adressierten Ressourcen ---
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Preiserhebung hat keine URL-adressierten Ressourcen.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Preiserhebung hat keine URL-adressierten Ressourcen.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }
  /** Read-only Singleton ohne persistenten Account-State — nichts zu widerrufen. */
  async revoke(): Promise<void> {}
  reconnect(): never {
    throw new Error("Preiserhebung ist ein Singleton-Gatekeeper; es gibt keinen Connect-Flow.");
  }
}

/**
 * Meldet, welcher Account fragt. `GatekeeperUserVerifier` hat selbst keine Methoden; die
 * Konvention ist eine nicht-standardisierte Methode, der der Gatekeeper vertraut, weil der
 * Overseer den Verifier nur an denselben Vendor zurückreicht.
 */
export interface PreiserhebungVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class PreiserhebungVerifier
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements PreiserhebungVerifierApi
{
  async identify(): Promise<string> {
    return this.ctx.props.accountId;
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper (DO, Facet unter dem Overseer)

type GatekeeperProps = { accountId: string };

export class PreiserhebungGatekeeper
  extends DurableObject<Cloudflare.Env, GatekeeperProps>
  implements Gatekeeper<PreiserhebungReadSession>
{
  #session(): PreiserhebungSession {
    return new PreiserhebungSession(new D1PreisRepo(this.env.PREIS_DB));
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "preiserhebung://preise",
      title: "Preiserhebung",
      snippet:
        "Druckpreis (printgemein) & DMS-ROI aus der Preis-D1 (read-only, nicht-persistente Overrides).",
      suggestedBindingName: "PREISERHEBUNG",
      tsType: "Preiserhebung",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return PREISERHEBUNG_TYPES;
  }

  /** Read-only Gatekeeper: es werden nie Actions eingereicht, also nichts auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<PreiserhebungReadSession> {
    // Der Authorizer wird nach startSession() weiterbenutzt → eigene Kopie (dup), die die Session
    // bei Dispose freigibt.
    const owned = approvalQueue.dup();
    try {
      const obs = new PreiserhebungObservations(this.#session(), owned);
      return new PreiserhebungReadSession(obs, owned);
    } catch (err) {
      owned[Symbol.dispose]?.();
      throw err;
    }
  }

  /**
   * Preiserhebung beobachtet ausschließlich **aggregierte, nicht-personenbezogene Preis-/ROI-
   * Kennzahlen** aus der Preis-D1 — kein privater Nutzerinhalt. Jeder hinter CF Access
   * zugelassene Workshop-User darf das beobachten, daher wird jeder Observer zugelassen. Die
   * Identität wird für spätere Verschärfung dennoch festgehalten.
   */
  async addObserver(id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    this.ctx.storage.kv.put(`observer:${id}`, Date.now());
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  // Read-only: es werden keine Actions eingereicht, diese Callbacks laufen nie.
  applyAction(_action: number): Promise<void> {
    throw new Error("Preiserhebung ist read-only und implementiert keine Actions.");
  }
  rejectAction(_action: number): Promise<void | { restart?: boolean }> {
    throw new Error("Preiserhebung ist read-only und implementiert keine Actions.");
  }
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Preiserhebung ist read-only und implementiert keine Actions.");
  }
}
