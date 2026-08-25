/**
 * Preis-D1 (read-only) → Parametersätze + Vertriebs-Overrides (VON-1801).
 *
 * Die Preis-D1 hält den KANONISCHEN Parametersatz. Dieser Gatekeeper liest ihn
 * ausschließlich lesend (`PREIS_DB` read-only-Binding). Der Vertrieb passt im
 * Gadget nichts an der Quelle an, sondern legt zur Laufzeit `overrides` darüber
 * ("Was-wäre-wenn"). So bleibt die D1 unangetastet und trotzdem justierbar.
 *
 * D1-Schema (printgemein `preisparameter`, Key-Value):
 *   schluessel TEXT, wert REAL, einheit TEXT, gueltig_ab INTEGER, aktiv INTEGER
 *
 * Key-Konvention (schluessel → Feld im PreisParameterSatz):
 *   ruestkosten                       → ruestkosten
 *   klickpreis_4c | klickpreis_sw     → klickpreis[farbigkeit]
 *   papierpreis_<sorte>_<format>      → papierpreis[sorte][format]  (format = letztes Segment)
 *   seitenProBlatt_A4 | _A5           → seitenProBlatt[format]
 *   weiterverarbeitung                → weiterverarbeitung
 *   versandkosten_standard | _express → versandkosten[versandart]
 *   margenAufschlag                   → margenAufschlag
 *   provisionRate                     → provisionRate
 *   ust                               → ust
 */

import {
  PLATZHALTER_PARAMETER,
  type Format,
  type Farbigkeit,
  type PreisParameterSatz,
  type Versandart,
} from "./engine/printgemein-preis";

export interface PreisparameterRow {
  schluessel: string;
  wert: number;
}

/** Tiefes, read-only-sicheres Klonen des Fallback-Satzes (keine Referenzlecks). */
function klonBasis(): PreisParameterSatz {
  const b = PLATZHALTER_PARAMETER;
  const papier: Record<string, Record<Format, number>> = {};
  for (const [sorte, tab] of Object.entries(b.papierpreis)) {
    papier[sorte] = { ...tab };
  }
  return {
    ruestkosten: b.ruestkosten,
    klickpreis: { ...b.klickpreis },
    papierpreis: papier,
    seitenProBlatt: { ...b.seitenProBlatt },
    weiterverarbeitung: b.weiterverarbeitung,
    versandkosten: { ...b.versandkosten },
    margenAufschlag: b.margenAufschlag,
    provisionRate: b.provisionRate,
    ust: b.ust,
  };
}

/**
 * Baut aus den (read-only) D1-Rows einen vollständigen Parametersatz. Fehlende
 * Keys fallen auf PLATZHALTER_PARAMETER zurück (Resilienz gegen Teil-Seeds).
 */
export function baueParametersatz(rows: PreisparameterRow[]): PreisParameterSatz {
  const p = klonBasis();
  for (const { schluessel, wert } of rows) {
    if (typeof wert !== "number" || !isFinite(wert)) continue;
    const teile = schluessel.split("_");
    const kopf = teile[0];

    if (schluessel === "ruestkosten") p.ruestkosten = wert;
    else if (schluessel === "weiterverarbeitung") p.weiterverarbeitung = wert;
    else if (schluessel === "margenAufschlag") p.margenAufschlag = wert;
    else if (schluessel === "provisionRate") p.provisionRate = wert;
    else if (schluessel === "ust") p.ust = wert;
    else if (kopf === "klickpreis" && teile.length === 2) {
      p.klickpreis[teile[1] as Farbigkeit] = wert;
    } else if (kopf === "seitenProBlatt" && teile.length === 2) {
      p.seitenProBlatt[teile[1] as Format] = wert;
    } else if (kopf === "versandkosten" && teile.length === 2) {
      p.versandkosten[teile[1] as Versandart] = wert;
    } else if (kopf === "papierpreis" && teile.length >= 3) {
      // format = letztes Segment; sorte = alles dazwischen (kann "_" enthalten)
      const format = teile[teile.length - 1] as Format;
      const sorte = teile.slice(1, -1).join("_");
      (p.papierpreis[sorte] ??= { A4: 0, A5: 0 })[format] = wert;
    }
    // unbekannte Keys werden bewusst ignoriert (Vorwärtskompatibilität)
  }
  return p;
}

/** Rekursiver Deep-Merge für Overrides — Zahlen/Skalare ersetzen, Objekte mergen. */
export function mergeOverrides<T>(basis: T, patch?: DeepPartial<T>): T {
  if (!patch) return basis;
  return deepMerge(basis, patch);
}

function deepMerge<T>(basis: T, patch: unknown): T {
  // Skalare, null und Arrays ersetzen den Basiswert komplett (kein Index-Merge).
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return (patch === undefined ? basis : (patch as T));
  }
  const out: Record<string, unknown> = { ...(basis as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] =
      cur && typeof cur === "object" && v && typeof v === "object" && !Array.isArray(cur)
        ? deepMerge(cur, v)
        : v;
  }
  return out as T;
}

/**
 * Legt die (nicht-persistenten) Vertriebs-Overrides über den read-only Basis-Satz.
 * Nur die im Patch gesetzten Felder ändern sich; die D1-Quelle bleibt unberührt.
 */
export function wendeOverridesAn(
  basis: PreisParameterSatz,
  overrides?: DeepPartial<PreisParameterSatz>,
): PreisParameterSatz {
  if (!overrides) return basis;
  return deepMerge(basis, overrides);
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
