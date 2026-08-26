// vonBuschOS — CRM-Gatekeeper (K2-Port, VON-1817): transport-freier Session-Kern
//
// Bildet das Konzept-Mapping aus PORTING-GATEKEEPERVENDOR.md ab:
//   - jede Read-Operation → `authorizer.authorizeObservation()` VOR Rückgabe der Daten
//   - jede schreibende Aktion → `actions.enqueue()` (→ `ApprovalQueue.submitAction()`); die
//     eigentliche D1-Mutation tritt erst nach Approval in `CrmGatekeeper.applyAction()` ein.
//
// Der DO-Shell (`crm-gatekeeper.ts`) instanziiert diesen Kern mit dem D1-gestützten `CrmStore`,
// der echten `ApprovalQueue` und einem persistierenden Enqueuer. Die Fach-Logik (Datenzugriff,
// Allowlist, LIMIT-Caps) steckt im injizierten `CrmStore` bzw. `validateAction`; hier liegt nur
// das Approval-/Observation-Gerüst. Läuft workerd-frei und ist per `tsx --test` testbar.

import type { CrmStore, ReadOptions, CrmRow } from "./crm-store";
import { validateAction, type CrmEntity, type CrmValue, type WriteAction } from "./crm-actions";

/** Teilmenge von `@gadgets/workshop-shared` — lokal definiert, damit der Kern tsx-testbar bleibt. */
export type ObservationDescription = { title: string; description: string; prohibitAllSharing?: boolean };
export type ActionKind = { tag: string; label: string };
export type ActionDescription = {
  title: string;
  description: string;
  implementsRevert: boolean;
  awaitDecision?: boolean;
  autoApprovable?: boolean;
  actionKind?: ActionKind;
};

/** Was der Kern zum Autorisieren einer Beobachtung braucht (strukturell = `ObservationAuthorizer`). */
export interface ObservationAuthorizer {
  authorizeObservation(description: ObservationDescription): Promise<void>;
}

/**
 * Eine noch nicht angewandte schreibende CRM-Aktion, die der DO persistiert. Es ist die bereits
 * validierte, normalisierte `WriteAction` — applyAction führt sie unverändert aus.
 */
export type PendingCrmAction = WriteAction;

/** Reiht eine Aktion zur Freigabe ein und liefert die vom Gatekeeper vergebene Aktions-ID. */
export interface ActionEnqueuer {
  enqueue(action: PendingCrmAction, description: ActionDescription): Promise<number>;
}

/** Quittung einer eingereichten schreibenden Aktion; die Wirkung folgt erst nach Human-Approval. */
export type SubmittedAction = { actionId: number; status: "pending_approval" };

/** Der Eingabe-Umschlag für einen Schreibvorschlag (op + Ziel + Felder + Begründung). */
export type ProposeInput = {
  op: "create" | "update";
  /** Pflicht bei update, verboten bei create. */
  targetId?: string;
  /** Spalte → Wert (nur allowlistete Spalten, nur Primitive). */
  fields: Record<string, CrmValue>;
  /** Optionale Begründung für den freigebenden Menschen. */
  reason?: string;
};

/**
 * Stabiler Action-Kind-Tag für CRM-Schreibaktionen. Auto-Approval ist NICHT vorgesehen (Writes
 * verändern Kundendaten) — der Gatekeeper meldet `getAutoApprovableActions()` leer und setzt
 * `autoApprovable` nie.
 */
export const CRM_WRITE_KIND: ActionKind = { tag: "vonbusch.crm.write", label: "CRM-Datensatz schreiben" };

const ENTITY_LABEL: Record<CrmEntity, string> = {
  contact: "Kontakt",
  deal: "Deal",
  activity: "Aktivität",
};

/**
 * Die RPC-Fähigkeit, die dem Gadget übergeben wird. Reads laufen (nach Observation-Autorisierung)
 * sofort; schreibende Aktionen werden zur Freigabe eingereiht und erst nach Approval ausgeführt.
 */
export class CrmSessionCore {
  constructor(
    private readonly crm: CrmStore,
    private readonly authorizer: ObservationAuthorizer,
    private readonly actions: ActionEnqueuer,
    /** Identität des gebundenen Gadgets/Accounts — landet als `proposedBy` an jeder Aktion. */
    private readonly proposedBy: string,
  ) {}

  // --- Reads: Daten holen, DANN autorisieren, DANN zurückgeben. ---

  async listContacts(opts: ReadOptions = {}): Promise<CrmRow[]> {
    const rows = await this.crm.read("contact", opts);
    await this.authorizer.authorizeObservation({
      title: "CRM-Kontakte auflisten",
      description:
        `Liest ${rows.length} Kontakt(e) aus dem CRM` +
        (opts.search ? ` (Suche: \`${opts.search}\`)` : "") + ".",
      prohibitAllSharing: true,
    });
    return rows;
  }

  async getContact(id: string): Promise<CrmRow | null> {
    const row = await this.crm.getById("contact", id);
    await this.authorizer.authorizeObservation({
      title: `Kontakt ${id} lesen`,
      description: `Liest den CRM-Kontakt \`${id}\`${row ? ` (${String(row.name ?? "—")})` : " (nicht gefunden)"}.`,
      prohibitAllSharing: true,
    });
    return row ?? null;
  }

  async listDeals(opts: ReadOptions = {}): Promise<CrmRow[]> {
    const rows = await this.crm.read("deal", opts);
    await this.authorizer.authorizeObservation({
      title: "CRM-Deals auflisten",
      description:
        `Liest ${rows.length} Deal(s) aus dem CRM` +
        (opts.contactId ? ` (Kontakt \`${opts.contactId}\`)` : "") +
        (opts.search ? ` (Suche: \`${opts.search}\`)` : "") + ".",
      prohibitAllSharing: true,
    });
    return rows;
  }

  async listActivities(opts: ReadOptions = {}): Promise<CrmRow[]> {
    const rows = await this.crm.read("activity", opts);
    await this.authorizer.authorizeObservation({
      title: "CRM-Aktivitäten auflisten",
      description:
        `Liest ${rows.length} Aktivität(en) aus dem CRM` +
        (opts.contactId ? ` (Kontakt \`${opts.contactId}\`)` : "") +
        (opts.search ? ` (Suche: \`${opts.search}\`)` : "") + ".",
      prohibitAllSharing: true,
    });
    return rows;
  }

  // --- Writes: validieren + einreihen, NICHT ausführen. ---

  proposeContact(input: ProposeInput): Promise<SubmittedAction> {
    return this.#propose("contact", input);
  }

  proposeDeal(input: ProposeInput): Promise<SubmittedAction> {
    return this.#propose("deal", input);
  }

  proposeActivity(input: ProposeInput): Promise<SubmittedAction> {
    return this.#propose("activity", input);
  }

  async #propose(entity: CrmEntity, input: ProposeInput): Promise<SubmittedAction> {
    const validated = validateAction({
      entity,
      op: input?.op,
      targetId: input?.targetId,
      data: input?.fields,
      proposedBy: this.proposedBy,
      reason: input?.reason,
    });
    if (!validated.ok) {
      // Ungültige Vorschläge werden gar nicht erst eingereiht — der Fehler geht ans Gadget zurück.
      throw new Error(validated.message);
    }
    const action = validated.value;
    const label = ENTITY_LABEL[entity];
    const verb = action.op === "create" ? "anlegen" : "ändern";
    const fieldLines = Object.entries(action.data)
      .map(([k, v]) => `- **${k}:** ${v === null ? "∅" : String(v)}`)
      .join("\n");
    const actionId = await this.actions.enqueue(action, {
      title: `${label} ${verb}${action.targetId ? ` (#${action.targetId})` : ""}`,
      description:
        `Vorschlag, im CRM einen ${label} zu ${verb}` +
        (action.targetId ? ` (Datensatz \`${action.targetId}\`)` : "") + ":\n\n" +
        fieldLines +
        (action.reason ? `\n\n**Begründung:** ${action.reason}` : ""),
      implementsRevert: false,
      awaitDecision: true,
      actionKind: CRM_WRITE_KIND,
    });
    return { actionId, status: "pending_approval" };
  }
}

/**
 * Wendet eine (freigegebene) Aktion tatsächlich auf das CRM an. Aufgerufen aus `applyAction()`.
 * `newId` mintet die ID für create-Aktionen (in Prod `crypto.randomUUID`).
 */
export async function applyCrmAction(
  crm: CrmStore,
  action: PendingCrmAction,
  newId: () => string,
): Promise<{ id: string }> {
  return crm.applyWrite(action, newId);
}
