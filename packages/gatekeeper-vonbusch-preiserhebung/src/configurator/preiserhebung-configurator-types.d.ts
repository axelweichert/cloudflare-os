// Typen des Preiserhebungs-Ressourcen-Konfigurators (sandboxed iframe ↔ Vendor-`ui`-Capability).
//
// Preiserhebung hat genau EINE Ressource (die read-only Preis-D1 der printgemein-Druckpreis- und
// DMS-ROI-Engine); es gibt nichts auszuwählen. Der Konfigurator existiert nur, weil die OS-Connect-
// Modal-UI auch bei fest verdrahteten Einzelressourcen einen Konfigurator-Frame verlangt, bevor
// „Add connection" aktiv wird. Deshalb hat das Formular keine Werte und liefert nur die feste
// Ressourcen-URL zurück.

export type PreiserhebungConfiguratorValues = Record<string, string | null | undefined>;

export interface PreiserhebungConfiguratorRpc {
  /** Die feste Preiserhebungs-Ressourcen-URL — serverseitig autoritativ (eine Quelle der Wahrheit). */
  resourceUrl(): Promise<string>;
}
