// Typen des Mailbox-Ressourcen-Konfigurators (sandboxed iframe ↔ Vendor-`ui`-Capability).
//
// Anders als CRM/Mail (fest verdrahtete Einzelressource) verlangt die Mailbox eine KONKRETE
// Inbox-ID in der Ressourcen-URL (`https://mail.vonbusch.app/inbox/<id>`, siehe `mailboxFromUrl`).
// Ein wildcard `.../inbox/*` als gebundene Ressource wäre kaputt. Deshalb hat der Konfigurator EIN
// Eingabefeld (Inbox-ID) und liefert die daraus gebaute, serverseitig autoritative Ressourcen-URL.

export type MailboxConfiguratorValues = {
  /** Die vom Nutzer eingegebene agentic-inbox-Inbox-ID (z. B. ein Ordner-/Mailbox-Name). */
  inboxId?: string | null;
};

export interface MailboxConfiguratorRpc {
  /**
   * Baut die feste Mailbox-Ressourcen-URL aus der eingegebenen Inbox-ID — serverseitig autoritativ
   * (Host/Prefix/Encoding als eine Quelle der Wahrheit im Vendor). Wirft bei leerer ID.
   */
  resourceUrl(inboxId: string): Promise<string>;
}
