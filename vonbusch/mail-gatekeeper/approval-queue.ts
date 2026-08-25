// vonBuschOS — Mail-Gatekeeper: Approval-Queue-Kern (VON-1802 / K5)
//
// Reiner, speicher-agnostischer Kern der Freigabe-Queue für ausgehende Mails.
// Läuft workerd-frei und wird per `node --import tsx --test` getestet.
//
// Ablauf: Gadgets/Agenten rufen `propose()` → Item landet als `pending` in der Queue.
// Ein Mensch entscheidet per `decide()` (approve|reject). Bei approve versendet der Worker
// über die CF `send_email`-Bindung und ruft anschließend `markSent()` / `markFailed()`.
//
// Sicherheitsinvarianten (hier zentral erzwungen, nicht im Worker verstreut):
//   - `from` MUSS auf der Sender-Allowlist stehen (Standard: noreply@vonbusch.app).
//   - Nur `pending` Items können entschieden werden (kein Doppel-Approve / kein Race).
//   - Nur `approved` Items können als versendet/fehlgeschlagen markiert werden.

export type QueueStatus = "pending" | "approved" | "rejected" | "sent" | "failed";

export interface EmailProposal {
  to: string;
  from: string;
  subject: string;
  text: string;
  /** Wer die Mail vorgeschlagen hat (Agent-/Gadget-Kennung). */
  proposedBy: string;
  /** Optionale Begründung des Vorschlags (für den freigebenden Menschen). */
  reason?: string;
}

export interface QueueItem {
  id: string;
  proposal: EmailProposal;
  status: QueueStatus;
  createdAt: string;
  decidedAt?: string;
  /** Kennung des Menschen, der freigegeben/abgelehnt hat (z.B. CF-Access-Email). */
  decidedBy?: string;
  /** Freitext-Notiz zur Entscheidung. */
  note?: string;
  /** Message-ID nach erfolgreichem Versand. */
  sentMessageId?: string;
  /** Fehlermeldung bei fehlgeschlagenem Versand. */
  error?: string;
}

/** Minimaler async Store — in Tests In-Memory, in Prod DO-Storage. */
export interface QueueStore {
  get(id: string): Promise<QueueItem | undefined>;
  put(item: QueueItem): Promise<void>;
  list(): Promise<QueueItem[]>;
}

export interface QueueConfig {
  /** Erlaubte Absenderadressen. Alles andere wird abgelehnt. */
  allowedFrom: string[];
  /** Max. Länge Betreff (Zeichen). */
  maxSubjectLen?: number;
  /** Max. Länge Body (Zeichen). */
  maxBodyLen?: number;
}

const DEFAULT_MAX_SUBJECT = 200;
const DEFAULT_MAX_BODY = 50_000;

// Bewusst konservativ: eine Adresse, kein Display-Name, keine Kommaliste.
// Mehrfachempfänger werden als separate Vorschläge modelliert.
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export function validateProposal(input: unknown, config: QueueConfig): Validated<EmailProposal> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Vorschlag muss ein Objekt sein." };
  }
  const p = input as Record<string, unknown>;

  const to = typeof p.to === "string" ? p.to.trim() : "";
  const from = typeof p.from === "string" ? p.from.trim() : "";
  const subject = typeof p.subject === "string" ? p.subject.trim() : "";
  const text = typeof p.text === "string" ? p.text : "";
  const proposedBy = typeof p.proposedBy === "string" ? p.proposedBy.trim() : "";
  const reason = typeof p.reason === "string" ? p.reason.trim() : undefined;

  if (!isEmail(to)) return { ok: false, message: "Empfänger (to) ist keine gültige E-Mail-Adresse." };
  if (!isEmail(from)) return { ok: false, message: "Absender (from) ist keine gültige E-Mail-Adresse." };

  const allowed = config.allowedFrom.map((a) => a.trim().toLowerCase());
  if (!allowed.includes(from.toLowerCase())) {
    return { ok: false, message: `Absender ${from} steht nicht auf der Allowlist.` };
  }

  if (!subject) return { ok: false, message: "Betreff (subject) fehlt." };
  if (subject.length > (config.maxSubjectLen ?? DEFAULT_MAX_SUBJECT)) {
    return { ok: false, message: "Betreff ist zu lang." };
  }
  // Header-Injection-Schutz: keine Zeilenumbrüche im Betreff.
  if (/[\r\n]/.test(subject)) return { ok: false, message: "Betreff darf keine Zeilenumbrüche enthalten." };

  if (!text.trim()) return { ok: false, message: "Text (text) fehlt." };
  if (text.length > (config.maxBodyLen ?? DEFAULT_MAX_BODY)) {
    return { ok: false, message: "Text ist zu lang." };
  }

  if (!proposedBy) return { ok: false, message: "Urheber (proposedBy) fehlt." };

  return { ok: true, value: { to, from, subject, text, proposedBy, reason } };
}

export class MailApprovalQueue {
  constructor(
    private store: QueueStore,
    private config: QueueConfig,
    /** Injizierbare ID-/Zeitquelle (deterministisch in Tests). */
    private clock: () => string = () => new Date().toISOString(),
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Agent schlägt eine Mail vor → landet als `pending`. */
  async propose(input: unknown): Promise<Validated<QueueItem>> {
    const v = validateProposal(input, this.config);
    if (!v.ok) return v;
    const item: QueueItem = {
      id: this.newId(),
      proposal: v.value,
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
  ): Promise<Validated<QueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "pending") {
      return { ok: false, message: `Item ist bereits '${item.status}' und kann nicht erneut entschieden werden.` };
    }
    if (!decidedBy?.trim()) return { ok: false, message: "Entscheider (decidedBy) fehlt." };

    const updated: QueueItem = {
      ...item,
      status: decision === "approve" ? "approved" : "rejected",
      decidedAt: this.clock(),
      decidedBy: decidedBy.trim(),
      note: note?.trim() || undefined,
    };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  /** Nach erfolgreichem Versand aufrufen. Nur `approved` Items sind versendbar. */
  async markSent(id: string, messageId: string): Promise<Validated<QueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items können versendet werden (ist '${item.status}').` };
    }
    const updated: QueueItem = { ...item, status: "sent", sentMessageId: messageId };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  /** Nach fehlgeschlagenem Versand aufrufen (bleibt für Retry manuell prüfbar). */
  async markFailed(id: string, error: string): Promise<Validated<QueueItem>> {
    const item = await this.store.get(id);
    if (!item) return { ok: false, message: "Unbekannte Vorschlags-ID." };
    if (item.status !== "approved") {
      return { ok: false, message: `Nur freigegebene Items können fehlschlagen (ist '${item.status}').` };
    }
    const updated: QueueItem = { ...item, status: "failed", error };
    await this.store.put(updated);
    return { ok: true, value: updated };
  }

  async get(id: string): Promise<QueueItem | undefined> {
    return this.store.get(id);
  }

  async list(status?: QueueStatus): Promise<QueueItem[]> {
    const all = await this.store.list();
    const filtered = status ? all.filter((i) => i.status === status) : all;
    // Neueste zuerst.
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

/** In-Memory-Store für Tests und lokale Nutzung. */
export class MemoryQueueStore implements QueueStore {
  private map = new Map<string, QueueItem>();
  async get(id: string): Promise<QueueItem | undefined> {
    return this.map.get(id);
  }
  async put(item: QueueItem): Promise<void> {
    this.map.set(item.id, item);
  }
  async list(): Promise<QueueItem[]> {
    return [...this.map.values()];
  }
}
