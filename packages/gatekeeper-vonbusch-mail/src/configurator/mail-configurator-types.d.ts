// Typen des Mail-Ressourcen-Konfigurators (sandboxed iframe ↔ Vendor-`ui`-Capability).
//
// Der vonBusch-Mailer hat genau EINE Ressource (den ausgehenden Mail-Kanal mail.vonbusch.app); es
// gibt nichts auszuwählen. Der Konfigurator existiert nur, weil die OS-Connect-Modal-UI auch bei
// fest verdrahteten Einzelressourcen einen Konfigurator-Frame verlangt, bevor „Add connection"
// aktiv wird. Deshalb hat das Formular keine Werte und liefert nur die feste Ressourcen-URL.

export type MailConfiguratorValues = Record<string, string | null | undefined>;

export interface MailConfiguratorRpc {
  /** Die feste Mail-Ressourcen-URL — serverseitig autoritativ (eine Quelle der Wahrheit). */
  resourceUrl(): Promise<string>;
}
