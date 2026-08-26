/**
 * Preiserhebungs-Management-UI (VON-1846).
 *
 * Macht den read-only Gatekeeper in der ECHTEN CloudflareOS-Board-Oberflaeche nicht nur
 * *sichtbar* (als gebundener Vendor), sondern *nutzbar*: ueber `providesUi` + `startAppUi`
 * erscheint Preiserhebung als oeffenbare App-Kachel unter `/gatekeepers/<id>`; der Klick darauf
 * rendert diese Seite in einem sandboxed iframe (Parametersatz-/Preis-/ROI-Ansicht).
 *
 * Bewusst OHNE Browser-capnweb-Bundle: `startAppUi` liest die Preis-D1 serverseitig und backt den
 * Snapshot direkt in das iframe-HTML. Der Host (SandboxedGatekeeperApp) rendert das `srcDoc`
 * unabhaengig vom RPC-Handshake, daher genuegt reines HTML/CSS (`default-src 'none'`, kein Skript)
 * fuer einen robusten, headless verifizierbaren Klick-Nachweis. Die `ui`-Capability
 * (PreiserhebungManagementApi) wird zusaetzlich mitgeliefert fuer spaeteren Live-Refresh/What-if.
 *
 * Read-only: keine Actions, keine Schreibzugriffe. Die Quelle bleibt die Preis-D1 (VON-1801);
 * "Vertriebs-Overrides" sind nicht-persistente Per-Call-What-ifs und tauchen im Erst-Render nicht auf.
 */

import { RpcTarget } from "capnweb";
import type { PreiserhebungSession } from "./session";
import type {
  PreisAufschluesselung,
  PreisParameterSatz,
  ProduktKonfiguration,
} from "./engine/printgemein-preis";
import type { DmsRoiConfig, DmsRoiErgebnis } from "./engine/dms-roi";

/**
 * Referenz-Druckkonfiguration fuer den Erst-Render: die kanonische A4/4c-Broschuere
 * (16 Seiten, 500 Exemplare, standard_75, Standardversand) — dieselbe Kalibrierung wie in der
 * printgemein-Preisreferenz (VON-1801).
 */
export const REFERENZ_KONFIGURATION: ProduktKonfiguration = {
  format: "A4",
  farbigkeit: "4c",
  papiersorte: "standard_75",
  seiten: 16,
  auflage: 500,
  versand: "standard",
};

/** Serverseitig gebackene Snapshot-Daten fuer den Erst-Render. */
export interface PreiserhebungAppSnapshot {
  parameter: PreisParameterSatz;
  referenzKonfiguration: ProduktKonfiguration;
  referenzPreis: PreisAufschluesselung;
  roiConfig: DmsRoiConfig;
  roi: DmsRoiErgebnis;
}

/**
 * `ui`-Capability des App-Frames: read-only Delegation an die PreiserhebungSession. Der iframe
 * kann sie (nach Handshake) fuer Live-Refresh / What-if-Overrides nutzen; der Erst-Render kommt
 * aus dem gebackenen Snapshot. Keine Schreib-Methode — die Preis-D1 bleibt read-only.
 */
export class PreiserhebungManagementApi extends RpcTarget {
  #session: PreiserhebungSession;

  constructor(session: PreiserhebungSession) {
    super();
    this.#session = session;
  }

  getDruckparameter(overrides?: Parameters<PreiserhebungSession["getDruckparameter"]>[0]) {
    return this.#session.getDruckparameter(overrides);
  }
  berechneDruckPreis(
    konfiguration: Parameters<PreiserhebungSession["berechneDruckPreis"]>[0],
    overrides?: Parameters<PreiserhebungSession["berechneDruckPreis"]>[1],
  ) {
    return this.#session.berechneDruckPreis(konfiguration, overrides);
  }
  getDmsRoiConfig(overrides?: Parameters<PreiserhebungSession["getDmsRoiConfig"]>[0]) {
    return this.#session.getDmsRoiConfig(overrides);
  }
  berechneDmsRoi(
    eingabe: Parameters<PreiserhebungSession["berechneDmsRoi"]>[0],
    overrides?: Parameters<PreiserhebungSession["berechneDmsRoi"]>[1],
  ) {
    return this.#session.berechneDmsRoi(eingabe, overrides);
  }
}

/** Laedt den vollstaendigen Erst-Render-Snapshot aus der (read-only) Session. */
export async function ladePreiserhebungSnapshot(
  session: PreiserhebungSession,
): Promise<PreiserhebungAppSnapshot> {
  const [parameter, referenzPreis, roiConfig] = await Promise.all([
    session.getDruckparameter(),
    session.berechneDruckPreis(REFERENZ_KONFIGURATION),
    session.getDmsRoiConfig(),
  ]);
  const roi = await session.berechneDmsRoi(roiConfig.defaults);
  return {
    parameter,
    referenzKonfiguration: REFERENZ_KONFIGURATION,
    referenzPreis,
    roiConfig,
    roi,
  };
}

/** Minimales HTML-Escaping fuer in Text-/Attributkontext gebackene Werte. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** EUR-Betrag menschenlesbar (de-DE, zwei Nachkommastellen). */
function eur(n: number): string {
  return `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/** Prozentwert menschenlesbar. */
function pct(n: number): string {
  return `${n.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} %`;
}

/** Ganzzahl menschenlesbar (Tausender-Trennung). */
function int(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

function tableRows(rows: Array<[string, string]>): string {
  return rows
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`)
    .join("");
}

/** Baut die vollstaendige, in sich geschlossene iframe-Seite aus einem Snapshot. */
export function buildPreiserhebungAppHtml(snap: PreiserhebungAppSnapshot): string {
  const { parameter: p, referenzKonfiguration: k, referenzPreis: preis, roiConfig, roi } = snap;

  const parameterRows = tableRows([
    ["Ruestkosten", eur(p.ruestkosten)],
    ["Klickpreis 4c / sw", `${eur(p.klickpreis["4c"])} / ${eur(p.klickpreis.sw)}`],
    ["Weiterverarbeitung", eur(p.weiterverarbeitung)],
    ["Versand Standard / Express", `${eur(p.versandkosten.standard)} / ${eur(p.versandkosten.express)}`],
    ["Margen-Aufschlag", pct(p.margenAufschlag * 100)],
    ["Provisionssatz", pct(p.provisionRate * 100)],
    ["USt.", pct(p.ust * 100)],
  ]);

  const konfigZeile =
    `${esc(k.format)} · ${esc(k.farbigkeit)} · ${esc(k.papiersorte)} · ${esc(k.seiten)} Seiten · ` +
    `${int(k.auflage)} Exemplare · Versand ${esc(k.versand)}`;

  const preisRows = tableRows([
    ["Ruestkosten", eur(preis.ruestkosten)],
    ["Druckkosten", eur(preis.druckkosten)],
    ["Papierkosten", eur(preis.papierkosten)],
    ["Weiterverarbeitung", eur(preis.weiterverarbeitungskosten)],
    ["Versand", eur(preis.versandkosten)],
    ["Druck netto", eur(preis.druckNetto)],
    ["Provision", eur(preis.provision)],
    ["Netto", eur(preis.netto)],
    ["USt.", eur(preis.ust)],
    ["Brutto", `<strong>${eur(preis.brutto)}</strong>`],
  ]);

  const d = roiConfig.defaults;
  const roiRows = tableRows([
    ["Dokumente / Monat", int(d.docsPerMonth)],
    ["Suchzeit vorher", `${int(d.searchMinBefore)} min`],
    ["Bearbeitungszeit vorher", `${int(d.processMinBefore)} min`],
    ["Personalkosten / Std.", eur(d.laborCostPerHour)],
    ["Lizenz einmalig / jaehrlich", `${eur(d.licenseSetupOnce)} / ${eur(d.licenseYearly)}`],
    ["Ersparte Stunden / Jahr", int(roi.hoursSavedPerYear)],
    ["Jaehrliche Ersparnis", eur(roi.annualSavings)],
    ["Netto-Jahresnutzen", `<strong>${eur(roi.netAnnualBenefit)}</strong>`],
    ["Amortisation", roi.paybackMonths == null ? "—" : `${int(roi.paybackMonths)} Monate`],
  ]);

  const horizonRows = (roiConfig.horizonsYears ?? [])
    .map((y) => {
      const h = roi.horizons[y];
      if (!h) return "";
      return `<tr><th scope="row">${esc(y)} Jahre</th><td>Nettogewinn ${eur(h.netGain)} · ROI ${pct(h.roiPct)}</td></tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>Preiserhebung</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1a202c; background: #fff;
  }
  .banner {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 18px; border-radius: 10px;
    background: #faf5ff; border: 1px solid #7B5EA733; margin-bottom: 20px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: #7B5EA7; flex: none; }
  .banner strong { color: #7B5EA7; font-size: 15px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 26px 0 8px; color: #4a5568; text-transform: uppercase; letter-spacing: .04em; }
  .sub { color: #718096; font-size: 12px; margin: 0 0 20px; }
  .konfig { color: #718096; font-size: 12px; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #edf2f7; vertical-align: top; }
  th[scope="row"] { color: #4a5568; font-weight: 600; white-space: nowrap; width: 240px; }
  td { color: #1a202c; }
  footer { margin-top: 26px; color: #a0aec0; font-size: 11px; }
</style>
</head>
<body>
  <h1>Preiserhebung — Druckpreis &amp; DMS-ROI</h1>
  <p class="sub">Read-only · Quelle: Preis-D1 (VON-1801) · Vertriebs-Overrides sind nicht-persistente Per-Call-What-ifs</p>
  <div class="banner">
    <span class="dot"></span>
    <strong>Referenz-Broschuere: ${eur(preis.brutto)} brutto (${eur(preis.netto)} netto)</strong>
  </div>

  <h2>Preisparameter (aktiver Satz)</h2>
  <table><tbody>${parameterRows}</tbody></table>

  <h2>Referenz-Druckpreis</h2>
  <p class="konfig">${konfigZeile}</p>
  <table><tbody>${preisRows}</tbody></table>

  <h2>DMS-ROI (Standardannahmen)</h2>
  <table><tbody>${roiRows}${horizonRows}</tbody></table>

  <footer>CloudflareOS-Gatekeeper · gatekeeper-vonbusch-preiserhebung (K4, VON-1816/VON-1846)</footer>
</body>
</html>`;
}
