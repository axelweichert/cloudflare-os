/**
 * Preiserhebungs-Session — die Tool-Oberfläche des Gadget-Bausteins (VON-1801).
 *
 * Runtime-agnostisch: hängt nur an einer read-only `PreisRepo`-Abstraktion, nicht
 * an D1/Workers direkt → in Tests mit In-Memory-Repo, im Worker mit D1-Repo.
 *
 * Alle Methoden sind READS (Observations). Es gibt keine Actions — der
 * Gatekeeper schreibt nie (Preis-D1 = read-only). "Vertrieb selbst anpassen"
 * passiert über `overrides` je Aufruf, nicht durch Persistenz.
 */

import {
  berechnePreis,
  type PreisAufschluesselung,
  type PreisParameterSatz,
  type ProduktKonfiguration,
} from "./engine/printgemein-preis.ts";
import {
  computeRoi,
  DMS_ROI_CONFIG,
  type DmsRoiConfig,
  type DmsRoiEingabe,
  type DmsRoiErgebnis,
} from "./engine/dms-roi.ts";
import {
  baueParametersatz,
  mergeOverrides,
  wendeOverridesAn,
  type DeepPartial,
  type PreisparameterRow,
} from "./preis-parameter.ts";

/** Nur-Lese-Zugriff auf die Preis-D1. Der Worker liefert die D1-Implementierung. */
export interface PreisRepo {
  /** Aktive Druck-Preisparameter (neueste gueltig_ab je schluessel). */
  ladeDruckparameter(): Promise<PreisparameterRow[]>;
  /** Optional: DMS-ROI-Config aus D1; null → eingebetteter Default-Satz. */
  ladeDmsRoiConfig?(): Promise<DmsRoiConfig | null>;
}

export class PreiserhebungSession {
  #repo: PreisRepo;

  constructor(repo: PreisRepo) {
    this.#repo = repo;
  }

  /** Read: kanonischer Druck-Parametersatz (mit optionalen Vertriebs-Overrides). */
  async getDruckparameter(
    overrides?: DeepPartial<PreisParameterSatz>,
  ): Promise<PreisParameterSatz> {
    const rows = await this.#repo.ladeDruckparameter();
    return wendeOverridesAn(baueParametersatz(rows), overrides);
  }

  /** Read: printgemein-Preis für eine Konfiguration; overrides nur für DIESEN Aufruf. */
  async berechneDruckPreis(
    konfiguration: ProduktKonfiguration,
    overrides?: DeepPartial<PreisParameterSatz>,
  ): Promise<PreisAufschluesselung> {
    const satz = await this.getDruckparameter(overrides);
    return berechnePreis(konfiguration, satz);
  }

  /** Read: DMS-ROI-Config (Koeffizienten + Defaults + Horizonte). */
  async getDmsRoiConfig(
    overrides?: DeepPartial<DmsRoiConfig>,
  ): Promise<DmsRoiConfig> {
    const geladen = (await this.#repo.ladeDmsRoiConfig?.()) ?? DMS_ROI_CONFIG;
    return mergeOverrides(geladen, overrides);
  }

  /** Read: DMS-ROI-Kennzahlen; overrides justieren Koeffizienten/Defaults ad hoc. */
  async berechneDmsRoi(
    eingabe: Partial<DmsRoiEingabe>,
    overrides?: DeepPartial<DmsRoiConfig>,
  ): Promise<DmsRoiErgebnis> {
    const cfg = await this.getDmsRoiConfig(overrides);
    return computeRoi(eingabe, cfg);
  }
}
