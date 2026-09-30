// owlOS — Etsy-Gatekeeper: Schreib-Freigabe-Queue-Kern (OWL-1740, Elternticket OWL-1739)
//
// Reiner, speicher-agnostischer Kern der Freigabe-Queue fuer SCHREIBAKTIONEN gegen die
// Etsy Open API v3. Laeuft workerd-frei und wird per `npx tsx --test` getestet.
//
// Prinzip (Human-in-the-Loop):
//   - LESEN ist direkt erlaubt (siehe etsy-client.ts / mcp-server.ts) — read-only ist gefahrlos.
//   - JEDE SCHREIBAKTION (update auf listing|receipt) wird zuerst als `pending` Vorschlag
//     angelegt. Ein Mensch entscheidet per `decide()` (approve|reject). Erst bei approve
//     fuehrt der Worker den Etsy-Write (PATCH/PUT) aus und ruft `markApplied()`.
//
// Sicherheitsinvarianten (hier zentral erzwungen, nicht im Worker verstreut):
//   - Nur bekannte Ziele (listing|receipt) und Ops (nur `update` — dieser Gatekeeper legt
//     weder Listings noch Bestellungen an, er aktualisiert bestehende).
//   - Feld-Allowlist pro Ziel: unbekannte Felder werden abgelehnt. Zusaetzlich pro Feld ein
//     Typ-/Enum-Check (Defense-in-depth) — Etsy ist strenger als ein CRM.
//   - Werte sind Primitive (string|number|boolean|null) — keine Objekte/Arrays. (Etsy-Arrays
//     wie tags/materials und der verschachtelte Inventory-Payload sind bewusst NICHT im v1-
//     Umfang, damit die Allowlist-/Primitive-Invariante sauber bleibt — siehe README.)
//   - `update` verlangt immer eine `targetId` (listing_id bzw. receipt_id).
//   - Nur `pending` Items sind entscheidbar (kein Doppel-Approve / kein Race / kein Doppel-Write).
//   - Nur `approved` Items sind ausfuehrbar (markApplied/markFailed).

export type WriteQueueStatus = "pending" | "approved" | "rejected" | "applied" | "failed";

export type EtsyTarget = "listing" | "receipt";
export type WriteOp = "update";

export type EtsyValue = string | number | boolean | null;

/** Typ-/Enum-Spezifikation eines erlaubten Feldes (Defense-in-depth zur reinen Allowlist). */
interface FieldSpec {
  type: "string" | "number" | "boolean";
  /** Optionale Enum-Beschraenkung fuer String-Felder (z.B. listing.state). */
  enum?: readonly string[];
  /** Max. Laenge fuer String-Felder. */
  maxLen?: number;
}

/**
 * Erlaubte Schreibfelder pro Ziel — flach und primitiv, 1:1 auf die Etsy-Endpoints:
 *   listing  → PATCH /v3/application/shops/{shop_id}/listings/{listing_id}   (scope listings_w)
 *   receipt  → PUT   /v3/application/shops/{shop_id}/receipts/{receipt_id}   (scope transactions_w)
 * Preis/Menge liegen bei Etsy NICHT auf updateListing, sondern auf dem verschachtelten
 * updateListingInventory-Payload — bewusst nicht im v1-Umfang (siehe README).
 */
export const FIELD_ALLOWLIST: Record<EtsyTarget, Record<string, FieldSpec>> = {
  listing: {
    title: { type: "string", maxLen: 140 },
    description: { type: "string", maxLen: 20_000 },
    state: { type: "string", enum: ["active", "inactive"] },
    should_auto_renew: { type: "boolean" },
    shop_section_id: { type: "number" },
  },
  receipt: {
    was_shipped: { type: "boolean" },
    was_paid: { type: "boolean" },
  },
};

/** Etsy-Endpoint-Metadaten pro Ziel (statisch — nie aus Nutzereingaben gebaut). */
export const TARGET_ENDPOINT: Record<EtsyTarget, { method: "PATCH" | "PUT"; scope: string }> = {
  listing: { method: "PATCH", scope: "listings_w" },
  receipt: { method: "PUT", scope: "transactions_w" },
};

export interface WriteAction {
  target: EtsyTarget;
  op: WriteOp;
  /** Pflicht: listing_id bzw. receipt_id des zu aendernden Datensatzes. */
  targetId: string;
  /** Feld → Wert. Nur allowlistete Felder, nur Primitive, pro Feld typ-/enum-geprueft. */
  data: Record<string, EtsyValue>;
  /** Wer die Aktion vorgeschlagen hat (Agent-Kennung). */
  proposedBy: string;
  /** Optionale Begruendung fuer den freigebenden Menschen. */
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
  /** ID des aktualisierten Etsy-Datensatzes nach erfolgreicher Ausfuehrung. */
  resultId?: string;
  error?: string;
}

/** Minimaler async Store — in Tests In-Memory, in Prod DO-Storage. */
export interface WriteQueueStore {
  get(id: string): Promise<WriteQueueItem | undefined>;
  put(item: WriteQueueItem): Promise<void>;
  list(): Promise<WriteQueueItem[]>;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

const TARGETS: readonly EtsyTarget[] = ["listing", "receipt"];

function checkValue(field: string, spec: FieldSpec, val: unknown): string | null {
  if (val === null) return null; // null ist ein erlaubtes Primitive (Feld zuruecksetzen)
  if (typeof val !== spec.type) {
    return `Wert von '${field}' muss ${spec.type} sein.`;
  }
  if (spec.type === "string") {
    const s = val as string;
    if (spec.enum && !spec.enum.includes(s)) {
      return `Wert von '${field}' muss einer von [${spec.enum.join(", ")}] sein.`;
    }
    if (spec.maxLen && s.length > spec.maxLen) {
      return `Wert von '${field}' ist zu lang (max ${spec.maxLen}).`;
    }
  }
  return null;
}

export function validateAction(input: unknown): Validated<WriteAction> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Schreibaktion muss ein Objekt sein." };
  }
  const a = input as Record<string, unknown>;

  const target = a.target as EtsyTarget;
  if (!TARGETS.includes(target)) {
    return { ok: false, message: `Unbekanntes Ziel '${String(a.target)}' (erlaubt: ${TARGETS.join(", ")}).` };
  }
  // Nur `update` — dieser Gatekeeper aendert bestehende Datensaetze, er legt keine an.
  if (a.op !== undefined && a.op !== "update") {
    return { ok: false, message: `Unbekannte Operation '${String(a.op)}' (erlaubt: update).` };
  }

  const targetId = typeof a.targetId === "string" ? a.targetId.trim() : "";
  if (!targetId) {
    return { ok: false, message: "update verlangt eine targetId (listing_id bzw. receipt_id)." };
  }
  // Etsy-IDs sind numerisch — fruehe, defensive Pruefung.
  if (!/^\d+$/.test(targetId)) {
    return { ok: false, message: "targetId muss eine numerische Etsy-ID sein." };
  }

  if (typeof a.data !== "object" || a.data === null || Array.isArray(a.data)) {
    return { ok: false, message: "data muss ein Objekt (Feld → Wert) sein." };
  }
  const rawData = a.data as Record<string, unknown>;
  const fields = Object.keys(rawData);
  if (fields.length === 0) {
    return { ok: false, message: "data ist leer — nichts zu schreiben." };
  }

  const allowed = FIELD_ALLOWLIST[target];
  const data: Record<string, EtsyValue> = {};
  for (const field of fields) {
    const spec = allowed[field];
    if (!spec) {
      return {
        ok: false,
        message: `Feld '${field}' ist fuer ${target} nicht erlaubt (erlaubt: ${Object.keys(allowed).join(", ")}).`,
      };
    }
    const val = rawData[field];
    if (typeof val === "object" && val !== null) {
      return { ok: false, message: `Wert von '${field}' muss ein Primitive (string|number|boolean|null) sein.` };
    }
    const problem = checkValue(field, spec, val);
    if (problem) return { ok: false, message: problem };
    data[field] = val as EtsyValue;
  }

  const proposedBy = typeof a.proposedBy === "string" ? a.proposedBy.trim() : "";
  if (!proposedBy) return { ok: false, message: "Urheber (proposedBy) fehlt." };
  const reason = typeof a.reason === "string" ? a.reason.trim() || undefined : undefined;

  const action: WriteAction = { target, op: "update", targetId, data, proposedBy, reason };
  return { ok: true, value: action };
}

export class WriteApprovalQueue {
  constructor(
    private store: WriteQueueStore,
    /** Injizierbare Zeit-/ID-Quelle (deterministisch in Tests). */
    private clock: () => string = () => new Date().toISOString(),
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Agent schlaegt eine Schreibaktion vor → landet als `pending`. */
  async propose(input: unknown): Promise<Validated<WriteQueueItem>> {
    const v = validateAction(input);
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

  /** Mensch entscheidet ueber ein `pending` Item. Idempotenz-sicher gegen Doppel-Entscheidung. */
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

  /** Nach erfolgreichem Etsy-Write aufrufen. Nur `approved` Items sind ausfuehrbar. */
  async markApplied(id: string, resultId: string): Promise<Validated<WriteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items koennen ausgefuehrt werden (ist '${item.status}').` };
    }
    const updated: WriteQueueItem = { ...item, status: "applied", resultId };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  /** Nach fehlgeschlagenem Etsy-Write aufrufen (bleibt fuer manuelle Pruefung erhalten). */
  async markFailed(id: string, error: string): Promise<Validated<WriteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items koennen fehlschlagen (ist '${item.status}').` };
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

/** In-Memory-Store fuer Tests und lokale Nutzung. */
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
