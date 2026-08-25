/**
 * Robomon-Gatekeeper als CloudflareOS-`GatekeeperVendor`-Gadget (VON-1814).
 *
 * Port des read-only MCP-Bausteins `vonbusch/robomon-gatekeeper` (K6 / VON-1803) auf die
 * OS-Gatekeeper-Schnittstelle, damit er im bestehenden CloudflareOS-Deploy als Kachel unter
 * `/` erscheint (hinter CF Access). Kleinste Fläche = Referenz-Port: ein auto-provisionierter
 * Singleton-Account mit vier read-only Observations, keine Actions, keine ApprovalQueue-Writes.
 *
 * Architektur (analog `gatekeeper-context`, aber ohne Collections/Sharing/Management-UI):
 *   GatekeeperVendor  — autoProvisionsAccount, mintet RobomonAccount ohne OAuth
 *   RobomonAccount    — Singleton-Account (tsType "RobomonHealth"), liefert den DO-Class
 *   RobomonVerifier   — Identitäts-Rückmeldung (Interface-Vollständigkeit; admit-all)
 *   RobomonGatekeeper — DO (Facet unter dem Overseer): describe/startSession/addObserver …
 *   RobomonHealthSession — RpcTarget, gadget-seitige Read-Capability (jede Read → authorize)
 *
 * Nur-Lesen: die Fach-Logik (`session.ts`/`health.ts`) liest ausschließlich die von-authmon-KV
 * (`AUTHMON_KV`), schreibt nie und alarmiert nie (das macht weiterhin von-authmon, VON-1689).
 */

import { DurableObject, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceDescription,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { RobomonSession, type HealthRepo } from "./session.js";
import type { AuthmonState } from "./health.js";
import { RobomonObservations } from "./observations.js";

// Ein 1x1-transparentes GIF als Logo — kein Netzwerk-Asset nötig.
const ROBOMON_ICON = {
  url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};

// Der gesamte Typraum, den der Coding-Agent über dieses Gadget sieht. `RobomonHealth` ist die
// Session-Oberfläche (tsType des Singletons); die referenzierten Typen sind exportiert.
const ROBOMON_TYPES = `
/** Read-only Auth-/Run-Health-Observations der Agenten-Flotte (Quelle: von-authmon, VON-1689). */
interface RobomonHealth {
  /** Vollständige Auth-/Run-Health-Observation (Level, Art, Detail, Heartbeat-Alter, Token, Zähler). */
  getHealth(): Promise<HealthSnapshot>;
  /** Kompakte Ampel-Zeile für Status-Dashboards, z.B. "🟢 HEALTHY · hb 3m · …". */
  getHealthLine(): Promise<string>;
  /** Run-Kennzahlen: heutige Kumulativzähler, rollierendes Delta-Fenster und Fehlerquote. */
  getRunActivity(): Promise<RunActivityView>;
  /** OAuth-Token-Ablauf (rein informativ — Near-Expiry ist kein Incident). */
  getTokenStatus(): Promise<TokenObservation | null>;
  /** Aktuell offener von-authmon-Alarm plus frisch abgeleitete Bewertung — für Alarm-Triage. */
  getActiveAlarm(): Promise<ActiveAlarmView>;
}

type HealthLevel = "OK" | "ALARM";
type HealthKind =
  | "HEALTHY" | "BOOTING" | "NO_HEARTBEAT" | "STALE_HEARTBEAT" | "ZERO_SUCCESS" | "HIGH_FAILRATE";

interface RunToday { date?: string; succeeded?: number; failed?: number; total?: number; }
interface RunWindow { succeeded?: number; failed?: number; total?: number; }

interface TokenObservation {
  /** ISO-Ablaufzeitpunkt. */ expiresAt: string;
  /** Reststunden bis Ablauf (negativ = bereits abgelaufen). */ expiresInHours: number;
  expired: boolean;
}

interface HealthSnapshot {
  observedAt: string;
  level: HealthLevel;
  kind: HealthKind;
  detail: string;
  heartbeatAgeMinutes: number | null;
  heartbeatFresh: boolean;
  host: string | null;
  runToday: RunToday | null;
  runWindow: RunWindow | null;
  token: TokenObservation | null;
  authmonAlarm: AuthmonAlarm | null;
}

interface AuthmonAlarm { kind: string; level: string; since: number; lastNotifiedAt?: number; }

interface RunActivityView {
  today: RunToday | null;
  window: RunWindow | null;
  /** Fehlerquote im rollierenden Fenster [%], null ohne Baseline. */
  windowFailRatePct: number | null;
  observedAt: string;
}

interface ActiveAlarmView {
  persisted: AuthmonAlarm | null;
  derivedLevel: HealthLevel;
  derivedKind: HealthKind;
  detail: string;
  observedAt: string;
}
`;

// KV-gestütztes, ausschließlich lesendes Repo (1:1 aus VON-1803). Liest die drei von-authmon-Keys.
class KvHealthRepo implements HealthRepo {
  #kv: KVNamespace;
  constructor(kv: KVNamespace) {
    this.#kv = kv;
  }
  async ladeState(): Promise<AuthmonState> {
    const [bootRaw, hb, alarm] = await Promise.all([
      this.#kv.get("bootAt"),
      this.#kv.get("hb", "json") as Promise<AuthmonState["hb"]>,
      this.#kv.get("alarm", "json") as Promise<AuthmonState["alarm"]>,
    ]);
    const bootAt = bootRaw ? Number(bootRaw) : null;
    return {
      bootAt: bootAt && isFinite(bootAt) ? bootAt : null,
      hb: hb ?? null,
      alarm: alarm ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// RpcTarget: gadget-seitige Read-Capability. Delegiert 1:1 an RobomonObservations, wo jede
// Read-Op durch `authorizeObservation()` geführt wird. Der Overseer erhält dieses Objekt aus
// startSession() und reicht es an das Gadget.
export class RobomonHealthSession extends RpcTarget {
  #obs: RobomonObservations;
  #authorizer: RpcStub<ApprovalQueue>;

  constructor(obs: RobomonObservations, authorizer: RpcStub<ApprovalQueue>) {
    super();
    this.#obs = obs;
    this.#authorizer = authorizer;
  }

  /** Gibt den vom Overseer geliehenen Authorizer wieder frei, wenn die Session endet. */
  [Symbol.dispose](): void {
    this.#authorizer[Symbol.dispose]?.();
  }

  getHealth() {
    return this.#obs.getHealth();
  }
  getHealthLine() {
    return this.#obs.getHealthLine();
  }
  getRunActivity() {
    return this.#obs.getRunActivity();
  }
  getTokenStatus() {
    return this.#obs.getTokenStatus();
  }
  getActiveAlarm() {
    return this.#obs.getActiveAlarm();
  }
}

// ---------------------------------------------------------------------------
// Vendor

type AccountProps = { accountId: string };

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Robomon",
      url: "https://vonbusch.app/",
      logo: ROBOMON_ICON,
      tagline: "Auth- & Run-Health der Agenten-Flotte",
      description:
        "Robomon macht die read-only Auth-/Run-Health der von-Busch-Agentenflotte " +
        "(Quelle: von-authmon) für Status-Dashboard-Gadgets und Alarm-Triage-Agenten lesbar. " +
        "Rein observierend — keine Aktionen, keine Alarme, keine Schreibzugriffe.",
      // Read-only, keine externe Identität → Account wird ohne OAuth gemintet.
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /**
   * Mintet einen frischen Account ohne OAuth. Ohne Cast bräche das Serialisieren des
   * WorkerEntrypoint-Stubs; das Muster ist aus `gatekeeper-context` übernommen.
   */
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.RobomonAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    // Auto-provisionierter Singleton — keine URL-adressierten Ressourcen.
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return ROBOMON_TYPES;
  }

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    throw new Error("Robomon ist auto-provisioniert; es gibt keinen Connect-Flow.");
  }
}

// ---------------------------------------------------------------------------
// Account (Singleton, read-only)

export class RobomonAccount
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Robomon",
      avatar: ROBOMON_ICON,
      // Agent-Singleton: der Overseer installiert den DO als Facet und stellt die Session
      // als unbenannte Kapsel bereit. tsType muss ein Export aus getTypeScriptTypes() sein.
      singleton: { tsType: "RobomonHealth" },
    };
  }

  /** Gadget-seitiger Read-Pfad, mit den Account-Props imbued. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<RobomonHealthSession>>> {
    return this.ctx.exports.RobomonGatekeeper({
      props: { accountId: this.ctx.props.accountId },
    });
  }

  /** Mintet einen Verifier für addObserver(). */
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.RobomonVerifier({ props: this.ctx.props });
  }

  // --- GatekeeperUser-Ressourcen-Oberfläche: keine URL-adressierten Ressourcen ---
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Robomon hat keine URL-adressierten Ressourcen.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Robomon hat keine URL-adressierten Ressourcen.");
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
    throw new Error("Robomon ist ein Singleton-Gatekeeper; es gibt keinen Connect-Flow.");
  }
}

/**
 * Meldet, welcher Account fragt. `GatekeeperUserVerifier` hat selbst keine Methoden; die
 * Konvention (siehe Interface-Deklaration) ist eine nicht-standardisierte Methode, der der
 * Gatekeeper vertraut, weil der Overseer den Verifier nur an denselben Vendor zurückreicht.
 */
export interface RobomonVerifierApi extends GatekeeperUserVerifier {
  identify(): Promise<string>;
}

export class RobomonVerifier
  extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements RobomonVerifierApi
{
  async identify(): Promise<string> {
    return this.ctx.props.accountId;
  }
}

// ---------------------------------------------------------------------------
// Gatekeeper (DO, Facet unter dem Overseer)

type GatekeeperProps = { accountId: string };

export class RobomonGatekeeper
  extends DurableObject<Cloudflare.Env, GatekeeperProps>
  implements Gatekeeper<RobomonHealthSession>
{
  #session(): RobomonSession {
    return new RobomonSession(new KvHealthRepo(this.env.AUTHMON_KV));
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "robomon://health",
      title: "Robomon",
      snippet: "Auth- & Run-Health der Agenten-Flotte (read-only, Quelle: von-authmon).",
      suggestedBindingName: "ROBOMON",
      tsType: "RobomonHealth",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return ROBOMON_TYPES;
  }

  /** Read-only Gatekeeper: es werden nie Actions eingereicht, also nichts auto-approvable. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<RobomonHealthSession> {
    // Der Authorizer wird nach startSession() weiterbenutzt → eigene Kopie (dup), die die
    // Session bei Dispose freigibt.
    const owned = approvalQueue.dup();
    try {
      const obs = new RobomonObservations(this.#session(), owned);
      return new RobomonHealthSession(obs, owned);
    } catch (err) {
      owned[Symbol.dispose]?.();
      throw err;
    }
  }

  /**
   * Robomon beobachtet ausschließlich **aggregierte, nicht-personenbezogene Flotten-Health**
   * (Zähler, Alarme, Token-Ablauf) — kein privater Nutzerinhalt. Jeder hinter CF Access
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
    throw new Error("Robomon ist read-only und implementiert keine Actions.");
  }
  rejectAction(_action: number): Promise<void | { restart?: boolean }> {
    throw new Error("Robomon ist read-only und implementiert keine Actions.");
  }
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Robomon ist read-only und implementiert keine Actions.");
  }
}
