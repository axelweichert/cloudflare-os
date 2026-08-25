// vonBuschOS — CRM-Gatekeeper: Schreib-Freigabe-Queue-Kern (VON-1800 / K2)
//
// Reiner, speicher-agnostischer Kern der Freigabe-Queue für SCHREIBAKTIONEN auf das CRM
// (vonbusch-crm-eu D1). Läuft workerd-frei und wird per `node --import tsx --test` getestet.
//
// Prinzip (Human-in-the-Loop):
//   - LESEN ist direkt erlaubt (siehe crm-store.ts / mcp-server.ts) — read-only ist gefahrlos.
//   - JEDE SCHREIBAKTION (create/update auf contact|deal|activity) wird zuerst als `pending`
//     Vorschlag angelegt. Ein Mensch entscheidet per `decide()` (approve|reject). Erst bei
//     approve führt der Worker die parametrisierte D1-Mutation aus und ruft `markApplied()`.
//
// Sicherheitsinvarianten (hier zentral erzwungen, nicht im Worker verstreut):
//   - Nur bekannte Entities (contact|deal|activity) und Ops (create|update).
//   - Spalten-Allowlist pro Entity: unbekannte Felder werden abgelehnt (keine SQL-Injection
//     über dynamische Spaltennamen, keine ungewollten Feld-Overwrites).
//   - Werte sind Primitive (string|number|boolean|null) — keine Objekte/Arrays.
//   - `update` verlangt eine `targetId`; `create` darf keine `targetId` tragen.
//   - Nur `pending` Items sind entscheidbar (kein Doppel-Approve / kein Race / kein Doppel-Write).
//   - Nur `approved` Items sind ausführbar (markApplied/markFailed).

export type WriteQueueStatus = "pending" | "approved" | "rejected" | "applied" | "failed";

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
  /** Wer die Aktion vorgeschlagen hat (Agent-/Gadget-Kennung). */
  proposedBy: string;
  /** Optionale Begründung für den freigebenden Menschen. */
  reason?: string;
}

export interface WriteQueueItem {
  id: string;
  action: WriteAction;
  status: WriteQueueStatus;
  createdAt: string;
  decidedAt?: string;
  /** CF-Access-Email des freigebenden/ablehnenden Menschen. */
  decidedBy?: string;
  note?: string;
  /** ID des erzeugten/aktualisierten CRM-Datensatzes nach erfolgreicher Ausführung. */
  resultId?: string;
  error?: string;
}

/** Minimaler async Store — in Tests In-Memory, in Prod DO-Storage. */
export interface WriteQueueStore {
  get(id: string): Promise<WriteQueueItem | undefined>;
  put(item: WriteQueueItem): Promise<void>;
  list(): Promise<WriteQueueItem[]>;
}

export interface WriteQueueConfig {
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

export function validateAction(input: unknown, config: WriteQueueConfig = {}): Validated<WriteAction> {
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

export class WriteApprovalQueue {
  constructor(
    private store: WriteQueueStore,
    private config: WriteQueueConfig = {},
    /** Injizierbare Zeit-/ID-Quelle (deterministisch in Tests). */
    private clock: () => string = () => new Date().toISOString(),
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Agent schlägt eine Schreibaktion vor → landet als `pending`. */
  async propose(input: unknown): Promise<Validated<WriteQueueItem>> {
    const v = validateAction(input, this.config);
    if (!v.ok) return v;
    const item: WriteQueueItem = {
      id: this.newId(),
      action: v.value,
      status: "pending",
      createdAt: this.clock(),
    };
    await this.store.put(item);
    return { ok: true, value: item };
  }

  /** Mensch entscheidet über ein `pending` Item. Idempotenz-sicher gegen Doppel-Entscheidung. */
  async decide(
    id: string,
    decision: "approve" | "reject",
    decidedBy: string,
    note?: string,
  ): Promise<Validated<WriteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "pending") {
      return { ok: false, message: `Item ist bereits '${item.status}' und kann nicht erneut entschieden werden.` };
    }
    if (!decidedBy?.trim()) return { ok: false, message: "Entscheider (decidedBy) fehlt." };

    const updated: WriteQueueItem = {
      ...item,
      status: decision === "approve" ? "approved" : "rejected",
      decidedAt: this.clock(),
      decidedBy: decidedBy.trim(),
      note: note?.trim() || undefined,
    };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  /** Nach erfolgreicher D1-Mutation aufrufen. Nur `approved` Items sind ausführbar. */
  async markApplied(id: string, resultId: string): Promise<Validated<WriteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items können ausgeführt werden (ist '${item.status}').` };
    }
    const updated: WriteQueueItem = { ...item, status: "applied", resultId };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  /** Nach fehlgeschlagener D1-Mutation aufrufen (bleibt für manuelle Prüfung erhalten). */
  async markFailed(id: string, error: string): Promise<Validated<WriteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items können fehlschlagen (ist '${item.status}').` };
    }
    const updated: WriteQueueItem = { ...item, status: "failed", error };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  async get(id: string): Promise<WriteQueueItem | undefined> {
    return this.store.get(id);
  }

  async list(status?: WriteQueueStatus): Promise<WriteQueueItem[]> {
    const all = await this.store.list();
    const filtered = status ? all.filter((i) => i.status === status) : all;
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // neueste zuerst
  }
}

/** In-Memory-Store für Tests und lokale Nutzung. */
export class MemoryWriteQueueStore implements WriteQueueStore {
  private map = new Map<string, WriteQueueItem>();
  async get(id: string): Promise<WriteQueueItem | undefined> {
    return this.map.get(id);
  }
  async put(item: WriteQueueItem): Promise<void> {
    this.map.set(item.id, item);
  }
  async list(): Promise<WriteQueueItem[]> {
    return [...this.map.values()];
  }
}
