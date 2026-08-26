// vonBuschOS — CRM-Gatekeeper (K2-Port, VON-1817): Schreibaktions-Typen + Validierung
//
// Portiert aus `vonbusch/crm-gatekeeper/write-queue.ts` (VON-1800). Behalten wird der
// transport-freie, workerd-freie VALIDIERUNGSKERN (Entities, Ops, Spalten-Allowlist,
// Primitive-Prüfung, LIMIT-/Längen-Caps). NICHT übernommen wird die alte `WriteApprovalQueue`
// samt eigenem Store: deren Rolle (pending → approve → apply) übernimmt im OS-Port die
// OS-`ApprovalQueue` (`submitAction()` → `applyAction()`), siehe session-core.ts / crm-gatekeeper.ts.
//
// Sicherheitsinvarianten (hier zentral erzwungen):
//   - Nur bekannte Entities (contact|deal|activity) und Ops (create|update).
//   - Spalten-Allowlist pro Entity: unbekannte Felder werden abgelehnt (keine SQL-Injection über
//     dynamische Spaltennamen, keine ungewollten Feld-Overwrites).
//   - Werte sind Primitive (string|number|boolean|null) — keine Objekte/Arrays.
//   - `update` verlangt eine `targetId`; `create` darf keine `targetId` tragen.

export type CrmEntity = "contact" | "deal" | "activity";
export type WriteOp = "create" | "update";

/** Erlaubte Spalten pro Entity. Alles außerhalb wird abgelehnt. */
export const COLUMN_ALLOWLIST: Record<CrmEntity, readonly string[]> = {
  contact: ["name", "email", "phone", "company", "status", "owner", "notes"],
  deal: ["title", "contact_id", "value", "stage", "status", "owner", "close_date", "notes"],
  activity: ["contact_id", "deal_id", "type", "subject", "body", "status", "owner", "due_at"],
};

export type CrmValue = string | number | boolean | null;

export interface WriteAction {
  entity: CrmEntity;
  op: WriteOp;
  /** Pflicht bei update, verboten bei create. */
  targetId?: string;
  /** Spalte → Wert. Nur allowlistete Spalten, nur Primitive. */
  data: Record<string, CrmValue>;
  /** Wer die Aktion vorgeschlagen hat (Gadget-/Account-Kennung). */
  proposedBy: string;
  /** Optionale Begründung für den freigebenden Menschen. */
  reason?: string;
}

export interface ValidateConfig {
  /** Max. Länge eines String-Werts. */
  maxValueLen?: number;
}

const DEFAULT_MAX_VALUE = 20_000;

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

const ENTITIES: readonly CrmEntity[] = ["contact", "deal", "activity"];
const OPS: readonly WriteOp[] = ["create", "update"];

function isPrimitive(v: unknown): v is CrmValue {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Validiert eine roh eingereichte Schreibaktion gegen alle Invarianten und normalisiert sie zu
 * einer sicheren `WriteAction`. Gibt eine Fehlermeldung statt zu werfen (Vorschlag darf nicht
 * das Gadget crashen).
 */
export function validateAction(input: unknown, config: ValidateConfig = {}): Validated<WriteAction> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Schreibaktion muss ein Objekt sein." };
  }
  const a = input as Record<string, unknown>;

  const entity = a.entity as CrmEntity;
  if (!ENTITIES.includes(entity)) {
    return { ok: false, message: `Unbekannte Entity '${String(a.entity)}' (erlaubt: ${ENTITIES.join(", ")}).` };
  }
  const op = a.op as WriteOp;
  if (!OPS.includes(op)) {
    return { ok: false, message: `Unbekannte Operation '${String(a.op)}' (erlaubt: ${OPS.join(", ")}).` };
  }

  const targetId = typeof a.targetId === "string" ? a.targetId.trim() : "";
  if (op === "update" && !targetId) {
    return { ok: false, message: "update verlangt eine targetId (ID des zu ändernden Datensatzes)." };
  }
  if (op === "create" && targetId) {
    return { ok: false, message: "create darf keine targetId tragen (ID wird serverseitig vergeben)." };
  }

  if (typeof a.data !== "object" || a.data === null || Array.isArray(a.data)) {
    return { ok: false, message: "data muss ein Objekt (Spalte → Wert) sein." };
  }
  const rawData = a.data as Record<string, unknown>;
  const cols = Object.keys(rawData);
  if (cols.length === 0) {
    return { ok: false, message: "data ist leer — nichts zu schreiben." };
  }

  const allowed = COLUMN_ALLOWLIST[entity];
  const maxLen = config.maxValueLen ?? DEFAULT_MAX_VALUE;
  const data: Record<string, CrmValue> = {};
  for (const col of cols) {
    if (!allowed.includes(col)) {
      return { ok: false, message: `Spalte '${col}' ist für ${entity} nicht erlaubt (erlaubt: ${allowed.join(", ")}).` };
    }
    const val = rawData[col];
    if (!isPrimitive(val)) {
      return { ok: false, message: `Wert von '${col}' muss ein Primitive (string|number|boolean|null) sein.` };
    }
    if (typeof val === "string" && val.length > maxLen) {
      return { ok: false, message: `Wert von '${col}' ist zu lang (max ${maxLen}).` };
    }
    data[col] = val;
  }

  const proposedBy = typeof a.proposedBy === "string" ? a.proposedBy.trim() : "";
  if (!proposedBy) return { ok: false, message: "Urheber (proposedBy) fehlt." };
  const reason = typeof a.reason === "string" ? a.reason.trim() || undefined : undefined;

  const action: WriteAction = { entity, op, data, proposedBy, reason };
  if (targetId) action.targetId = targetId;
  return { ok: true, value: action };
}
