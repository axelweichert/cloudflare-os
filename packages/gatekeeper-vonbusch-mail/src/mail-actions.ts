// vonBuschOS — Mail-Gatekeeper (K5-Port, VON-1818): Vorschlags-Typen + Validierung
//
// Portiert aus `vonbusch/mail-gatekeeper/approval-queue.ts` (VON-1802). Behalten wird der
// transport-freie, workerd-freie VALIDIERUNGSKERN (E-Mail-Prüfung, Sender-Allowlist, Längen-Caps,
// Header-Injection-Schutz). NICHT übernommen wird die alte `MailApprovalQueue` samt eigenem Store:
// deren Rolle (pending → approve → sent/failed) übernimmt im OS-Port die OS-`ApprovalQueue`
// (`submitAction()` → `applyAction()`), siehe session-core.ts / mail-gatekeeper.ts.
//
// Sicherheitsinvarianten (hier zentral erzwungen, nicht im Worker verstreut):
//   - `from` MUSS auf der Sender-Allowlist stehen (Standard: noreply@vonbusch.app).
//   - `to`/`from` müssen genau EINE gültige Adresse sein (kein Display-Name, keine Kommaliste).
//   - Betreff enthält keine Zeilenumbrüche (Header-Injection-Schutz) und ist längenbegrenzt.
//   - Body ist nicht leer und längenbegrenzt.

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

/**
 * Validiert einen roh eingereichten Mail-Vorschlag gegen alle Invarianten und normalisiert ihn zu
 * einer sicheren `EmailProposal`. Gibt eine Fehlermeldung statt zu werfen (ein Vorschlag darf das
 * Gadget nicht crashen).
 */
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
  const reason = typeof p.reason === "string" ? p.reason.trim() || undefined : undefined;

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

/** Zerlegt die `ALLOWED_FROM`/`DEFAULT_FROM`-Env-Vars (Kommaliste) in eine getrimmte Allowlist. */
export function parseAllowedFrom(allowedFrom?: string, defaultFrom?: string): string[] {
  const raw = allowedFrom ?? defaultFrom ?? "noreply@vonbusch.app";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Der Standardabsender, falls ein Vorschlag kein `from` trägt. */
export function resolveDefaultFrom(allowedFrom?: string, defaultFrom?: string): string {
  return (defaultFrom ?? parseAllowedFrom(allowedFrom, defaultFrom)[0] ?? "noreply@vonbusch.app").trim();
}
