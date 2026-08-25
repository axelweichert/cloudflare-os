// Interne per-Mailbox-Autorisierung (schließt die VON-1798-Lücke: bisher war CF Access die EINZIGE
// Boundary, jede authentifizierte Person sah jede Mailbox). Der Gatekeeper trägt jetzt selbst eine
// Zugriffsliste je Mailbox und prüft sie in `addObserver` — fail-closed.
//
// Transport-frei, damit tsx-testbar. Die konkrete ACL kommt zur Deploy-Zeit aus der Env
// (`MAILBOX_ACL`, CEO-Gate) und ist hier nur Datenstruktur + Prüf-Logik.

/** Zugriffsliste: Mailbox-ID → erlaubte Beobachter-Identitäten (i. d. R. verifizierte E-Mails). */
export type MailboxAcl = {
  /** Pro Mailbox die erlaubten Identitäten. Fehlt eine Mailbox, ist sie für niemanden freigegeben. */
  mailboxes: Record<string, string[]>;
  /** Optionale globale Admins, die jede Mailbox beobachten dürfen. */
  admins?: string[];
};

/** Parst die `MAILBOX_ACL`-Env-Var (JSON). Ungültig/fehlt ⇒ leere, fail-closed ACL. */
export function parseAcl(raw: string | undefined): MailboxAcl {
  if (!raw) return { mailboxes: {} };
  try {
    const parsed = JSON.parse(raw) as MailboxAcl;
    return { mailboxes: parsed.mailboxes ?? {}, admins: parsed.admins };
  } catch {
    return { mailboxes: {} };
  }
}

function norm(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Darf `identity` die `mailbox` beobachten? Fail-closed: leere ACL / unbekannte Mailbox /
 * leere Identität ⇒ false. Vergleich case-insensitiv (E-Mails).
 */
export function canObserveMailbox(acl: MailboxAcl, mailbox: string, identity: string | null): boolean {
  if (!identity) return false;
  const id = norm(identity);
  if ((acl.admins ?? []).some(a => norm(a) === id)) return true;
  const allowed = acl.mailboxes[mailbox] ?? acl.mailboxes[norm(mailbox)];
  if (!allowed) return false;
  return allowed.some(a => norm(a) === id);
}

/**
 * Liste der Mailboxen, die `identity` (mind.) beobachten darf. Admins sehen alle. Dient der
 * per-Nutzer-Sichtbarkeit in `getSupportedResources({userId})` — leere Liste ⇒ Gatekeeper unsichtbar.
 */
export function allowedMailboxesFor(acl: MailboxAcl, identity: string | null): string[] {
  if (!identity) return [];
  const id = norm(identity);
  if ((acl.admins ?? []).some(a => norm(a) === id)) return Object.keys(acl.mailboxes);
  return Object.entries(acl.mailboxes)
    .filter(([, allowed]) => allowed.some(a => norm(a) === id))
    .map(([mailbox]) => mailbox);
}
