// vonBuschOS — CRM-Gatekeeper (K2-Port, VON-1817): CRM-Datenzugriff
//
// Portiert 1:1 aus `vonbusch/crm-gatekeeper/crm-store.ts` (VON-1800). Kapselt Lese- und
// Schreibzugriff auf das CRM (vonbusch-crm-eu D1). Reads sind read-only (im OS-Port zusätzlich
// per `authorizeObservation()` autorisiert); Writes laufen ausschließlich über bereits
// freigegebene `WriteAction`s (OS-`ApprovalQueue` → `applyAction()` → `applyWrite()`).
//
// Zwei Implementierungen:
//   - `MemoryCrmStore`  — In-Memory, für Unit-Tests & lokale Nutzung (workerd-frei).
//   - `D1CrmStore`      — parametrisiertes D1 (nur allowlistete Spalten, LIMIT-Caps).
//
// Sicherheit: Spaltennamen stammen NUR aus der Allowlist (crm-actions.ts), Werte werden
// ausschließlich als gebundene Parameter (?) übergeben — kein String-Interpolieren von Nutzdaten
// in SQL. Tabellennamen sind statisch pro Entity gemappt.

import type { CrmEntity, WriteAction, CrmValue } from "./crm-actions";
import { COLUMN_ALLOWLIST } from "./crm-actions";

export const MAX_READ_LIMIT = 200;
export const DEFAULT_READ_LIMIT = 50;

/** Statisches, sicheres Mapping Entity → Tabellenname (nie aus Nutzereingaben gebaut). */
export const TABLE: Record<CrmEntity, string> = {
  contact: "contacts",
  deal: "deals",
  activity: "activities",
};

export interface ReadOptions {
  /** Freitext-Suche über die Textspalten der Entity (LIKE, parametrisiert). */
  search?: string;
  /** Filter auf contact_id (deals/activities). */
  contactId?: string;
  limit?: number;
  offset?: number;
}

export type CrmRow = Record<string, CrmValue>;

export interface CrmStore {
  read(entity: CrmEntity, opts?: ReadOptions): Promise<CrmRow[]>;
  getById(entity: CrmEntity, id: string): Promise<CrmRow | undefined>;
  /** Führt eine bereits freigegebene Schreibaktion aus; liefert die Datensatz-ID. */
  applyWrite(action: WriteAction, newId: () => string): Promise<{ id: string }>;
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_READ_LIMIT;
  return Math.min(Math.floor(limit), MAX_READ_LIMIT);
}
function clampOffset(offset?: number): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/** Textspalten je Entity, über die die Freitextsuche läuft. */
// Textspalten gegen das ECHTE Prod-Schema `vonbusch-crm-eu` (VON-1850). contacts hat KEIN
// `name`/`company` → Freitextsuche läuft über first_name/last_name/email.
const SEARCH_COLUMNS: Record<CrmEntity, readonly string[]> = {
  contact: ["first_name", "last_name", "email"],
  deal: ["title"],
  activity: ["subject", "body"],
};

// ---------------------------------------------------------------------------
// In-Memory-Store — deterministisch, für Tests & lokale Nutzung.
export class MemoryCrmStore implements CrmStore {
  private tables: Record<CrmEntity, Map<string, CrmRow>> = {
    contact: new Map(),
    deal: new Map(),
    activity: new Map(),
  };

  /** Testhelfer: Seed-Daten setzen. */
  seed(entity: CrmEntity, rows: CrmRow[]): void {
    for (const r of rows) {
      const id = String(r.id);
      this.tables[entity].set(id, { ...r, id });
    }
  }

  async read(entity: CrmEntity, opts: ReadOptions = {}): Promise<CrmRow[]> {
    let rows = [...this.tables[entity].values()];
    if (opts.contactId) rows = rows.filter((r) => String(r.contact_id ?? "") === opts.contactId);
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      const searchCols = SEARCH_COLUMNS[entity];
      rows = rows.filter((r) => searchCols.some((c) => String(r[c] ?? "").toLowerCase().includes(needle)));
    }
    const offset = clampOffset(opts.offset);
    const limit = clampLimit(opts.limit);
    return rows.slice(offset, offset + limit);
  }

  async getById(entity: CrmEntity, id: string): Promise<CrmRow | undefined> {
    return this.tables[entity].get(id);
  }

  async applyWrite(action: WriteAction, newId: () => string): Promise<{ id: string }> {
    const table = this.tables[action.entity];
    if (action.op === "create") {
      const id = newId();
      table.set(id, { id, ...action.data });
      return { id };
    }
    // update
    const id = action.targetId!;
    const existing = table.get(id);
    if (!existing) throw new Error(`Datensatz ${action.entity}#${id} existiert nicht.`);
    table.set(id, { ...existing, ...action.data, id });
    return { id };
  }
}

// ---------------------------------------------------------------------------
// D1-Store — parametrisiert, Spalten aus statischer Allowlist.
// Minimales D1-Interface (workerd) — kein cloudflare:workers-Import nötig.
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = CrmRow>(): Promise<{ results: T[] }>;
      first<T = CrmRow>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export class D1CrmStore implements CrmStore {
  constructor(private db: D1Like) {}

  async read(entity: CrmEntity, opts: ReadOptions = {}): Promise<CrmRow[]> {
    const table = TABLE[entity];
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.contactId) {
      where.push("contact_id = ?");
      params.push(opts.contactId);
    }
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

    const { results } = await this.db.prepare(sql).bind(...params).all<CrmRow>();
    return results;
  }

  async getById(entity: CrmEntity, id: string): Promise<CrmRow | undefined> {
    const table = TABLE[entity];
    const row = await this.db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).bind(id).first<CrmRow>();
    return row ?? undefined;
  }

  async applyWrite(action: WriteAction, newId: () => string): Promise<{ id: string }> {
    const table = TABLE[action.entity];
    const allowed = COLUMN_ALLOWLIST[action.entity];
    // Defense-in-depth: hier nochmals gegen die Allowlist filtern (die Validierung tat es bereits).
    const cols = Object.keys(action.data).filter((c) => allowed.includes(c));
    if (cols.length === 0) throw new Error("Keine gültigen Spalten zum Schreiben.");
    const values = cols.map((c) => action.data[c]);

    if (action.op === "create") {
      const id = newId();
      const columns = ["id", ...cols];
      const placeholders = columns.map(() => "?").join(", ");
      const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
      await this.db.prepare(sql).bind(id, ...values).run();
      return { id };
    }

    // update
    const id = action.targetId!;
    const setSql = cols.map((c) => `${c} = ?`).join(", ");
    const sql = `UPDATE ${table} SET ${setSql} WHERE id = ?`;
    await this.db.prepare(sql).bind(...values, id).run();
    return { id };
  }
}
