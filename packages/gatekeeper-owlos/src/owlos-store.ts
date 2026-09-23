// owlOS — ERP-Gatekeeper: Datenzugriff (OWL-1633 / OWL-1631 Teil B, S1)
//
// owlOS ist die owlOS-eigene Cloud-ERP-Fläche. Es gibt KEINE externe owlOS-ERP-HTTP-API —
// der Gatekeeper IST das Backend (self-backed D1), exakt nach dem im Repo bewiesenen Muster
// von `vonbusch/crm-gatekeeper` (self-contained D1-Store, Token gated Zugriff). Deshalb ist der
// Treiber ohne fremde API-Doku baubar (siehe README.md → „Warum kein externer API-Call").
//
// Drei board-approvte Blueprints (OWL-1631 rev 1):
//   1. Angebot/Auftrag anlegen   → entity `angebot` (status angebot|auftrag)
//   2. Rechnung erzeugen         → entity `rechnung`
//   3. Kunde + offene Posten lesen → entity `kunde` + read `rechnung` where status='offen'
//
// Sicherheit (wie crm-store): Spaltennamen NUR aus statischer Allowlist, Werte nur als
// gebundene Parameter (?), Tabellennamen statisch gemappt, LIMIT-Caps gegen Runaway-Reads.

export type OwlosEntity = "kunde" | "angebot" | "rechnung";
export type OwlosValue = string | number | boolean | null;
export type OwlosRow = Record<string, OwlosValue>;
export type WriteOp = "create" | "update";

export const MAX_READ_LIMIT = 200;
export const DEFAULT_READ_LIMIT = 50;

/** Statisches Entity → Tabellenname (nie aus Nutzereingaben gebaut). */
export const TABLE: Record<OwlosEntity, string> = {
  kunde: "kunden",
  angebot: "angebote",
  rechnung: "rechnungen",
};

/** Erlaubte Schreibspalten pro Entity. Alles außerhalb wird abgelehnt. */
export const COLUMN_ALLOWLIST: Record<OwlosEntity, readonly string[]> = {
  kunde: ["name", "email", "firma", "telefon", "ustid", "status", "notizen"],
  // status: "angebot" (Vorschlag) | "auftrag" (angenommen) | "storniert"
  angebot: ["kunde_id", "titel", "betrag", "status", "gueltig_bis", "notizen"],
  // status: "offen" (offener Posten) | "bezahlt" | "storniert"
  rechnung: ["kunde_id", "angebot_id", "nummer", "betrag", "status", "faellig_am", "bezahlt_am", "notizen"],
};

/** Textspalten je Entity für die Freitextsuche (LIKE, parametrisiert). */
const SEARCH_COLUMNS: Record<OwlosEntity, readonly string[]> = {
  kunde: ["name", "email", "firma"],
  angebot: ["titel"],
  rechnung: ["nummer"],
};

const ENTITIES: readonly OwlosEntity[] = ["kunde", "angebot", "rechnung"];

export interface ReadOptions {
  search?: string;
  /** Filter auf kunde_id (angebote/rechnungen). */
  kundeId?: string;
  /** Filter auf status — z.B. "offen" für offene Posten (Rechnungen). */
  status?: string;
  limit?: number;
  offset?: number;
}

export interface WriteAction {
  entity: OwlosEntity;
  op: WriteOp;
  /** Pflicht bei update, verboten bei create. */
  targetId?: string;
  data: Record<string, OwlosValue>;
  proposedBy: string;
}

export interface OwlosStore {
  read(entity: OwlosEntity, opts?: ReadOptions): Promise<OwlosRow[]>;
  getById(entity: OwlosEntity, id: string): Promise<OwlosRow | undefined>;
  applyWrite(action: WriteAction, newId: () => string): Promise<{ id: string }>;
}

function isPrimitive(v: unknown): v is OwlosValue {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

const DEFAULT_MAX_VALUE = 20_000;

/** Validiert eine Schreibaktion gegen Entity-/Op-/Spalten-Allowlist (Injection-Schutz). */
export function validateWrite(input: unknown, maxValueLen = DEFAULT_MAX_VALUE): Validated<WriteAction> {
  if (typeof input !== "object" || input === null) return { ok: false, message: "Aktion muss ein Objekt sein." };
  const a = input as Record<string, unknown>;

  const entity = a.entity as OwlosEntity;
  if (!ENTITIES.includes(entity)) {
    return { ok: false, message: `Unbekannte Entity '${String(a.entity)}' (erlaubt: ${ENTITIES.join(", ")}).` };
  }
  const op = a.op as WriteOp;
  if (op !== "create" && op !== "update") {
    return { ok: false, message: `Unbekannte Operation '${String(a.op)}' (erlaubt: create, update).` };
  }

  const targetId = typeof a.targetId === "string" ? a.targetId.trim() : "";
  if (op === "update" && !targetId) return { ok: false, message: "update verlangt eine targetId." };
  if (op === "create" && targetId) return { ok: false, message: "create darf keine targetId tragen." };

  if (typeof a.data !== "object" || a.data === null || Array.isArray(a.data)) {
    return { ok: false, message: "data muss ein Objekt (Spalte → Wert) sein." };
  }
  const raw = a.data as Record<string, unknown>;
  const cols = Object.keys(raw);
  if (cols.length === 0) return { ok: false, message: "data ist leer — nichts zu schreiben." };

  const allowed = COLUMN_ALLOWLIST[entity];
  const data: Record<string, OwlosValue> = {};
  for (const col of cols) {
    if (!allowed.includes(col)) {
      return { ok: false, message: `Spalte '${col}' ist für ${entity} nicht erlaubt (erlaubt: ${allowed.join(", ")}).` };
    }
    const val = raw[col];
    if (!isPrimitive(val)) return { ok: false, message: `Wert von '${col}' muss ein Primitive sein.` };
    if (typeof val === "string" && val.length > maxValueLen) {
      return { ok: false, message: `Wert von '${col}' ist zu lang (max ${maxValueLen}).` };
    }
    data[col] = val;
  }

  const proposedBy = typeof a.proposedBy === "string" ? a.proposedBy.trim() : "";
  if (!proposedBy) return { ok: false, message: "Urheber (proposedBy) fehlt." };

  const action: WriteAction = { entity, op, data, proposedBy };
  if (targetId) action.targetId = targetId;
  return { ok: true, value: action };
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_READ_LIMIT;
  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}
function clampOffset(offset?: number): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

// ---------------------------------------------------------------------------
// In-Memory-Store — deterministisch, für Unit-Tests & lokale Nutzung (workerd-frei).
export class MemoryOwlosStore implements OwlosStore {
  private tables: Record<OwlosEntity, Map<string, OwlosRow>> = {
    kunde: new Map(),
    angebot: new Map(),
    rechnung: new Map(),
  };

  seed(entity: OwlosEntity, rows: OwlosRow[]): void {
    for (const r of rows) {
      const id = String(r.id);
      this.tables[entity].set(id, { ...r, id });
    }
  }

  async read(entity: OwlosEntity, opts: ReadOptions = {}): Promise<OwlosRow[]> {
    let rows = [...this.tables[entity].values()];
    if (opts.kundeId) rows = rows.filter((r) => String(r.kunde_id ?? "") === opts.kundeId);
    if (opts.status) rows = rows.filter((r) => String(r.status ?? "") === opts.status);
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      const cols = SEARCH_COLUMNS[entity];
      rows = rows.filter((r) => cols.some((c) => String(r[c] ?? "").toLowerCase().includes(needle)));
    }
    const offset = clampOffset(opts.offset);
    const limit = clampLimit(opts.limit);
    return rows.slice(offset, offset + limit);
  }

  async getById(entity: OwlosEntity, id: string): Promise<OwlosRow | undefined> {
    return this.tables[entity].get(id);
  }

  async applyWrite(action: WriteAction, newId: () => string): Promise<{ id: string }> {
    const table = this.tables[action.entity];
    if (action.op === "create") {
      const id = newId();
      table.set(id, { id, ...action.data });
      return { id };
    }
    const id = action.targetId!;
    const existing = table.get(id);
    if (!existing) throw new Error(`Datensatz ${action.entity}#${id} existiert nicht.`);
    table.set(id, { ...existing, ...action.data, id });
    return { id };
  }
}

// ---------------------------------------------------------------------------
// D1-Store — parametrisiert, Spalten aus statischer Allowlist.
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = OwlosRow>(): Promise<{ results: T[] }>;
      first<T = OwlosRow>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export class D1OwlosStore implements OwlosStore {
  constructor(private db: D1Like) {}

  async read(entity: OwlosEntity, opts: ReadOptions = {}): Promise<OwlosRow[]> {
    const table = TABLE[entity];
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kundeId) { where.push("kunde_id = ?"); params.push(opts.kundeId); }
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (opts.search) {
      const cols = SEARCH_COLUMNS[entity];
      const like = `%${opts.search}%`;
      where.push("(" + cols.map((c) => `${c} LIKE ?`).join(" OR ") + ")");
      cols.forEach(() => params.push(like));
    }
    const limit = clampLimit(opts.limit);
    const offset = clampOffset(opts.offset);
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM ${table}${whereSql} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const { results } = await this.db.prepare(sql).bind(...params).all<OwlosRow>();
    return results;
  }

  async getById(entity: OwlosEntity, id: string): Promise<OwlosRow | undefined> {
    const row = await this.db.prepare(`SELECT * FROM ${TABLE[entity]} WHERE id = ? LIMIT 1`).bind(id).first<OwlosRow>();
    return row ?? undefined;
  }

  async applyWrite(action: WriteAction, newId: () => string): Promise<{ id: string }> {
    const table = TABLE[action.entity];
    const allowed = COLUMN_ALLOWLIST[action.entity];
    // Defense-in-depth: erneut gegen die Allowlist filtern (validateWrite tat es bereits).
    const cols = Object.keys(action.data).filter((c) => allowed.includes(c));
    if (cols.length === 0) throw new Error("Keine gültigen Spalten zum Schreiben.");
    const values = cols.map((c) => action.data[c]);

    if (action.op === "create") {
      const id = newId();
      const columns = ["id", ...cols];
      const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      await this.db.prepare(sql).bind(id, ...values).run();
      return { id };
    }
    const id = action.targetId!;
    const setSql = cols.map((c) => `${c} = ?`).join(", ");
    await this.db.prepare(`UPDATE ${table} SET ${setSql} WHERE id = ?`).bind(...values, id).run();
    return { id };
  }
}
