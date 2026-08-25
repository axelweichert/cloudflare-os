// vonBuschOS — JustIn-ERP-Gatekeeper: Angebots-Freigabe-Queue (VON-1804 / K3)
//
// Reiner, speicher-agnostischer Kern der Approval-Queue für die EINZIGE mutierende Aktion
// des ERP-Gatekeepers: "Angebot erstellen". Workerd-frei, per `npx tsx --test` testbar.
//
// Prinzip (Human-in-the-Loop):
//   - LESEN (Rechnungen/Aufträge/Bestände/Auftragsstatus) ist direkt erlaubt — read-only.
//   - "Angebot erstellen" wird zuerst als `pending` Vorschlag angelegt. Ein Mensch entscheidet
//     per `decide()` (approve|reject). Erst bei approve ruft der Worker `adapter.createQuote`
//     gegen das reale ERP auf und ruft `markApplied()`.
//
// Sicherheitsinvarianten (hier zentral erzwungen):
//   - `customerId` ist Pflicht (kein anonymes Angebot).
//   - `lines` ist ein nicht-leeres Array aus {sku:string, qty:number>0, [unitPrice:number>=0]}.
//   - Positions-/Preis-Obergrenzen kappen versehentliche/bösartige Mega-Angebote.
//   - Nur `pending` Items sind entscheidbar (kein Doppel-Approve / kein Race / kein Doppel-Write).
//   - Nur `approved` Items sind ausführbar (markApplied/markFailed).

import type { CreateQuoteInput, QuoteLine } from "./erp-adapter.ts";

export type QuoteQueueStatus = "pending" | "approved" | "rejected" | "applied" | "failed";

export interface QuoteAction extends CreateQuoteInput {
  /** Wer die Aktion vorgeschlagen hat (Agent-/Gadget-Kennung). */
  proposedBy: string;
  /** Optionale Begründung für den freigebenden Menschen. */
  reason?: string;
}

export interface QuoteQueueItem {
  id: string;
  action: QuoteAction;
  status: QuoteQueueStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  /** ERP-Angebots-ID/-Nummer nach erfolgreicher Ausführung. */
  resultId?: string;
  resultNumber?: string;
  error?: string;
}

export interface QuoteQueueStore {
  get(id: string): Promise<QuoteQueueItem | undefined>;
  put(item: QuoteQueueItem): Promise<void>;
  list(): Promise<QuoteQueueItem[]>;
}

export interface QuoteQueueConfig {
  /** Max. Anzahl Positionen pro Angebot. */
  maxLines?: number;
  /** Max. Menge pro Position. */
  maxQty?: number;
  /** Max. Stückpreis (netto). */
  maxUnitPrice?: number;
  /** Max. Länge freier Textfelder. */
  maxTextLen?: number;
}

const DEFAULTS = { maxLines: 200, maxQty: 1_000_000, maxUnitPrice: 10_000_000, maxTextLen: 5_000 };

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export function validateQuote(input: unknown, cfg: QuoteQueueConfig = {}): Validated<QuoteAction> {
  const c = { ...DEFAULTS, ...cfg };
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Angebot muss ein Objekt sein." };
  }
  const a = input as Record<string, unknown>;

  const customerId = typeof a.customerId === "string" ? a.customerId.trim() : "";
  if (!customerId) return { ok: false, message: "customerId ist Pflicht." };

  if (!Array.isArray(a.lines) || a.lines.length === 0) {
    return { ok: false, message: "lines muss ein nicht-leeres Array sein." };
  }
  if (a.lines.length > c.maxLines) {
    return { ok: false, message: `Zu viele Positionen (max ${c.maxLines}).` };
  }
  const lines: QuoteLine[] = [];
  for (let i = 0; i < a.lines.length; i++) {
    const raw = a.lines[i] as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, message: `Position ${i + 1} muss ein Objekt sein.` };
    }
    const sku = typeof raw.sku === "string" ? raw.sku.trim() : "";
    if (!sku) return { ok: false, message: `Position ${i + 1}: sku fehlt.` };
    const qty = raw.qty;
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
      return { ok: false, message: `Position ${i + 1}: qty muss eine Zahl > 0 sein.` };
    }
    if (qty > c.maxQty) return { ok: false, message: `Position ${i + 1}: qty über Obergrenze (${c.maxQty}).` };
    const line: QuoteLine = { sku, qty };
    if (raw.unitPrice !== undefined) {
      const up = raw.unitPrice;
      if (typeof up !== "number" || !Number.isFinite(up) || up < 0) {
        return { ok: false, message: `Position ${i + 1}: unitPrice muss eine Zahl >= 0 sein.` };
      }
      if (up > c.maxUnitPrice) return { ok: false, message: `Position ${i + 1}: unitPrice über Obergrenze.` };
      line.unitPrice = up;
    }
    lines.push(line);
  }

  const note = typeof a.note === "string" ? a.note.trim() || undefined : undefined;
  if (note && note.length > c.maxTextLen) return { ok: false, message: "note zu lang." };
  const validUntil = typeof a.validUntil === "string" ? a.validUntil.trim() || undefined : undefined;

  const proposedBy = typeof a.proposedBy === "string" ? a.proposedBy.trim() : "";
  if (!proposedBy) return { ok: false, message: "Urheber (proposedBy) fehlt." };
  const reason = typeof a.reason === "string" ? a.reason.trim() || undefined : undefined;

  const action: QuoteAction = { customerId, lines, proposedBy };
  if (note) action.note = note;
  if (validUntil) action.validUntil = validUntil;
  if (reason) action.reason = reason;
  return { ok: true, value: action };
}

export class QuoteApprovalQueue {
  constructor(
    private store: QuoteQueueStore,
    private config: QuoteQueueConfig = {},
    private clock: () => string = () => new Date().toISOString(),
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  async propose(input: unknown): Promise<Validated<QuoteQueueItem>> {
    const v = validateQuote(input, this.config);
    if (!v.ok) return v;
    const item: QuoteQueueItem = {
      id: this.newId(),
      action: v.value,
      status: "pending",
      createdAt: this.clock(),
    };
    await this.store.put(item);
    return { ok: true, value: item };
  }

  async decide(
    id: string,
    decision: "approve" | "reject",
    decidedBy: string,
    note?: string,
  ): Promise<Validated<QuoteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "pending") {
      return { ok: false, message: `Item ist bereits '${item.status}' und kann nicht erneut entschieden werden.` };
    }
    if (!decidedBy?.trim()) return { ok: false, message: "Entscheider (decidedBy) fehlt." };

    const updated: QuoteQueueItem = {
      ...item,
      status: decision === "approve" ? "approved" : "rejected",
      decidedAt: this.clock(),
      decidedBy: decidedBy.trim(),
      note: note?.trim() || undefined,
    };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  async markApplied(id: string, resultId: string, resultNumber?: string): Promise<Validated<QuoteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items können ausgeführt werden (ist '${item.status}').` };
    }
    const updated: QuoteQueueItem = { ...item, status: "applied", resultId, resultNumber };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  async markFailed(id: string, error: string): Promise<Validated<QuoteQueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items können fehlschlagen (ist '${item.status}').` };
    }
    const updated: QuoteQueueItem = { ...item, status: "failed", error };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  async get(id: string): Promise<QuoteQueueItem | undefined> {
    return this.store.get(id);
  }

  async list(status?: QuoteQueueStatus): Promise<QuoteQueueItem[]> {
    const all = await this.store.list();
    const filtered = status ? all.filter((i) => i.status === status) : all;
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

/** In-Memory-Store für Tests und lokale Nutzung. */
export class MemoryQuoteQueueStore implements QuoteQueueStore {
  private map = new Map<string, QuoteQueueItem>();
  async get(id: string) { return this.map.get(id); }
  async put(item: QuoteQueueItem) { this.map.set(item.id, item); }
  async list() { return [...this.map.values()]; }
}
