// Typen des CRM-Ressourcen-Konfigurators (sandboxed iframe ↔ Vendor-`ui`-Capability).
//
// Das vonBusch-CRM hat genau EINE Ressource (die Firmen-CRM-Datenbank vonbusch-crm-eu); es gibt
// nichts auszuwählen. Der Konfigurator existiert nur, weil die OS-Connect-Modal-UI auch bei fest
// verdrahteten Einzelressourcen einen Konfigurator-Frame verlangt, bevor „Add connection" aktiv
// wird. Deshalb hat das Formular keine Werte und liefert nur die feste Ressourcen-URL.

export type CrmConfiguratorValues = Record<string, string | null | undefined>;

export interface CrmConfiguratorRpc {
  /** Die feste CRM-Ressourcen-URL — serverseitig autoritativ (eine Quelle der Wahrheit). */
  resourceUrl(): Promise<string>;
}
