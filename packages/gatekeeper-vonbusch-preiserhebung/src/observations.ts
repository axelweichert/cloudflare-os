/**
 * Beobachtungs-Kern des Preiserhebungs-Gadgets (VON-1816 / Port von K4 VON-1801).
 *
 * Runtime-agnostisch und ohne `cloudflare:workers`/`capnweb`-Import: die Klasse hängt nur an der
 * `PreiserhebungSession` (read-only Fach-Logik, 1:1 aus VON-1801) und an einem strukturell
 * getippten `ObservationAuthorizer`. Dadurch ist die **Autorisierungs-Semantik** des Ports —
 * jede Read-Op läuft vor der Rückgabe durch `authorizeObservation()` — direkt mit `tsx` testbar,
 * ohne Miniflare/Workerd.
 *
 * Der `RpcTarget`-Shell (`PreiserhebungReadSession` in `gadget.ts`) delegiert 1:1 hierher; er
 * fügt nur die RPC-Fähigkeit und die Freigabe des Authorizers hinzu.
 *
 * Alle vier Operationen sind READS: die Preis-D1 bleibt read-only. Die "Vertriebs-Overrides"
 * (`overrides`) justieren Parameter **nur für den einzelnen Aufruf** und werden nie persistiert —
 * also ebenfalls keine Action, sondern Teil einer nicht-persistenten What-if-Beobachtung.
 */

import type {
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { PreiserhebungSession } from "./session";
import type {
  PreisAufschluesselung,
  PreisParameterSatz,
  ProduktKonfiguration,
} from "./engine/printgemein-preis";
import type { DmsRoiConfig, DmsRoiEingabe, DmsRoiErgebnis } from "./engine/dms-roi";
import type { DeepPartial } from "./preis-parameter";

/**
 * Strukturelles Minimum eines `ObservationAuthorizer`. Der echte Overseer reicht einen
 * `RpcStub<ApprovalQueue>` herein; der Test reicht ein In-Memory-Objekt mit derselben Methode.
 * Beide erfüllen dieses Interface.
 */
export interface ObservationAuthorizerLike
  extends Pick<ObservationAuthorizer, "authorizeObservation"> {}

/** Rundet EUR-Beträge nur für die menschenlesbare ObservationDescription (nicht die Rückgabe). */
function eur(n: number): string {
  return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Die vier read-only Observations des Bausteins, jede vor Rückgabe durch den Authorizer geführt.
 * Reihenfolge bewusst wie im MCP-Baustein (VON-1801): berechnen → authorize → return. Die
 * Autorisierung passiert **nach** dem Lesen, damit die `ObservationDescription` die tatsächlich
 * berechneten Kennzahlen benennen kann (analog `gatekeeper-context`/robomon); da die Operation
 * strikt lesend ist und nichts an den Aufrufer zurückgeht, bevor `authorizeObservation()`
 * aufgelöst hat, ist das für read-only zulässig.
 */
export class PreiserhebungObservations {
  #session: PreiserhebungSession;
  #authorizer: ObservationAuthorizerLike;

  constructor(session: PreiserhebungSession, authorizer: ObservationAuthorizerLike) {
    this.#session = session;
    this.#authorizer = authorizer;
  }

  async #authorize(description: ObservationDescription): Promise<void> {
    await this.#authorizer.authorizeObservation(description);
  }

  /** Read: kanonischer Druck-Parametersatz (mit optionalen, nicht-persistenten Overrides). */
  async getDruckparameter(
    overrides?: DeepPartial<PreisParameterSatz>,
  ): Promise<PreisParameterSatz> {
    const satz = await this.#session.getDruckparameter(overrides);
    await this.#authorize({
      title: "Preiserhebung: Druck-Parametersatz gelesen",
      description:
        `Kanonischen Druck-Parametersatz aus der read-only Preis-D1 gelesen` +
        `${overrides ? " (mit nicht-persistenten Vertriebs-Overrides für diesen Aufruf)" : ""}.\n\n` +
        `- Rüstkosten: ${eur(satz.ruestkosten)} €\n` +
        `- Klickpreis 4c/sw: ${satz.klickpreis["4c"]}/${satz.klickpreis.sw} €\n` +
        `- Margenaufschlag: ${(satz.margenAufschlag * 100).toFixed(1)} % · Provision: ${(satz.provisionRate * 100).toFixed(1)} % · USt: ${(satz.ust * 100).toFixed(1)} %`,
    });
    return satz;
  }

  /** Read: printgemein-Druckpreis für eine Konfiguration; overrides nur für DIESEN Aufruf. */
  async berechneDruckPreis(
    konfiguration: ProduktKonfiguration,
    overrides?: DeepPartial<PreisParameterSatz>,
  ): Promise<PreisAufschluesselung> {
    const preis = await this.#session.berechneDruckPreis(konfiguration, overrides);
    await this.#authorize({
      title: `Preiserhebung: Druckpreis ${eur(preis.brutto)} € brutto`,
      description:
        `Druckpreis berechnet (read-only, Preis-D1 unangetastet` +
        `${overrides ? " + What-if-Overrides" : ""}).\n\n` +
        `- Konfiguration: ${konfiguration.format}/${konfiguration.farbigkeit}/${konfiguration.seiten}S/` +
        `${konfiguration.auflage} Ex./${konfiguration.papiersorte}/${konfiguration.versand}\n` +
        `- Netto: ${eur(preis.netto)} € · USt: ${eur(preis.ust)} € · **Brutto: ${eur(preis.brutto)} €**\n` +
        `- Provision: ${eur(preis.provision)} €`,
    });
    return preis;
  }

  /** Read: DMS-ROI-Config (Koeffizienten + Defaults + Horizonte). */
  async getDmsRoiConfig(overrides?: DeepPartial<DmsRoiConfig>): Promise<DmsRoiConfig> {
    const cfg = await this.#session.getDmsRoiConfig(overrides);
    await this.#authorize({
      title: "Preiserhebung: DMS-ROI-Config gelesen",
      description:
        `DMS-ROI-Parametersatz (Koeffizienten/Defaults/Horizonte) gelesen` +
        `${overrides ? " (mit nicht-persistenten Overrides)" : ""}.\n\n` +
        `- Horizonte: ${cfg.horizonsYears.join(", ")} Jahre\n` +
        `- Such-/Prozess-Reduktion: ${(cfg.coeff.searchTimeReductionPct * 100).toFixed(0)} % / ${(cfg.coeff.processTimeReductionPct * 100).toFixed(0)} %`,
    });
    return cfg;
  }

  /** Read: DMS-ROI-Kennzahlen; overrides justieren Koeffizienten/Defaults ad hoc. */
  async berechneDmsRoi(
    eingabe: Partial<DmsRoiEingabe>,
    overrides?: DeepPartial<DmsRoiConfig>,
  ): Promise<DmsRoiErgebnis> {
    const roi = await this.#session.berechneDmsRoi(eingabe, overrides);
    const payback =
      roi.paybackMonths == null ? "kein Payback" : `${roi.paybackMonths.toFixed(1)} Mon.`;
    await this.#authorize({
      title: `Preiserhebung: DMS-ROI ${eur(roi.annualSavings)} €/Jahr`,
      description:
        `DMS-ROI berechnet (read-only, reiner Rechenkern` +
        `${overrides ? " + What-if-Overrides" : ""}).\n\n` +
        `- Belege/Jahr: ${roi.docsPerYear} · Zeitersparnis: ${roi.hoursSavedPerYear.toFixed(0)} h/Jahr\n` +
        `- Jährliche Ersparnis: **${eur(roi.annualSavings)} €** · Netto-Jahresnutzen: ${eur(roi.netAnnualBenefit)} €\n` +
        `- Amortisation: ${payback}`,
    });
    return roi;
  }
}
